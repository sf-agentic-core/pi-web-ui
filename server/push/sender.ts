/**
 * Web Push transport — the HTTP half of RFC 8030: turn a `PushMessage` into a
 * signed, encrypted POST to a push service, and classify what came back.
 *
 * Kept separate from the encryption (ece.ts) and from the decision of *when* to
 * send (announce.ts) so both halves stay testable on their own: the tests inject
 * a `fetchImpl`, so the whole request (headers, body, timeout, outcome
 * classification) is exercised without a network or a push service.
 *
 * Two things here are security-relevant rather than cosmetic:
 *
 *   - `redirect: "error"`. The endpoint is a URL a client handed us; following a
 *     redirect would let it point our POST at anything (SSRF). Subscriptions are
 *     validated on the way in (store.ts), and this closes the door on bouncing.
 *   - nothing but the notification text is ever put in the payload. No token, no
 *     path, no hostname: this leaves the machine and lands on a third-party push
 *     service.
 */

import { buildVapidAuthorization, encryptPushMessage, PUSH_MAX_PLAINTEXT_BYTES, type PushKeyPair } from "./ece.js";
import {
	decidePushOutcome,
	recordPushResult,
	removePushSubscription,
	type PushOutcome,
	type PushSubscriptionRecord,
} from "./store.js";
import type { VapidOptions } from "./vapid.js";

/** What the service worker renders. Deliberately tiny — see the header. */
export interface PushMessage {
	title: string;
	body?: string;
}

/**
 * How long a push service may hold the message if the device is offline.
 *
 * This notification is about a moment ("the service just came back"), so a long
 * TTL would deliver a stale claim hours later. Four hours is the compromise: a
 * phone that is asleep still learns about it, a device that appears next week
 * does not.
 */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

/** A push service that has not answered in this long is not going to. */
export const PUSH_TIMEOUT_MS = 10_000;

/** Concurrent sends; kept low because there are rarely many devices and the
 *  push services punish bursts. */
export const PUSH_CONCURRENCY = 8;

export interface PushTransportOptions extends VapidOptions {
	keyPair: PushKeyPair;
	/** JWT `sub` claim (RFC 8292) — see vapid.ts. */
	subject: string;
	ttlSeconds?: number;
	timeoutMs?: number;
	/** Injectable transport, for tests. */
	fetchImpl?: typeof fetch;
}

export interface PushSendResult {
	ok: boolean;
	/** HTTP status, absent on a transport failure. */
	status?: number;
	outcome: PushOutcome;
	error?: string;
}

export interface PushAttempt {
	record: PushSubscriptionRecord;
	result: PushSendResult;
}

function describeError(err: unknown): string {
	if (err instanceof Error) return `${err.name}: ${err.message}`;
	return String(err);
}

/**
 * Serialise the notification, shrinking it until it fits a single record.
 *
 * RFC 8291 §4 leaves 3993 octets of plaintext per push. A payload that exceeds
 * it is not delivered with an error we could see — the push service just
 * refuses — so the guard is here. Priority: the title survives (it is the
 * notification), then as much body as fits, and a too-long title is a caller
 * bug worth throwing on.
 */
export function encodePushPayload(message: PushMessage): Buffer {
	const encode = (m: PushMessage): Buffer => Buffer.from(JSON.stringify(m), "utf8");
	const fits = (m: PushMessage): boolean => encode(m).length <= PUSH_MAX_PLAINTEXT_BYTES;

	if (fits(message)) return encode(message);
	if (!fits({ title: message.title })) {
		throw new Error(`push title does not fit in one record: ${message.title.length} chars`);
	}
	let body = message.body ?? "";
	while (body.length > 0) {
		body = body.slice(0, Math.floor(body.length / 2));
		if (fits({ title: message.title, body })) break;
	}
	return encode({ title: message.title, ...(body ? { body } : {}) });
}

/** Send one message to one subscription. Never throws: failures are results. */
export async function sendPush(
	record: PushSubscriptionRecord,
	message: PushMessage,
	options: PushTransportOptions,
): Promise<PushSendResult> {
	const doFetch = options.fetchImpl ?? fetch;
	const ttl = options.ttlSeconds ?? PUSH_TTL_SECONDS;
	let body: Buffer;
	try {
		body = encryptPushMessage({
			plaintext: encodePushPayload(message),
			uaPublicKey: Buffer.from(record.p256dh, "base64url"),
			authSecret: Buffer.from(record.auth, "base64url"),
			keyPair: options.keyPair,
		});
	} catch (err) {
		// A subscription whose keys no longer make sense can never be delivered
		// to, so it is pruned rather than retried forever.
		return { ok: false, outcome: "prune", error: describeError(err) };
	}
	try {
		const response = await doFetch(record.endpoint, {
			method: "POST",
			headers: {
				Authorization: buildVapidAuthorization(record.endpoint, options.keyPair, {
					subject: options.subject,
					ttlSeconds: ttl,
				}),
				"Content-Encoding": "aes128gcm",
				"Content-Type": "application/octet-stream",
				// RFC 8030 §5.2 requires TTL; without it most services reject the POST.
				TTL: String(ttl),
			},
			// A plain Uint8Array, not the Buffer: Node's Buffer is a
			// `Uint8Array<ArrayBufferLike>` and TypeScript 5.9's generic
			// ArrayBufferView does not accept it as a BodyInit, while a freshly
			// constructed Uint8Array is backed by a concrete ArrayBuffer. The copy
			// is a few kilobytes at most (a push record is capped at 4096 octets).
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
			// A push endpoint must never be able to redirect us elsewhere.
			redirect: "error",
		});
		const outcome = decidePushOutcome(response.status);
		return {
			ok: outcome === "ok",
			status: response.status,
			outcome,
			...(outcome === "ok" ? {} : { error: `HTTP ${response.status}` }),
		};
	} catch (err) {
		// Timeout / DNS / connection reset — transient by definition, so the
		// subscription stays and a later announcement can use it.
		return { ok: false, outcome: "retry", error: describeError(err) };
	}
}

/** Send the same message to several subscriptions, in bounded batches. */
export async function sendPushToAll(
	records: PushSubscriptionRecord[],
	message: PushMessage,
	options: PushTransportOptions,
): Promise<PushAttempt[]> {
	const attempts: PushAttempt[] = [];
	for (let i = 0; i < records.length; i += PUSH_CONCURRENCY) {
		const batch = records.slice(i, i + PUSH_CONCURRENCY);
		const results = await Promise.all(batch.map((record) => sendPush(record, message, options)));
		batch.forEach((record, index) => {
			const result = results[index];
			if (result) attempts.push({ record, result });
		});
	}
	return attempts;
}

export interface ApplyPushResultsSummary {
	sent: number;
	failed: number;
	pruned: number;
}

/**
 * Fold send outcomes back into the store: prune the subscriptions the push
 * service declared gone (404/410) and keep the rest, with their last result for
 * the diagnostics panel.
 */
export function applyPushResults(
	dataDir: string,
	attempts: PushAttempt[],
	options: VapidOptions = {},
): ApplyPushResultsSummary {
	const summary: ApplyPushResultsSummary = { sent: 0, failed: 0, pruned: 0 };
	for (const { record, result } of attempts) {
		if (result.outcome === "prune") {
			removePushSubscription(dataDir, record.endpoint, options);
			summary.pruned += 1;
			continue;
		}
		recordPushResult(dataDir, record.endpoint, { ok: result.ok, error: result.error }, options);
		if (result.ok) summary.sent += 1;
		else summary.failed += 1;
	}
	return summary;
}
