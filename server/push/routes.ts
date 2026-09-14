/**
 * HTTP surface for Web Push.
 *
 * Four endpoints, all of them behind the existing PI_WEB_TOKEN middleware in
 * index.ts (only /api/health is exempt), which is also why they are safe to
 * expose to the browser: a subscription is per-device state, not a secret
 * shared between users.
 *
 * What these endpoints deliberately never return: the push endpoints
 * themselves. They are capability URLs — whoever holds one can send a
 * notification to that device — and the diagnostics panel only needs labels and
 * status codes, so labels and status codes are all it gets.
 */

import type { Express, Request, Response } from "express";
import { buildTestMessage, instanceName, pushAnnounceEnabled } from "./announce.js";
import type { PushKeyPair } from "./ece.js";
import { applyPushResults, sendPushToAll } from "./sender.js";
import {
	MAX_SUBSCRIPTIONS,
	listPushSubscriptions,
	normalizePushSubscription,
	removePushSubscription,
	replacePushSubscription,
	type PushSubscriptionRecord,
} from "./store.js";
import type { VapidOptions } from "./vapid.js";

export interface PushRoutesDeps extends VapidOptions {
	dataDir: string;
	keyPair: PushKeyPair;
	/** Fallback JWT `sub`; the caller passes `vapidSubject()`. */
	subject: string;
	/** This instance's version, for the diagnostics payload and the test text. */
	version: string;
	/** Resolves a client's UI locale (client-state.json), for localised text. */
	localeFor?: (clientId: string) => string | undefined;
	fetchImpl?: typeof fetch;
}

/** Diagnostics summary — counts and labels only, never an endpoint. */
function describe(records: PushSubscriptionRecord[]) {
	return records.map((r) => ({
		clientId: r.clientId,
		label: r.label,
		createdAt: r.createdAt,
		lastOkAt: r.lastOkAt,
		lastError: r.lastError,
	}));
}

function subscriptionCount(dataDir: string, options: VapidOptions): number {
	return listPushSubscriptions(dataDir, options).length;
}

export function registerPushRoutes(app: Express, deps: PushRoutesDeps): void {
	/**
	 * Everything the client needs to offer (or hide) the feature: the VAPID
	 * public key it must subscribe with, and whether push is usable at all here.
	 * The public key is public by definition — it goes into
	 * `subscribe({ applicationServerKey })` — so there is nothing to protect.
	 */
	app.get("/api/push/config", (_req: Request, res: Response) => {
		res.json({
			available: true,
			announceEnabled: pushAnnounceEnabled(),
			instanceName: instanceName(),
			publicKey: deps.keyPair.publicKey.toString("base64url"),
			maxSubscriptions: MAX_SUBSCRIPTIONS,
			subscriptions: subscriptionCount(deps.dataDir, deps),
		});
	});

	/**
	 * Register (or refresh) this device's subscription. Idempotent: a browser
	 * that re-subscribes with the same endpoint just updates it, and a browser
	 * that had to create a new endpoint silently retires its old one.
	 */
	app.post("/api/push/subscribe", (req: Request, res: Response) => {
		const body = req.body as { clientId?: unknown; subscription?: unknown } | undefined;
		const record = normalizePushSubscription(body?.subscription, {
			clientId: body?.clientId,
			userAgent: req.headers["user-agent"],
		});
		if (!record) {
			// One generic message: saying *which* check failed would turn this into a
			// probe for what the SSRF guard allows.
			res.status(400).json({ ok: false, error: "invalid-subscription" });
			return;
		}
		const records = replacePushSubscription(deps.dataDir, record, deps);
		res.json({ ok: true, subscriptions: records.length });
	});

	/** Forget this device. Accepts the endpoint the browser is about to drop. */
	app.post("/api/push/unsubscribe", (req: Request, res: Response) => {
		const endpoint = (req.body as { endpoint?: unknown } | undefined)?.endpoint;
		if (typeof endpoint !== "string" || endpoint === "" || endpoint.length > 2048) {
			res.status(400).json({ ok: false, error: "invalid-endpoint" });
			return;
		}
		const records = removePushSubscription(deps.dataDir, endpoint, deps);
		res.json({ ok: true, subscriptions: records.length });
	});

	/**
	 * Send a real push to this device (or to all of them when no endpoint is
	 * given). This is the only way to verify end-to-end delivery — push services
	 * cannot be exercised from CI — so it reports what actually happened per
	 * device, which is what the settings panel shows.
	 *
	 * Uses the same sending path and the same outcome handling as a real
	 * announcement, so a passing test really does mean the announce path works
	 * (including pruning a subscription the push service reports as gone).
	 */
	app.post("/api/push/test", async (req: Request, res: Response) => {
		const body = req.body as { endpoint?: unknown; clientId?: unknown } | undefined;
		const all = listPushSubscriptions(deps.dataDir, deps);
		const requested = typeof body?.endpoint === "string" ? body.endpoint : "";
		const targets = requested ? all.filter((r) => r.endpoint === requested) : all;
		if (targets.length === 0) {
			res.status(404).json({ ok: false, error: "no-subscription" });
			return;
		}
		const requestedClient = typeof body?.clientId === "string" ? body.clientId : "";
		const locale = deps.localeFor?.(requestedClient || (targets[0]?.clientId ?? ""));
		const attempts = await sendPushToAll(targets, buildTestMessage(instanceName(), locale), deps);
		const summary = applyPushResults(deps.dataDir, attempts, deps);
		res.json({
			ok: attempts.length > 0 && attempts.every((a) => a.result.ok),
			sent: summary.sent,
			failed: summary.failed,
			pruned: summary.pruned,
			// Labels and status codes only: the endpoint is a capability URL.
			results: attempts.map(({ record, result }) => ({
				label: record.label,
				ok: result.ok,
				status: result.status,
				outcome: result.outcome,
				error: result.error,
			})),
			subscriptions: describe(targets),
		});
	});
}
