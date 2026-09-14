/**
 * Push subscription store — `<dataDir>/push-subscriptions.json`.
 *
 * Same contract as `client-state.ts`: the file is the only state, reads and
 * writes are synchronous and best-effort, and no I/O failure here may ever
 * propagate into the request path or block the server. A subscription we could
 * not persist simply does not survive a restart.
 *
 * What lives in a subscription, and why it is treated as a secret: the
 * endpoint is a *capability URL* — anyone holding it can push to that device —
 * and the p256dh/auth pair decrypts those messages. The store never hands
 * endpoints back to the UI (diagnostics report counts and labels only) and the
 * file is created 0600.
 *
 * SSRF: the endpoint is attacker-influenced input that the server later POSTs
 * to, so `isAllowedPushEndpoint` refuses anything that is not a public HTTPS
 * multi-label hostname. A strict allowlist of the four big push services would
 * be stronger, but it would also break self-hosted push gateways (ntfy,
 * Nextcloud, Matrix), and the entries here are only reachable by someone who
 * already holds PI_WEB_TOKEN.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isIP } from "node:net";
import { loadOrCreateVapidKeys, type VapidOptions } from "./vapid.js";

export const SUBSCRIPTIONS_FILE = "push-subscriptions.json";
/** Bumped only if the on-disk shape changes incompatibly. */
export const SUBSCRIPTIONS_SCHEMA = 1;
/** Bounded so a compromised client cannot grow the file without limit. */
export const MAX_SUBSCRIPTIONS = 64;
export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_USER_AGENT_LENGTH = 120;

export interface PushSubscriptionRecord {
	/** Push service URL (capability URL — never returned to clients). */
	endpoint: string;
	/** base64url, 65-byte uncompressed P-256 point. */
	p256dh: string;
	/** base64url, 16-byte authentication secret. */
	auth: string;
	/** The browser/device identity pi-web-ui already uses for per-client state. */
	clientId: string;
	/** Human-readable device hint for diagnostics (sanitized UA). */
	label: string;
	createdAt: number;
	lastOkAt?: number;
	/** Last failure, shortened — shown in diagnostics, never an endpoint. */
	lastError?: string;
	lastAttemptAt?: number;
}

interface PushStoreFile {
	version?: number;
	/** VAPID public key the entries below were created with (base64url). */
	vapidPublicKey?: string;
	subscriptions?: PushSubscriptionRecord[];
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

function decodeKey(raw: unknown, expectedBytes: number): string | null {
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "" || trimmed.length > 512) return null;
	// Reject anything that is not base64url before trusting its length: Buffer's
	// decoder silently skips invalid characters, so "AAAA!!!" would otherwise
	// decode to three bytes and look plausible.
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) return null;
	const buf = Buffer.from(trimmed, "base64url");
	if (buf.length !== expectedBytes) return null;
	if (expectedBytes === 65 && buf[0] !== 0x04) return null;
	return trimmed;
}

/** Hostnames that can never be a public push service. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".localdomain", ".internal", ".home.arpa", ".invalid", ".test"];

/**
 * May the server POST to this endpoint?
 *
 * Pure and deliberately conservative: HTTPS only, no credentials in the URL, no
 * IP literals (which covers both loopback/private ranges and cloud metadata
 * addresses such as 169.254.169.254), no single-label hostname, and no reserved
 * internal TLD. Returns false rather than throwing on unparseable input.
 */
export function isAllowedPushEndpoint(endpoint: unknown): boolean {
	if (typeof endpoint !== "string") return false;
	if (endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.protocol !== "https:") return false;
	if (url.username !== "" || url.password !== "") return false;
	const host = url.hostname.toLowerCase();
	if (host === "") return false;
	if (isIP(host) !== 0) return false;
	if (!host.includes(".")) return false;
	if (host === "localhost") return false;
	if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
	return true;
}

/** Collapse a user agent into a short single-line label (diagnostics only). */
export function sanitizeUserAgent(userAgent: unknown): string {
	if (typeof userAgent !== "string") return "";
	// eslint-disable-next-line no-control-regex
	const cleaned = userAgent
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.slice(0, MAX_USER_AGENT_LENGTH);
}

export interface NormalizeContext {
	clientId: unknown;
	userAgent?: unknown;
	/** Injected clock (ms). */
	now?: number;
}

/**
 * Validate untrusted input into a storable record, or null when it is not one.
 * Everything the sender later relies on is checked here: a malformed key would
 * otherwise blow up at send time, far from the request that introduced it.
 */
export function normalizePushSubscription(raw: unknown, context: NormalizeContext): PushSubscriptionRecord | null {
	if (typeof raw !== "object" || raw === null) return null;
	const candidate = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
	if (!isAllowedPushEndpoint(candidate.endpoint)) return null;
	const p256dh = decodeKey(candidate.keys?.p256dh, 65);
	const auth = decodeKey(candidate.keys?.auth, 16);
	if (!p256dh || !auth) return null;
	const clientId = typeof context.clientId === "string" ? context.clientId.trim().slice(0, 128) : "";
	if (clientId === "") return null;
	return {
		endpoint: candidate.endpoint as string,
		p256dh,
		auth,
		clientId,
		label: sanitizeUserAgent(context.userAgent),
		createdAt: context.now ?? Date.now(),
	};
}

export type PushOutcome = "ok" | "prune" | "retry" | "error";

/**
 * Classify a push service response.
 *
 * Only 404 and 410 mean "this subscription is gone for good" (RFC 8030 §5.5:
 * the endpoint no longer exists), and they are the only cases that delete
 * anything. 429 and 5xx are transient and keep the entry. A 403 is *not*
 * treated as prune: in practice it means our VAPID credentials do not match the
 * subscription, and deleting on that would silently discard subscriptions every
 * time an operator rotates the key via environment variables.
 */
export function decidePushOutcome(status: number): PushOutcome {
	if (status >= 200 && status < 300) return "ok";
	if (status === 404 || status === 410) return "prune";
	if (status === 429 || status >= 500) return "retry";
	return "error";
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

function storePath(dataDir: string): string {
	return join(dataDir, SUBSCRIPTIONS_FILE);
}

function currentVapidKey(dataDir: string, options: VapidOptions): string {
	return loadOrCreateVapidKeys(dataDir, options).keyPair.publicKey.toString("base64url");
}

/**
 * Read the store, discarding entries made with a different VAPID key.
 *
 * A browser binds its subscription to the `applicationServerKey` it subscribed
 * with, so entries from another key can only ever fail. Dropping them turns a
 * permanent silent failure into a clean re-subscribe on the client's next visit.
 */
function readStore(dataDir: string, options: VapidOptions): PushStoreFile {
	const vapidPublicKey = currentVapidKey(dataDir, options);
	let parsed: PushStoreFile;
	try {
		parsed = JSON.parse(readFileSync(storePath(dataDir), "utf8")) as PushStoreFile;
	} catch {
		return { version: SUBSCRIPTIONS_SCHEMA, vapidPublicKey, subscriptions: [] };
	}
	const subscriptions = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
	if (parsed.vapidPublicKey !== undefined && parsed.vapidPublicKey !== vapidPublicKey) {
		(options.warn ?? ((): void => {}))("VAPID key changed — dropping stored push subscriptions");
		return { version: SUBSCRIPTIONS_SCHEMA, vapidPublicKey, subscriptions: [] };
	}
	return { version: SUBSCRIPTIONS_SCHEMA, vapidPublicKey, subscriptions };
}

function writeStore(dataDir: string, store: PushStoreFile, options: VapidOptions): boolean {
	const path = storePath(dataDir);
	const warn = options.warn ?? ((): void => {});
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ ...store, version: SUBSCRIPTIONS_SCHEMA }, null, "\t")}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, path);
		return true;
	} catch (err) {
		warn(`could not persist ${SUBSCRIPTIONS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

/** Every stored subscription (empty when absent, corrupt, or key-rotated). */
export function listPushSubscriptions(dataDir: string, options: VapidOptions = {}): PushSubscriptionRecord[] {
	return readStore(dataDir, options).subscriptions ?? [];
}

/**
 * Insert or refresh a subscription, keyed by endpoint (the browser reuses the
 * same endpoint when it re-subscribes, so this is the natural identity).
 *
 * Also removes any *other* endpoint belonging to the same client: a browser
 * that had to create a new subscription would otherwise leave a dead entry
 * behind, and dead entries are invisible until a send fails.
 */
export function replacePushSubscription(
	dataDir: string,
	record: PushSubscriptionRecord,
	options: VapidOptions = {},
): PushSubscriptionRecord[] {
	const store = readStore(dataDir, options);
	const existing = (store.subscriptions ?? []).filter(
		(s) => s.endpoint !== record.endpoint && s.clientId !== record.clientId,
	);
	const previous = (store.subscriptions ?? []).find((s) => s.endpoint === record.endpoint);
	const next = [...existing, { ...record, createdAt: previous?.createdAt ?? record.createdAt }];
	// Oldest first out — bounded, and a device that stopped showing up ages ago
	// is the least likely to still be listening.
	next.sort((a, b) => a.createdAt - b.createdAt);
	const trimmed = next.slice(Math.max(0, next.length - MAX_SUBSCRIPTIONS));
	const ok = writeStore(
		dataDir,
		{ version: SUBSCRIPTIONS_SCHEMA, vapidPublicKey: store.vapidPublicKey, subscriptions: trimmed },
		options,
	);
	return ok ? trimmed : (store.subscriptions ?? []);
}

/** Drop one subscription by endpoint. Returns the remaining records. */
export function removePushSubscription(
	dataDir: string,
	endpoint: string,
	options: VapidOptions = {},
): PushSubscriptionRecord[] {
	const store = readStore(dataDir, options);
	const next = (store.subscriptions ?? []).filter((s) => s.endpoint !== endpoint);
	writeStore(
		dataDir,
		{ version: SUBSCRIPTIONS_SCHEMA, vapidPublicKey: store.vapidPublicKey, subscriptions: next },
		options,
	);
	return next;
}

/** Record the outcome of a send attempt (keeps lastOkAt/lastError fresh). */
export function recordPushResult(
	dataDir: string,
	endpoint: string,
	result: { ok: boolean; error?: string; now?: number },
	options: VapidOptions = {},
): void {
	const store = readStore(dataDir, options);
	const now = result.now ?? Date.now();
	let touched = false;
	for (const sub of store.subscriptions ?? []) {
		if (sub.endpoint !== endpoint) continue;
		sub.lastAttemptAt = now;
		if (result.ok) {
			sub.lastOkAt = now;
			delete sub.lastError;
		} else {
			sub.lastError = (result.error ?? "unknown error").slice(0, 200);
		}
		touched = true;
	}
	if (touched) writeStore(dataDir, store, options);
}
