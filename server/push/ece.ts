/**
 * Web Push message encryption (RFC 8291, "aes128gcm") and VAPID authorization
 * (RFC 8292) — built directly on `node:crypto`, with no dependencies.
 *
 * Why in-tree instead of a library
 * --------------------------------
 * The obvious candidate, `web-push`, has not been published in years and drags
 * in six transitive packages; the WebCrypto-native alternatives have very
 * small adoption, which is a supply-chain risk we would be taking on for ~70
 * lines of arithmetic. And the arithmetic is not a matter of opinion: RFC 8291
 * ships a worked example (§5) with every intermediate value, and
 * `tests/unit/push-ece.test.ts` asserts our output against it **byte for
 * byte** — salt, key schedule, ciphertext and the 86-octet header. If anyone
 * touches the derivation, that test fails.
 *
 * What this module is NOT
 * -----------------------
 * It only *encrypts and signs*. Transport, retries, subscription storage and
 * the decision of when to send live in the caller (sender.ts / announce.ts).
 * Every function here is synchronous and pure apart from the random salt.
 *
 * The application server key pair does double duty, as the spec intends: its
 * public half is the VAPID `k` parameter *and* the RFC 8291 `keyid` of every
 * message, which is why the same `PushKeyPair` is passed to both functions.
 */

import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";

/** Uncompressed P-256 point: 0x04 || X(32) || Y(32). */
export const P256_PUBLIC_KEY_BYTES = 65;
/** Raw P-256 scalar. */
export const P256_PRIVATE_KEY_BYTES = 32;
/** RFC 8291 §3.2: the user agent's authentication secret is 16 octets. */
export const AUTH_SECRET_BYTES = 16;

/**
 * RFC 8291 §4 caps a push body at 4096 octets; minus the 86-octet header, the
 * single-octet padding delimiter and the 16-octet GCM tag, that leaves 3993 for
 * the plaintext. Anything longer is rejected here rather than being truncated
 * silently by a push service.
 */
export const PUSH_RECORD_SIZE = 4096;
export const PUSH_MAX_PLAINTEXT_BYTES = 3993;

/** RFC 8292 §2: push services reject a JWT whose lifetime exceeds 24 hours. */
export const VAPID_DEFAULT_TTL_SECONDS = 12 * 60 * 60;

export interface PushKeyPair {
	/** Raw 32-byte P-256 scalar. Never log this. */
	privateKey: Buffer;
	/** Uncompressed public point, 65 bytes. */
	publicKey: Buffer;
}

/** RFC 8188 header field: 4-byte big-endian record size. */
function recordSizeField(): Buffer {
	const rs = Buffer.alloc(4);
	rs.writeUInt32BE(PUSH_RECORD_SIZE, 0);
	return rs;
}

const CRV = "prime256v1";

/** HKDF-Extract per RFC 5869: HMAC with the salt as key. */
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
	return createHmac("sha256", salt).update(ikm).digest();
}

/** HKDF-Expand for a single output block (all our lengths are ≤ 32 octets). */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
	return createHmac("sha256", prk)
		.update(Buffer.concat([info, Buffer.from([0x01])]))
		.digest()
		.subarray(0, length);
}

/**
 * Derive the raw public point of a P-256 private scalar.
 *
 * Used to validate a key pair loaded from disk: a stored pair whose halves do
 * not match would silently break every push (the client cannot decrypt what a
 * different key encrypted), and that failure is indistinguishable from a
 * delivery problem when it happens in production.
 */
export function derivePublicKey(privateKey: Buffer): Buffer {
	const ecdh = createECDH(CRV);
	ecdh.setPrivateKey(privateKey);
	return ecdh.getPublicKey();
}

/** Does this P-256 key pair actually belong together? */
export function isConsistentKeyPair(keyPair: PushKeyPair): boolean {
	if (keyPair.privateKey.length !== P256_PRIVATE_KEY_BYTES) return false;
	if (keyPair.publicKey.length !== P256_PUBLIC_KEY_BYTES || keyPair.publicKey[0] !== 0x04) return false;
	try {
		return derivePublicKey(keyPair.privateKey).equals(keyPair.publicKey);
	} catch {
		return false;
	}
}

export interface EncryptPushMessageOptions {
	/** Message body — JSON in practice. Must fit PUSH_MAX_PLAINTEXT_BYTES. */
	plaintext: Buffer;
	/** The subscription's user-agent public key (65 bytes, uncompressed). */
	uaPublicKey: Buffer;
	/** The subscription's 16-byte authentication secret. */
	authSecret: Buffer;
	/** Application server key pair; its public half lands in the `keyid`. */
	keyPair: PushKeyPair;
	/** 16-byte salt. Random per message unless injected (tests). */
	salt?: Buffer;
}

/**
 * Produce the complete `aes128gcm` body for one push message: the RFC 8188
 * header (salt || rs || keyid) followed by the encrypted single record.
 *
 * The plaintext gets the mandatory 0x02 padding delimiter appended (RFC 8291
 * §4) and is encrypted with AES-128-GCM using an empty AAD — the byte-for-byte
 * RFC vector is what pins that down.
 */
export function encryptPushMessage(options: EncryptPushMessageOptions): Buffer {
	const { plaintext, uaPublicKey, authSecret, keyPair } = options;
	if (plaintext.length > PUSH_MAX_PLAINTEXT_BYTES) {
		throw new Error(`push payload too large: ${plaintext.length} > ${PUSH_MAX_PLAINTEXT_BYTES}`);
	}
	if (uaPublicKey.length !== P256_PUBLIC_KEY_BYTES || uaPublicKey[0] !== 0x04) {
		throw new Error("invalid user agent public key");
	}
	if (authSecret.length !== AUTH_SECRET_BYTES) throw new Error("invalid auth secret");
	if (!isConsistentKeyPair(keyPair)) throw new Error("inconsistent application server key pair");

	const salt = options.salt ?? randomBytes(16);
	if (salt.length !== 16) throw new Error("invalid salt");

	// RFC 8291 §3.1 — note the public key is validated by node's ECDH, which
	// refuses points that are not on the curve (the check RFC 8291 §7 demands).
	const ecdh = createECDH(CRV);
	ecdh.setPrivateKey(keyPair.privateKey);
	const ecdhSecret = ecdh.computeSecret(uaPublicKey);

	// RFC 8291 §3.3: IKM = HKDF(salt=auth_secret, IKM=ecdh_secret,
	//                            info="WebPush: info" || 0x00 || ua || as)
	const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublicKey, keyPair.publicKey]);
	const ikm = hkdfExpand(hkdfExtract(authSecret, ecdhSecret), keyInfo, 32);

	// RFC 8188 §2.2: CEK and NONCE come from the same PRK, different info.
	const prk = hkdfExtract(salt, ikm);
	const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "latin1"), 16);
	const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "latin1"), 12);

	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
	const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

	const header = Buffer.concat([salt, recordSizeField(), Buffer.from([P256_PUBLIC_KEY_BYTES]), keyPair.publicKey]);
	return Buffer.concat([header, ciphertext]);
}

/** The JWT audience (RFC 8292 §2) must be the push endpoint's origin. */
export function vapidAudience(endpoint: string): string {
	return new URL(endpoint).origin;
}

export interface VapidAuthorizationOptions {
	/**
	 * Contact URI for the JWT `sub` claim (RFC 8292 §2.1). Push services may use
	 * it to reach the operator; nothing in this project derives it from the
	 * host, because that would leak the hostname to a third party.
	 */
	subject: string;
	ttlSeconds?: number;
	/** Injected clock (seconds), for tests. */
	nowSeconds?: number;
}

/**
 * Build the `Authorization: vapid t=<jwt>, k=<key>` header value.
 *
 * The signature is ES256 over the base64url header.payload, emitted as the
 * raw 64-byte R||S form JWS requires — `dsaEncoding: "ieee-p1363"` gives us
 * that directly, so there is no DER parser to get wrong.
 */
export function buildVapidAuthorization(
	endpoint: string,
	keyPair: PushKeyPair,
	options: VapidAuthorizationOptions,
): string {
	const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
	const ttl = options.ttlSeconds ?? VAPID_DEFAULT_TTL_SECONDS;
	if (ttl <= 0 || ttl > 24 * 60 * 60) throw new Error(`invalid VAPID ttl: ${ttl}`);

	const signingInput = Buffer.from(
		`${base64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }))}.${base64Url(
			JSON.stringify({ aud: vapidAudience(endpoint), exp: now + ttl, sub: options.subject }),
		)}`,
		"utf8",
	);

	const key = createPrivateKey({
		key: {
			kty: "EC",
			crv: "P-256",
			d: keyPair.privateKey.toString("base64url"),
			x: keyPair.publicKey.subarray(1, 33).toString("base64url"),
			y: keyPair.publicKey.subarray(33, 65).toString("base64url"),
		},
		format: "jwk",
	});
	const signature = sign("sha256", signingInput, { key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${signingInput.toString("utf8")}.${signature.toString("base64url")}, k=${keyPair.publicKey.toString("base64url")}`;
}

function base64Url(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}
