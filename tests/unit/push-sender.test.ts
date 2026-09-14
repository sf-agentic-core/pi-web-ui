/**
 * 推送传输层单测（server/push/sender.ts）。
 *
 * 这里锁的是「发出去的那个 HTTP 请求长什么样」和「响应怎么归类」。两件事都
 * 不能只靠"看起来对"：
 *   - 请求头/方法/redirect/timeout 错一个，push service 的表现是静默拒绝或
 *     把 POST 转到别处（SSRF），生产里几乎排不出来；
 *   - 归类错了，要么把还能用的订阅删掉（把 403 当成失效），要么对着一个已经
 *     失效的订阅无限重试。
 *
 * 请求体用 RFC 8291 的**接收方向**解开（tests/unit/push-receiver.ts），所以断言
 * 不是"我们发了点东西"，而是"浏览器会解出这条消息"。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUSH_MAX_PLAINTEXT_BYTES } from "../../server/push/ece.js";
import {
	applyPushResults,
	encodePushPayload,
	PUSH_TTL_SECONDS,
	sendPush,
	sendPushToAll,
	type PushTransportOptions,
} from "../../server/push/sender.js";
import { listPushSubscriptions, replacePushSubscription } from "../../server/push/store.js";
import { resetVapidCache } from "../../server/push/vapid.js";
import {
	makeServerKeyPair,
	makeSubscription,
	makeUserAgent,
	readPushPayload,
	recordingFetch,
	requestBody,
	requestHeaders,
} from "./push-receiver.js";

const dirs: string[] = [];
function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-sender-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	resetVapidCache();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const serverKeyPair = makeServerKeyPair();

function transport(patch: Partial<PushTransportOptions> = {}): PushTransportOptions {
	return { keyPair: serverKeyPair, subject: "https://pi-web-ui.invalid", ...patch };
}

describe("encodePushPayload", () => {
	it("小消息原样序列化", () => {
		expect(JSON.parse(encodePushPayload({ title: "a", body: "b" }).toString("utf8"))).toEqual({
			title: "a",
			body: "b",
		});
	});

	it("超长 body 会被裁到一条记录以内（而不是让 push service 静默拒绝）", () => {
		const encoded = encodePushPayload({ title: "pi-web-ui is online", body: "x".repeat(8000) });
		expect(encoded.length).toBeLessThanOrEqual(PUSH_MAX_PLAINTEXT_BYTES);
		const parsed = JSON.parse(encoded.toString("utf8")) as { title: string; body?: string };
		expect(parsed.title).toBe("pi-web-ui is online");
	});

	it("标题本身超限是调用方的 bug，直接抛（不静默丢通知）", () => {
		expect(() => encodePushPayload({ title: "y".repeat(PUSH_MAX_PLAINTEXT_BYTES + 100) })).toThrow(/does not fit/);
	});

	it("多字节字符按字节算，不按字符算", () => {
		const encoded = encodePushPayload({ title: "服务已上线", body: "🚀".repeat(3000) });
		expect(encoded.length).toBeLessThanOrEqual(PUSH_MAX_PLAINTEXT_BYTES);
	});
});

describe("sendPush —— 请求形状", () => {
	it("POST 到端点，带 VAPID/TTL/aes128gcm，且不跟随重定向", async () => {
		const ua = makeUserAgent();
		const { calls, fetchImpl } = recordingFetch([201]);
		const result = await sendPush(makeSubscription(ua), { title: "pi-web-ui is online" }, transport({ fetchImpl }));

		expect(result).toMatchObject({ ok: true, status: 201, outcome: "ok" });
		const call = calls[0];
		expect(call?.url).toBe("https://fcm.googleapis.com/wp/test-endpoint");
		const headers = requestHeaders(calls);
		expect(call?.init.method).toBe("POST");
		expect(headers["Content-Encoding"]).toBe("aes128gcm");
		expect(headers["Content-Type"]).toBe("application/octet-stream");
		expect(headers.TTL).toBe(String(PUSH_TTL_SECONDS));
		expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
		// SSRF：端点由客户端给，绝不能让一次重定向把我们的 POST 指到别处。
		expect(call?.init.redirect).toBe("error");
		expect(call?.init.signal).toBeInstanceOf(AbortSignal);
	});

	it("请求体是浏览器能解开的加密消息（不是我们自己的内部格式）", async () => {
		const ua = makeUserAgent();
		const { calls, fetchImpl } = recordingFetch([201]);
		await sendPush(
			makeSubscription(ua),
			{ title: "Tachikoma is online", body: "Updated v0.84.0 → v0.85.1" },
			transport({ fetchImpl }),
		);

		const body = requestBody(calls);
		expect(readPushPayload(body, ua)).toEqual({ title: "Tachikoma is online", body: "Updated v0.84.0 → v0.85.1" });
	});

	it("keyid 就是 VAPID 公钥（同一把密钥两用，规范要求）", async () => {
		const ua = makeUserAgent();
		const { calls, fetchImpl } = recordingFetch([201]);
		await sendPush(makeSubscription(ua), { title: "x" }, transport({ fetchImpl }));
		const body = requestBody(calls);
		const authorization = requestHeaders(calls).Authorization ?? "";
		const k = /k=(.+)$/.exec(authorization)?.[1] ?? "";
		expect(k).not.toBe("");
		expect(body.subarray(21, 86).toString("base64url")).toBe(k);
	});

	it("TTL 可覆盖", async () => {
		const ua = makeUserAgent();
		const { calls, fetchImpl } = recordingFetch([201]);
		await sendPush(makeSubscription(ua), { title: "x" }, transport({ fetchImpl, ttlSeconds: 60 }));
		expect(requestHeaders(calls).TTL).toBe("60");
	});
});

describe("sendPush —— 结果归类", () => {
	const cases: [number, string, boolean][] = [
		[201, "ok", true],
		[200, "ok", true],
		[404, "prune", false],
		[410, "prune", false],
		[429, "retry", false],
		[500, "retry", false],
		[503, "retry", false],
		[400, "error", false],
		// 403 = 我们的 VAPID 凭据不匹配，不是订阅失效：删掉等于每次轮换密钥都清空订阅
		[403, "error", false],
	];

	for (const [status, outcome, ok] of cases) {
		it(`HTTP ${status} → ${outcome}`, async () => {
			const ua = makeUserAgent();
			const { fetchImpl } = recordingFetch([status]);
			const result = await sendPush(makeSubscription(ua), { title: "x" }, transport({ fetchImpl }));
			expect(result.outcome).toBe(outcome);
			expect(result.ok).toBe(ok);
			expect(result.status).toBe(status);
		});
	}

	it("网络失败 → retry（临时性），订阅保留", async () => {
		const ua = makeUserAgent();
		const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
		const result = await sendPush(makeSubscription(ua), { title: "x" }, transport({ fetchImpl }));
		expect(result).toMatchObject({ ok: false, outcome: "retry" });
		expect(result.error).toMatch(/ECONNREFUSED/);
		expect(result.status).toBeUndefined();
	});

	it("订阅密钥坏掉 → prune（永远发不出去，留着只会一直重试）", async () => {
		const ua = makeUserAgent();
		const { fetchImpl, calls } = recordingFetch([201]);
		const broken = makeSubscription(ua, { p256dh: Buffer.alloc(65, 1).toString("base64url") });
		const result = await sendPush(broken, { title: "x" }, transport({ fetchImpl }));
		expect(result).toMatchObject({ ok: false, outcome: "prune" });
		expect(calls).toHaveLength(0); // 连请求都没发出去
	});
});

describe("sendPushToAll", () => {
	it("发给所有订阅，并把结果和订阅配对", async () => {
		const uas = [makeUserAgent(), makeUserAgent(), makeUserAgent()];
		const records = uas.map((ua, i) =>
			makeSubscription(ua, { endpoint: `https://push.example.com/${i}`, clientId: `c${i}` }),
		);
		const { calls, fetchImpl } = recordingFetch([201]);
		const attempts = await sendPushToAll(records, { title: "x" }, transport({ fetchImpl }));

		expect(calls).toHaveLength(3);
		expect(attempts).toHaveLength(3);
		expect(attempts.map((a) => a.record.endpoint).sort()).toEqual([
			"https://push.example.com/0",
			"https://push.example.com/1",
			"https://push.example.com/2",
		]);
		expect(attempts.every((a) => a.result.ok)).toBe(true);
	});

	it("每个订阅用自己的密钥加密（不能复用同一个 body）", async () => {
		const uas = [makeUserAgent(), makeUserAgent()];
		const records = uas.map((ua, i) =>
			makeSubscription(ua, { endpoint: `https://push.example.com/${i}`, clientId: `c${i}` }),
		);
		const { calls, fetchImpl } = recordingFetch([201]);
		await sendPushToAll(records, { title: "pi-web-ui is online" }, transport({ fetchImpl }));

		const bodies = [requestBody(calls, 0), requestBody(calls, 1)];
		expect(bodies[0]?.equals(bodies[1] ?? Buffer.alloc(0))).toBe(false);
		// 各自都能用自己的私钥解开
		expect(readPushPayload(bodies[0]!, uas[0]!)).toEqual({ title: "pi-web-ui is online" });
		expect(readPushPayload(bodies[1]!, uas[1]!)).toEqual({ title: "pi-web-ui is online" });
	});
});

describe("applyPushResults", () => {
	it("prune 真的把订阅从存储里删掉，成功/失败写回诊断字段", async () => {
		const dir = tempDataDir();
		const alive = makeUserAgent();
		const gone = makeUserAgent();
		const failing = makeUserAgent();
		replacePushSubscription(
			dir,
			makeSubscription(alive, { endpoint: "https://push.example.com/alive", clientId: "a" }),
		);
		replacePushSubscription(dir, makeSubscription(gone, { endpoint: "https://push.example.com/gone", clientId: "g" }));
		replacePushSubscription(
			dir,
			makeSubscription(failing, { endpoint: "https://push.example.com/failing", clientId: "f" }),
		);

		const attempts = [
			{
				record: makeSubscription(alive, { endpoint: "https://push.example.com/alive", clientId: "a" }),
				result: { ok: true, status: 201, outcome: "ok" as const },
			},
			{
				record: makeSubscription(gone, { endpoint: "https://push.example.com/gone", clientId: "g" }),
				result: { ok: false, status: 410, outcome: "prune" as const, error: "HTTP 410" },
			},
			{
				record: makeSubscription(failing, { endpoint: "https://push.example.com/failing", clientId: "f" }),
				result: { ok: false, status: 503, outcome: "retry" as const, error: "HTTP 503" },
			},
		];
		const summary = applyPushResults(dir, attempts);

		expect(summary).toEqual({ sent: 1, failed: 1, pruned: 1 });
		const stored = listPushSubscriptions(dir);
		expect(stored.map((s) => s.endpoint).sort()).toEqual([
			"https://push.example.com/alive",
			"https://push.example.com/failing",
		]);
		expect(stored.find((s) => s.endpoint.endsWith("/alive"))?.lastOkAt).toBeTypeOf("number");
		expect(stored.find((s) => s.endpoint.endsWith("/failing"))?.lastError).toBe("HTTP 503");
	});
});
