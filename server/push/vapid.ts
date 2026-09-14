/**
 * VAPID (RFC 8292) key management for Web Push.
 *
 * Zero-configuration by design: on first use the pair is generated and written
 * to `<dataDir>/vapid.json` (0600) so that `docker compose up` — or any other
 * one-command deployment — produces a working push setup with no operator
 * action. Operators who would rather manage the key themselves (multi-instance
 * setups, secret managers) can inject it through
 * `PI_WEB_VAPID_PUBLIC_KEY` / `PI_WEB_VAPID_PRIVATE_KEY`.
 *
 * A note on what rotating the key costs: the browser binds a subscription to
 * the VAPID public key it was created with, so changing the pair silently
 * invalidates every existing subscription (push services answer 403). The
 * subscription store therefore records which public key its entries were made
 * with and drops them when it changes, instead of retrying forever against
 * credentials that can never work again. Because both files live in the same
 * data directory they normally rotate together, which keeps the common case
 * self-consistent.
 *
 * Nothing here is ever logged or sent anywhere except as the `k` parameter of
 * an Authorization header; the private scalar stays on disk.
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isConsistentKeyPair, type PushKeyPair } from "./ece.js";

export const VAPID_FILE = "vapid.json";

/**
 * Default JWT `sub` claim. `.invalid` is reserved by RFC 2606 and can never
 * resolve, so a deployment that does not care about the contact URI does not
 * have to publish one — and we never fall back to the machine hostname, which
 * would leak internal naming to the push service.
 */
export const DEFAULT_VAPID_SUBJECT = "https://pi-web-ui.invalid";

export type VapidKeySource = "env" | "file" | "generated";

export interface LoadedVapidKeys {
	keyPair: PushKeyPair;
	source: VapidKeySource;
	/** True when this process created and persisted a new pair. */
	created: boolean;
}

export interface VapidOptions {
	/** Best-effort diagnostics sink; persistence problems must not throw. */
	warn?: (message: string) => void;
}

function decodeRawKey(raw: string | undefined, expectedBytes: number): Buffer | null {
	if (typeof raw !== "string" || raw.trim() === "") return null;
	const buf = Buffer.from(raw.trim(), "base64url");
	return buf.length === expectedBytes ? buf : null;
}

/** `PI_WEB_VAPID_*` override, or null when absent/invalid. */
function keyPairFromEnv(warn: (message: string) => void): PushKeyPair | null {
	const pub = process.env.PI_WEB_VAPID_PUBLIC_KEY;
	const priv = process.env.PI_WEB_VAPID_PRIVATE_KEY;
	if (!pub && !priv) return null;
	const publicKey = decodeRawKey(pub, 65);
	const privateKey = decodeRawKey(priv, 32);
	if (!publicKey || !privateKey || !isConsistentKeyPair({ privateKey, publicKey })) {
		// Both variables are required and must belong together; a half-configured
		// override is almost certainly a deployment mistake, so say so loudly and
		// carry on with the on-disk pair rather than pushing with broken keys.
		warn("PI_WEB_VAPID_PUBLIC_KEY / PI_WEB_VAPID_PRIVATE_KEY are missing or do not match — ignoring them");
		return null;
	}
	return { privateKey, publicKey };
}

interface StoredVapidFile {
	publicKey?: string;
	privateKey?: string;
}

function readKeyFile(path: string, warn: (message: string) => void): PushKeyPair | null {
	let parsed: StoredVapidFile;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8")) as StoredVapidFile;
	} catch {
		return null; // absent or unreadable — the caller generates a fresh pair
	}
	const publicKey = decodeRawKey(parsed.publicKey, 65);
	const privateKey = decodeRawKey(parsed.privateKey, 32);
	if (!publicKey || !privateKey || !isConsistentKeyPair({ privateKey, publicKey })) {
		// A mismatched pair cannot encrypt anything a client can open, so keeping
		// it would be worse than replacing it.
		warn(`${VAPID_FILE} holds an invalid or mismatched key pair — regenerating`);
		return null;
	}
	return { privateKey, publicKey };
}

function writeKeyFile(path: string, keyPair: PushKeyPair, warn: (message: string) => void): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		// Mode 0600 from the start: the file is renamed, not chmod-ed afterwards.
		writeFileSync(
			tmp,
			`${JSON.stringify(
				{
					publicKey: keyPair.publicKey.toString("base64url"),
					privateKey: keyPair.privateKey.toString("base64url"),
				},
				null,
				"\t",
			)}\n`,
			{ mode: 0o600 },
		);
		renameSync(tmp, path);
	} catch (err) {
		// In-memory keys still work for this process, but every subscription made
		// now will break at the next restart (the browser bound them to this key).
		warn(`could not persist ${VAPID_FILE}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function generateKeyPair(): PushKeyPair {
	// Generate with the default (KeyObject) encodings and export the JWK: the
	// `publicKeyEncoding: { format: "jwk" }` overload of generateKeyPairSync is
	// not in @types/node, and exporting from a KeyObject is the better-typed
	// route to the same raw material anyway.
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

/** Per-directory cache: the key is read once per process, not per send. */
const cache = new Map<string, LoadedVapidKeys>();

/** Load, generate or accept the VAPID key pair for this data directory. */
export function loadOrCreateVapidKeys(dataDir: string, options: VapidOptions = {}): LoadedVapidKeys {
	const cached = cache.get(dataDir);
	if (cached) return cached;
	const warn = options.warn ?? ((): void => {});
	const path = join(dataDir, VAPID_FILE);

	const fromEnv = keyPairFromEnv(warn);
	if (fromEnv) {
		const loaded: LoadedVapidKeys = { keyPair: fromEnv, source: "env", created: false };
		cache.set(dataDir, loaded);
		return loaded;
	}

	const fromFile = readKeyFile(path, warn);
	if (fromFile) {
		const loaded: LoadedVapidKeys = { keyPair: fromFile, source: "file", created: false };
		cache.set(dataDir, loaded);
		return loaded;
	}

	const keyPair = generateKeyPair();
	writeKeyFile(path, keyPair, warn);
	const loaded: LoadedVapidKeys = { keyPair, source: "generated", created: true };
	cache.set(dataDir, loaded);
	return loaded;
}

/** JWT `sub` claim — operator-provided contact URI, or the neutral default. */
export function vapidSubject(): string {
	const raw = process.env.PI_WEB_VAPID_SUBJECT?.trim();
	return raw && raw !== "" ? raw : DEFAULT_VAPID_SUBJECT;
}

/** Drop the cache (tests, or after a data-dir change). */
export function resetVapidCache(): void {
	cache.clear();
}
