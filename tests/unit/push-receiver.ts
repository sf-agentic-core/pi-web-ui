/**
 * Web Push test helpers — the *receiver* half of RFC 8291.
 *
 * The unit tests need to look inside what the sender produced, and the only
 * honest way to do that is with a user agent that follows the RFC rather than
 * by comparing against our own sender's internals: it takes the message apart
 * with nothing but the public information a browser would hold (its own private
 * key, the authentication secret, and what the header carries) and returns the
 * plaintext.
 *
 * The mapping to the standard is one-directional and already anchored: the
 * §5 worked example is reproduced byte for byte in push-ece.test.ts, and the
 * receiving direction was cross-checked against `http_ece` (see PR #51).
 *
 * Not a `.test.ts` file on purpose — vitest only collects `*.test.ts`, so this
 * is shared by the push tests without being run as a suite of its own.
 */

import { createDecipheriv, createECDH, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import type { PushKeyPair } from "../../server/push/ece.js";
import type { PushSubscriptionRecord } from "../../server/push/store.js";

export interface FakeUserAgent {
	/** 65-byte uncompressed public key, as a browser sends in `keys.p256dh`. */
	rawPublicKey: Buffer;
	/** ECDH object with the private scalar (what `http_ece` wants too). */
	ecdh: ReturnType<typeof createECDH>;
	authSecret: Buffer;
	/** base64url form, ready for a subscription record. */
	p256dh: string;
	auth: string;
}

/** A subscription as a browser creates it: fresh keys, per device. */
export function makeUserAgent(): FakeUserAgent {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const pub = publicKey.export({ format: "jwk" });
	const priv = privateKey.export({ format: "jwk" });
	const rawPublicKey = Buffer.concat([
		Buffer.from([0x04]),
		Buffer.from(pub.x ?? "", "base64url"),
		Buffer.from(pub.y ?? "", "base64url"),
	]);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(Buffer.from(priv.d ?? "", "base64url"));
	const authSecret = randomBytes(16);
	return {
		rawPublicKey,
		ecdh,
		authSecret,
		p256dh: rawPublicKey.toString("base64url"),
		auth: authSecret.toString("base64url"),
	};
}

/** A server-side key pair (the VAPID pair, which also carries the `keyid`). */
export function makeServerKeyPair(): PushKeyPair {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const pub = publicKey.export({ format: "jwk" });
	const priv = privateKey.export({ format: "jwk" });
	return {
		privateKey: Buffer.from(priv.d ?? "", "base64url"),
		publicKey: Buffer.concat([
			Buffer.from([0x04]),
			Buffer.from(pub.x ?? "", "base64url"),
			Buffer.from(pub.y ?? "", "base64url"),
		]),
	};
}

export function makeSubscription(
	ua: FakeUserAgent,
	patch: Partial<PushSubscriptionRecord> = {},
): PushSubscriptionRecord {
	return {
		endpoint: "https://fcm.googleapis.com/wp/test-endpoint",
		p256dh: ua.p256dh,
		auth: ua.auth,
		clientId: "client-1",
		label: "Chrome/142",
		createdAt: 1_700_000_000_000,
		...patch,
	};
}

const hkdfExtract = (salt: Buffer, ikm: Buffer): Buffer => createHmac("sha256", salt).update(ikm).digest();
const hkdfExpand = (prk: Buffer, info: Buffer, length: number): Buffer =>
	createHmac("sha256", prk)
		.update(Buffer.concat([info, Buffer.from([0x01])]))
		.digest()
		.subarray(0, length);

/**
 * Open a push message the way a browser does: parse the RFC 8188 header, redo
 * the shared secret from the other side, and decrypt. Throws when the message
 * is malformed or was not meant for this user agent — which is exactly what a
 * browser would do (and what makes the assertions meaningful).
 */
export function decryptPush(body: Buffer, ua: FakeUserAgent): Buffer {
	const salt = body.subarray(0, 16);
	const keyIdLength = body.readUInt8(20);
	const senderPublicKey = body.subarray(21, 21 + keyIdLength);
	const ciphertext = body.subarray(21 + keyIdLength);
	if (keyIdLength !== 65) throw new Error(`unexpected keyid length: ${keyIdLength}`);
	if (ciphertext.length < 17) throw new Error("ciphertext too short");

	const ecdhSecret = ua.ecdh.computeSecret(senderPublicKey);
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), ua.rawPublicKey, senderPublicKey]);
	const ikm = hkdfExpand(hkdfExtract(ua.authSecret, ecdhSecret), keyInfo, 32);
	const prk = hkdfExtract(salt, ikm);
	const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
	const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);

	const tag = ciphertext.subarray(ciphertext.length - 16);
	const payload = ciphertext.subarray(0, ciphertext.length - 16);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(tag);
	const record = Buffer.concat([decipher.update(payload), decipher.final()]);
	// RFC 8291 §4: the last plaintext octet is the padding delimiter.
	if (record[record.length - 1] !== 0x02) throw new Error("missing padding delimiter");
	return record.subarray(0, record.length - 1);
}

/** The JSON a service worker would `JSON.parse` out of a push message. */
export function readPushPayload(body: Buffer, ua: FakeUserAgent): { title: string; body?: string } {
	return JSON.parse(decryptPush(body, ua).toString("utf8")) as { title: string; body?: string };
}

/**
 * A `fetch` stub that records every request and answers with a scripted status.
 * Returns the recorded calls so a test can assert the request shape (headers,
 * method, timeout-bearing options) rather than only the outcome.
 */
export interface RecordedCall {
	url: string;
	init: RequestInit;
}

/** Headers of a recorded request; throws when the request never happened. */
export function requestHeaders(calls: RecordedCall[], index = 0): Record<string, string> {
	const headers = calls[index]?.init.headers;
	if (!headers) throw new Error(`no request recorded at index ${index}`);
	return headers as Record<string, string>;
}

/** Body of a recorded request, as bytes we can decrypt.
 *
 * Accepts any Uint8Array rather than asserting `Buffer.isBuffer`: the sender
 * hands `fetch` a plain Uint8Array on purpose (a Node Buffer does not satisfy
 * BodyInit under TypeScript 5.9's generic ArrayBufferView), and asserting the
 * concrete class here would only re-check an implementation detail. */
export function requestBody(calls: RecordedCall[], index = 0): Buffer {
	const body = calls[index]?.init.body;
	if (!(body instanceof Uint8Array)) throw new Error(`no byte body at index ${index}`);
	return Buffer.from(body);
}

export function recordingFetch(statuses: number[] = [201]): {
	calls: RecordedCall[];
	fetchImpl: typeof fetch;
} {
	const calls: RecordedCall[] = [];
	const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.push({ url: String(url), init: init ?? {} });
		const status = statuses[Math.min(calls.length - 1, statuses.length - 1)] ?? 201;
		return new Response(null, { status });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}
