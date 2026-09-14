/**
 * Service availability announcement — "pi-web-ui is back".
 *
 * This is the half that works when nothing is open: no page, no tab, no app.
 * The server says so itself, right after it starts, because that is the only
 * moment a server can truthfully claim to be available again. It is the Web
 * Push counterpart of the in-page cue (web/src/availability.ts), and the two
 * never both fire their toast: the service worker stays quiet when it can see a
 * window and lets the page do it.
 *
 * What this deliberately is NOT: a downtime alert. A dead server cannot send
 * anything, so the *absence* of the "I'm back" message is the only down signal
 * there is. Real downtime detection belongs to an external monitor and has no
 * business living inside the thing being monitored.
 *
 * Two guards keep it from turning into noise on a crash-looping container:
 * a grace period (announce only after the process has survived a few seconds)
 * and a persisted debounce window (never announce twice in quick succession).
 * The window is stamped *before* sending, so a process that dies mid-send
 * cannot be re-triggered in a tight loop.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pick, resolveServerLang } from "../i18n.js";
import type { PushKeyPair } from "./ece.js";
import { sendPushToAll, applyPushResults, type PushMessage } from "./sender.js";
import { listPushSubscriptions, type PushSubscriptionRecord } from "./store.js";
import type { VapidOptions } from "./vapid.js";

export const PUSH_STATE_FILE = "push-state.json";
/** Let the process prove it survives a moment before claiming to be healthy. */
export const DEFAULT_ANNOUNCE_GRACE_MS = 8_000;
/** Minimum spacing between announcements (crash loops, rapid redeploys). */
export const DEFAULT_ANNOUNCE_MIN_INTERVAL_MS = 5 * 60_000;
/** Retried only when *every* send failed transiently (egress not up yet). */
export const ANNOUNCE_RETRY_DELAYS_MS = [15_000, 60_000];

/** Default display name. Never derived from the host: that would leak the
 *  machine's name to a third-party push service. */
export const DEFAULT_INSTANCE_NAME = "pi-web-ui";

export interface PushState {
	lastAnnouncedAt?: number;
	lastAnnouncedVersion?: string;
}

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function truthyEnv(raw: string | undefined): boolean {
	const v = (raw ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/** `PI_WEB_PUSH_ANNOUNCE` — set to 0/false to keep the feature but stay silent. */
export function pushAnnounceEnabled(): boolean {
	const raw = (process.env.PI_WEB_PUSH_ANNOUNCE ?? "").trim().toLowerCase();
	if (raw === "") return true;
	return truthyEnv(raw);
}

/** `PI_WEB_PUSH_ANNOUNCE_MIN_INTERVAL_MS` — debounce window, 0 disables it. */
export function pushAnnounceMinIntervalMs(): number {
	const raw = Number(process.env.PI_WEB_PUSH_ANNOUNCE_MIN_INTERVAL_MS);
	if (!Number.isFinite(raw) || raw < 0) return DEFAULT_ANNOUNCE_MIN_INTERVAL_MS;
	return raw;
}

/** `PI_WEB_INSTANCE_NAME` — what the notification calls this deployment. */
export function instanceName(): string {
	const raw = (process.env.PI_WEB_INSTANCE_NAME ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return raw === "" ? DEFAULT_INSTANCE_NAME : raw.slice(0, 60);
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** Best-effort read; a missing or unreadable file just means "never announced". */
export function readPushState(dataDir: string): PushState {
	try {
		const parsed = JSON.parse(readFileSync(join(dataDir, PUSH_STATE_FILE), "utf8")) as PushState;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function writePushState(dataDir: string, state: PushState, options: VapidOptions = {}): void {
	const path = join(dataDir, PUSH_STATE_FILE);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch (err) {
		(options.warn ?? ((): void => {}))(
			`could not persist ${PUSH_STATE_FILE}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export interface AnnounceDecision {
	announce: boolean;
	reason?: "disabled" | "no-subscriptions" | "debounced";
}

/**
 * Should this boot announce? Pure, so the guards are pinned by tests.
 *
 * `subscriptionCount` is checked first on purpose: with no subscribers there is
 * nothing to say, and — more importantly — the caller must not stamp the
 * debounce window, which would otherwise swallow the first real announcement
 * after someone subscribes.
 */
export function decideAnnouncement(
	state: PushState,
	now: number,
	minIntervalMs: number,
	subscriptionCount: number,
	enabled = true,
): AnnounceDecision {
	if (!enabled) return { announce: false, reason: "disabled" };
	if (subscriptionCount <= 0) return { announce: false, reason: "no-subscriptions" };
	if (minIntervalMs > 0 && typeof state.lastAnnouncedAt === "number" && now - state.lastAnnouncedAt < minIntervalMs) {
		return { announce: false, reason: "debounced" };
	}
	return { announce: true };
}

/* ------------------------------------------------------------------ */
/* Message                                                             */
/* ------------------------------------------------------------------ */

export interface OnlineMessageInput {
	name: string;
	version: string;
	/** Version announced at the previous boot (empty = unknown). */
	previousVersion: string;
	/** UI locale of the target device, as reported by `hello`/`set_locale`. */
	locale?: string;
}

/**
 * Localised "back online" notification.
 *
 * The text is built here rather than in the service worker because the worker
 * has no translation table, and it is per-device because the locale is known
 * per client (client-state.json). Third languages come from the packs' server
 * strings and fall back to English, like every other server-side string.
 */
export function buildOnlineMessage(input: OnlineMessageInput): PushMessage {
	const lang = resolveServerLang(input.locale);
	// Inline zh/en interpolate directly and `vars` only feeds the third-language
	// table lookup (`pick` substitutes there), which is the convention every other
	// server caller follows — see server/goal-service.ts.
	const title = pick(lang, `${input.name} 已上线`, `${input.name} is online`, "push.online.title", {
		name: input.name,
	});
	const versionChanged =
		input.version.trim() !== "" && input.previousVersion.trim() !== "" && input.version !== input.previousVersion;
	if (versionChanged) {
		return {
			title,
			body: pick(
				lang,
				`已更新 v${input.previousVersion} → v${input.version}`,
				`Updated v${input.previousVersion} → v${input.version}`,
				"push.online.updated",
				{ from: input.previousVersion, to: input.version },
			),
		};
	}
	return {
		title,
		body: pick(lang, "服务已恢复可用。", "The service is available again.", "push.online.body"),
	};
}

/** Notification used by the panel's "send a test notification" button. */
export function buildTestMessage(name: string, locale?: string): PushMessage {
	const lang = resolveServerLang(locale);
	return {
		title: pick(lang, `${name} 测试通知`, `${name} test notification`, "push.test.title", { name }),
		body: pick(
			lang,
			"如果你看到这条，推送配置是正确的。",
			"If you can see this, push is configured correctly.",
			"push.test.body",
		),
	};
}

/* ------------------------------------------------------------------ */
/* Announcement                                                        */
/* ------------------------------------------------------------------ */

export interface AnnounceOptions extends VapidOptions {
	dataDir: string;
	keyPair: PushKeyPair;
	subject: string;
	/** This build's version, announced (and compared) across restarts. */
	version: string;
	/** Overrides `PI_WEB_INSTANCE_NAME` (tests). */
	name?: string;
	/** Resolves a subscription's UI locale (client-state.json lookup). */
	localeFor?: (clientId: string) => string | undefined;
	minIntervalMs?: number;
	enabled?: boolean;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	fetchImpl?: typeof fetch;
	retryDelaysMs?: number[];
}

export interface AnnounceResult {
	announced: boolean;
	reason?: AnnounceDecision["reason"];
	sent: number;
	failed: number;
	pruned: number;
}

/** One locale's worth of devices — the notification text is per locale. */
interface LocaleGroup {
	locale: string;
	records: PushSubscriptionRecord[];
}

function groupByLocale(
	records: PushSubscriptionRecord[],
	localeFor: (clientId: string) => string | undefined,
): LocaleGroup[] {
	const groups = new Map<string, LocaleGroup>();
	for (const record of records) {
		const locale = resolveServerLang(localeFor(record.clientId));
		const existing = groups.get(locale);
		if (existing) existing.records.push(record);
		else groups.set(locale, { locale, records: [record] });
	}
	return [...groups.values()];
}

/**
 * Announce that this instance is available, right now.
 *
 * Never throws and never blocks the caller's path — it runs detached from boot.
 */
export async function announceServiceOnline(options: AnnounceOptions): Promise<AnnounceResult> {
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const warn = options.warn ?? ((): void => {});
	const name = options.name ?? instanceName();
	const enabled = options.enabled ?? pushAnnounceEnabled();

	try {
		const records = listPushSubscriptions(options.dataDir, options);
		const state = readPushState(options.dataDir);
		const decision = decideAnnouncement(
			state,
			now(),
			options.minIntervalMs ?? pushAnnounceMinIntervalMs(),
			records.length,
			enabled,
		);
		if (!decision.announce) return { announced: false, reason: decision.reason, sent: 0, failed: 0, pruned: 0 };

		// Stamp before sending: whatever happens next, this boot has announced.
		const previousVersion = typeof state.lastAnnouncedVersion === "string" ? state.lastAnnouncedVersion : "";
		writePushState(options.dataDir, { lastAnnouncedAt: now(), lastAnnouncedVersion: options.version }, options);

		const groups = groupByLocale(records, options.localeFor ?? ((): undefined => undefined));
		const retries = options.retryDelaysMs ?? ANNOUNCE_RETRY_DELAYS_MS;
		// Tally the *final* verdict per device, not every attempt: a subscribe that
		// failed once and succeeded on the retry is delivered, not "1 sent, 1 failed".
		const verdictByEndpoint = new Map<string, "sent" | "failed" | "pruned">();
		let pending = groups;

		for (let attempt = 0; ; attempt += 1) {
			const failedGroups: LocaleGroup[] = [];
			for (const group of pending) {
				const message = buildOnlineMessage({
					name,
					version: options.version,
					previousVersion,
					locale: group.locale,
				});
				const attempts = await sendPushToAll(group.records, message, options);
				applyPushResults(options.dataDir, attempts, options);
				for (const { record, result } of attempts) {
					verdictByEndpoint.set(record.endpoint, result.outcome === "prune" ? "pruned" : result.ok ? "sent" : "failed");
				}
				if (attempts.every((a) => a.result.outcome === "retry")) failedGroups.push(group);
			}
			const delay = retries[attempt];
			if (failedGroups.length === 0 || delay === undefined) break;
			// Boot-time egress is not always ready the instant we listen; retrying
			// only when *nothing* got through keeps a healthy deploy at one send.
			await sleep(delay);
			pending = failedGroups;
		}

		const total = { sent: 0, failed: 0, pruned: 0 };
		for (const verdict of verdictByEndpoint.values()) {
			if (verdict === "sent") total.sent += 1;
			else if (verdict === "pruned") total.pruned += 1;
			else total.failed += 1;
		}
		return { announced: true, ...total };
	} catch (err) {
		warn(`availability announcement failed: ${err instanceof Error ? err.message : String(err)}`);
		return { announced: false, sent: 0, failed: 0, pruned: 0 };
	}
}

export interface ScheduledAnnounceOptions extends AnnounceOptions {
	graceMs?: number;
	/** Informational sink: the outcome is worth having in container logs, since a
	 *  "why did I get no notification?" question is answered nowhere else. */
	log?: (message: string) => void;
}

/**
 * Start the announcement timer. Called once from the boot sequence, detached
 * from it: an announcement must never delay or break startup.
 */
export function scheduleServiceAnnouncement(options: ScheduledAnnounceOptions): void {
	const grace = options.graceMs ?? DEFAULT_ANNOUNCE_GRACE_MS;
	const warn = options.warn ?? ((): void => {});
	const timer = setTimeout(() => {
		void announceServiceOnline(options).then((result) => {
			if (!result.announced) {
				if (result.reason) options.log?.(`availability announcement skipped (${result.reason})`);
				return;
			}
			const line = `availability announced (sent=${result.sent} failed=${result.failed} pruned=${result.pruned})`;
			if (result.failed > 0) warn(line);
			else options.log?.(line);
		});
	}, grace);
	// A pending announcement must not keep the process alive on shutdown.
	timer.unref?.();
}
