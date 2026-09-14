/**
 * 可用性播报单测（server/push/announce.ts）。
 *
 * 这是「应用关着也能收到通知」的那一半，坏掉的后果全是噪音或静默：
 *   - 少了去抖 → 崩溃循环的容器每次起来都推一条；
 *   - 去抖盖错了时刻 → 刚订阅的人第一次重启什么都收不到；
 *   - 把「没有订阅者」也当成一次播报 → 5 分钟内的第一次真实播报被自己吞掉。
 * 所以这里的断言不只看「发了没」，也看**什么时候写了状态**、写没写。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	announceServiceOnline,
	buildOnlineMessage,
	buildTestMessage,
	DEFAULT_ANNOUNCE_MIN_INTERVAL_MS,
	DEFAULT_INSTANCE_NAME,
	decideAnnouncement,
	instanceName,
	PUSH_STATE_FILE,
	pushAnnounceEnabled,
	pushAnnounceMinIntervalMs,
	readPushState,
	writePushState,
} from "../../server/push/announce.js";
import { listPushSubscriptions, replacePushSubscription } from "../../server/push/store.js";
import { resetVapidCache } from "../../server/push/vapid.js";
import {
	makeServerKeyPair,
	makeSubscription,
	makeUserAgent,
	readPushPayload,
	recordingFetch,
	requestBody,
} from "./push-receiver.js";

const dirs: string[] = [];
function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-announce-test-"));
	dirs.push(dir);
	return dir;
}
const envKeys = ["PI_WEB_PUSH_ANNOUNCE", "PI_WEB_PUSH_ANNOUNCE_MIN_INTERVAL_MS", "PI_WEB_INSTANCE_NAME"] as const;

beforeEach(() => {
	for (const k of envKeys) delete process.env[k];
	resetVapidCache();
});
afterEach(() => {
	for (const k of envKeys) delete process.env[k];
	resetVapidCache();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const serverKeyPair = makeServerKeyPair();
const noSleep = async (): Promise<void> => {};

/** A subscription stored in `dir` with its matching user agent. */
function seedSubscription(dir: string, patch: Parameters<typeof makeSubscription>[1] = {}) {
	const ua = makeUserAgent();
	const record = makeSubscription(ua, patch);
	replacePushSubscription(dir, record);
	return { ua, record };
}

describe("decideAnnouncement", () => {
	const now = 1_700_000_000_000;

	it("首次启动且有订阅者 → 播报", () => {
		expect(decideAnnouncement({}, now, 300_000, 1)).toEqual({ announce: true });
	});

	it("没有订阅者 → 不播报（调用方不得因此写去抖时间戳）", () => {
		expect(decideAnnouncement({}, now, 300_000, 0)).toEqual({ announce: false, reason: "no-subscriptions" });
	});

	it("关掉开关 → 不播报", () => {
		expect(decideAnnouncement({}, now, 300_000, 3, false)).toEqual({ announce: false, reason: "disabled" });
	});

	it("去过抖窗口内 → 不播报（崩溃循环不会变成通知风暴）", () => {
		expect(decideAnnouncement({ lastAnnouncedAt: now - 60_000 }, now, 300_000, 2)).toEqual({
			announce: false,
			reason: "debounced",
		});
	});

	it("过了窗口 → 再播报", () => {
		expect(decideAnnouncement({ lastAnnouncedAt: now - 300_001 }, now, 300_000, 2)).toEqual({ announce: true });
	});

	it("窗口为 0 → 不去抖（调试用）", () => {
		expect(decideAnnouncement({ lastAnnouncedAt: now - 1 }, now, 0, 1)).toEqual({ announce: true });
	});
});

describe("配置项", () => {
	it("PI_WEB_PUSH_ANNOUNCE 默认开；0/false/off 关", () => {
		expect(pushAnnounceEnabled()).toBe(true);
		for (const v of ["0", "false", "no", "off", "OFF"]) {
			process.env.PI_WEB_PUSH_ANNOUNCE = v;
			expect(pushAnnounceEnabled(), v).toBe(false);
		}
		process.env.PI_WEB_PUSH_ANNOUNCE = "1";
		expect(pushAnnounceEnabled()).toBe(true);
	});

	it("去抖窗口可覆盖；非法值回落默认", () => {
		expect(pushAnnounceMinIntervalMs()).toBe(DEFAULT_ANNOUNCE_MIN_INTERVAL_MS);
		process.env.PI_WEB_PUSH_ANNOUNCE_MIN_INTERVAL_MS = "1000";
		expect(pushAnnounceMinIntervalMs()).toBe(1000);
		process.env.PI_WEB_PUSH_ANNOUNCE_MIN_INTERVAL_MS = "abc";
		expect(pushAnnounceMinIntervalMs()).toBe(DEFAULT_ANNOUNCE_MIN_INTERVAL_MS);
		process.env.PI_WEB_PUSH_ANNOUNCE_MIN_INTERVAL_MS = "0";
		expect(pushAnnounceMinIntervalMs()).toBe(0);
	});

	it("实例名默认为产品名，可覆盖，且清掉控制字符、限长", () => {
		expect(instanceName()).toBe(DEFAULT_INSTANCE_NAME);
		process.env.PI_WEB_INSTANCE_NAME = "  Tachikoma  ";
		expect(instanceName()).toBe("Tachikoma");
		// 注意：NUL 在这里测不了 —— Node 写 process.env 时会在第一个 NUL 截断
		// （环境变量是 C 字符串），所以用会真正存活下来的控制字符。
		process.env.PI_WEB_INSTANCE_NAME = "a\tb\nc\rd";
		expect(instanceName()).toBe("abcd");
		process.env.PI_WEB_INSTANCE_NAME = "x".repeat(200);
		expect(instanceName().length).toBe(60);
		// 绝不从主机名派生：那会把机器名送到第三方推送服务
		expect(DEFAULT_INSTANCE_NAME).not.toMatch(/localhost|\.local|\.internal/);
	});
});

describe("buildOnlineMessage", () => {
	it("同版本 → 只说回来了", () => {
		expect(buildOnlineMessage({ name: "Tachikoma", version: "0.85.1", previousVersion: "0.85.1" })).toEqual({
			title: "Tachikoma is online",
			body: "The service is available again.",
		});
	});

	it("版本变了 → 带上前后版本（这是「update 生效了」的确认）", () => {
		expect(buildOnlineMessage({ name: "Tachikoma", version: "0.85.1", previousVersion: "0.84.0" }).body).toBe(
			"Updated v0.84.0 → v0.85.1",
		);
	});

	it("首次播报（没有历史版本）不当成更新", () => {
		expect(buildOnlineMessage({ name: "pi-web-ui", version: "0.85.1", previousVersion: "" }).body).toBe(
			"The service is available again.",
		);
	});

	it("按设备的 UI 语言出文案", () => {
		expect(buildOnlineMessage({ name: "Tachikoma", version: "1", previousVersion: "1", locale: "zh-CN" }).title).toBe(
			"Tachikoma 已上线",
		);
		expect(buildOnlineMessage({ name: "Tachikoma", version: "2", previousVersion: "1", locale: "zh" }).body).toBe(
			"已更新 v1 → v2",
		);
	});

	it("测试通知也用同一套本地化", () => {
		expect(buildTestMessage("Tachikoma")).toEqual({
			title: "Tachikoma test notification",
			body: "If you can see this, push is configured correctly.",
		});
		expect(buildTestMessage("Tachikoma", "zh").title).toBe("Tachikoma 测试通知");
	});
});

describe("readPushState / writePushState", () => {
	it("往返正常，文件 0600", () => {
		const dir = tempDataDir();
		writePushState(dir, { lastAnnouncedAt: 42, lastAnnouncedVersion: "0.85.1" });
		expect(readPushState(dir)).toEqual({ lastAnnouncedAt: 42, lastAnnouncedVersion: "0.85.1" });
		expect(statSync(join(dir, PUSH_STATE_FILE)).mode & 0o777).toBe(0o600);
	});

	it("文件缺失/损坏 → 当作「从未播报」，不抛", () => {
		const dir = tempDataDir();
		expect(readPushState(dir)).toEqual({});
		writePushState(dir, { lastAnnouncedAt: 1 });
		rmSync(join(dir, PUSH_STATE_FILE));
		expect(readPushState(dir)).toEqual({});
	});

	it("写不进去只告警，不抛（启动路径不能因为磁盘问题崩）", () => {
		const dir = tempDataDir();
		// 父级是普通文件 → mkdir 必然 ENOTDIR
		writeFileSync(join(dir, "blocker"), "x", "utf8");
		const warnings: string[] = [];
		expect(() =>
			writePushState(join(dir, "blocker", "nested"), { lastAnnouncedAt: 1 }, { warn: (m) => warnings.push(m) }),
		).not.toThrow();
		expect(warnings.join(" ")).toMatch(/could not persist/);
	});
});

describe("announceServiceOnline", () => {
	it("没有订阅者 → 不播报，且**不写**去抖时间戳（否则会吞掉订阅后的第一次播报）", async () => {
		const dir = tempDataDir();
		const { calls, fetchImpl } = recordingFetch([201]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			fetchImpl,
			now: () => 1000,
		});
		expect(result).toEqual({ announced: false, reason: "no-subscriptions", sent: 0, failed: 0, pruned: 0 });
		expect(calls).toHaveLength(0);
		expect(readPushState(dir)).toEqual({});
	});

	it("有订阅者 → 发一条，并把实例名/版本写进通知和状态", async () => {
		const dir = tempDataDir();
		const { ua } = seedSubscription(dir);
		const { calls, fetchImpl } = recordingFetch([201]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			name: "Tachikoma",
			fetchImpl,
			now: () => 1000,
		});

		expect(result).toMatchObject({ announced: true, sent: 1, failed: 0, pruned: 0 });
		expect(calls).toHaveLength(1);
		expect(readPushPayload(requestBody(calls), ua)).toEqual({
			title: "Tachikoma is online",
			body: "The service is available again.",
		});
		expect(readPushState(dir)).toEqual({ lastAnnouncedAt: 1000, lastAnnouncedVersion: "0.85.1" });
	});

	it("重启后带上上一次的版本（update 的确认）", async () => {
		const dir = tempDataDir();
		const { ua } = seedSubscription(dir);
		writePushState(dir, { lastAnnouncedAt: 1, lastAnnouncedVersion: "0.84.0" });
		const { calls, fetchImpl } = recordingFetch([201]);
		await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			name: "Tachikoma",
			fetchImpl,
			now: () => 1_000_000,
		});
		expect(readPushPayload(requestBody(calls), ua).body).toBe("Updated v0.84.0 → v0.85.1");
	});

	it("去抖窗口内 → 一条都不发", async () => {
		const dir = tempDataDir();
		seedSubscription(dir);
		writePushState(dir, { lastAnnouncedAt: 1_000_000, lastAnnouncedVersion: "0.85.1" });
		const { calls, fetchImpl } = recordingFetch([201]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			fetchImpl,
			now: () => 1_000_010,
			minIntervalMs: 300_000,
		});
		expect(result).toMatchObject({ announced: false, reason: "debounced" });
		expect(calls).toHaveLength(0);
	});

	it("关掉开关 → 不播报，也不写状态", async () => {
		const dir = tempDataDir();
		seedSubscription(dir);
		const { calls, fetchImpl } = recordingFetch([201]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			enabled: false,
			fetchImpl,
			now: () => 1000,
		});
		expect(result).toMatchObject({ announced: false, reason: "disabled" });
		expect(calls).toHaveLength(0);
		expect(readPushState(dir)).toEqual({});
	});

	it("全部临时失败 → 重试一次就能成功（启动瞬间出网未就绪）", async () => {
		const dir = tempDataDir();
		seedSubscription(dir);
		const { calls, fetchImpl } = recordingFetch([503, 201]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			fetchImpl,
			now: () => 1000,
			sleep: noSleep,
			retryDelaysMs: [0],
		});
		expect(calls).toHaveLength(2);
		expect(result).toMatchObject({ announced: true, sent: 1, failed: 0 });
	});

	it("永久失败 → 不重试（避免把一个坏凭据打成风暴）", async () => {
		const dir = tempDataDir();
		seedSubscription(dir);
		const { calls, fetchImpl } = recordingFetch([400, 201]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			fetchImpl,
			now: () => 1000,
			sleep: noSleep,
			retryDelaysMs: [0, 0],
		});
		expect(calls).toHaveLength(1);
		expect(result).toMatchObject({ announced: true, sent: 0, failed: 1 });
	});

	it("410 的订阅被摘掉（push service 说它没了）", async () => {
		const dir = tempDataDir();
		seedSubscription(dir, { endpoint: "https://push.example.com/gone" });
		const { fetchImpl } = recordingFetch([410]);
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			fetchImpl,
			now: () => 1000,
		});
		expect(result).toMatchObject({ announced: true, sent: 0, failed: 0, pruned: 1 });
		expect(listPushSubscriptions(dir)).toEqual([]);
	});

	it("每个设备收到自己语言的文案（按 clientId 查到的 locale 分组）", async () => {
		const dir = tempDataDir();
		const zh = seedSubscription(dir, { endpoint: "https://push.example.com/zh", clientId: "c-zh" });
		const en = seedSubscription(dir, { endpoint: "https://push.example.com/en", clientId: "c-en" });
		const { calls, fetchImpl } = recordingFetch([201]);
		await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			name: "Tachikoma",
			localeFor: (clientId) => (clientId === "c-zh" ? "zh-CN" : "en"),
			fetchImpl,
			now: () => 1000,
		});

		expect(calls).toHaveLength(2);
		const zhBody = readPushPayload(
			requestBody(
				calls,
				calls.findIndex((c) => c.url.endsWith("/zh")),
			),
			zh.ua,
		);
		const enBody = readPushPayload(
			requestBody(
				calls,
				calls.findIndex((c) => c.url.endsWith("/en")),
			),
			en.ua,
		);
		expect(zhBody.title).toBe("Tachikoma 已上线");
		expect(enBody.title).toBe("Tachikoma is online");
	});

	it("推送服务整体不可用时也不抛（启动路径的另一条旁路）", async () => {
		const dir = tempDataDir();
		seedSubscription(dir);
		const fetchImpl = (() => Promise.reject(new Error("ENETUNREACH"))) as unknown as typeof fetch;
		const result = await announceServiceOnline({
			dataDir: dir,
			keyPair: serverKeyPair,
			subject: "https://pi-web-ui.invalid",
			version: "0.85.1",
			fetchImpl,
			now: () => 1000,
			sleep: noSleep,
			retryDelaysMs: [],
		});
		expect(result).toMatchObject({ announced: true, sent: 0, failed: 1 });
	});
});
