/**
 * 订阅存储单测（server/push/store.ts 的 IO 部分）。
 *
 * 契约和 client-state.ts 一样：文件是唯一状态，所有 IO 都是 best-effort，
 * 坏文件/写不进去都不许抛到调用方（这是启动路径上的代码）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listPushSubscriptions,
	MAX_SUBSCRIPTIONS,
	recordPushResult,
	removePushSubscription,
	replacePushSubscription,
	SUBSCRIPTIONS_FILE,
	type PushSubscriptionRecord,
} from "../../server/push/store.js";
import { resetVapidCache, VAPID_FILE } from "../../server/push/vapid.js";

const dirs: string[] = [];
function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-pushstore-test-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	resetVapidCache();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 0x11)]).toString("base64url");
const AUTH = Buffer.alloc(16, 0x22).toString("base64url");

function record(i: number, patch: Partial<PushSubscriptionRecord> = {}): PushSubscriptionRecord {
	return {
		endpoint: `https://push.example.com/${i}`,
		p256dh: P256DH,
		auth: AUTH,
		clientId: `c${i}`,
		label: "",
		createdAt: 1000 + i,
		...patch,
	};
}

describe("replacePushSubscription", () => {
	it("插入后能读回来，文件是 0600", () => {
		const dir = tempDataDir();
		const stored = replacePushSubscription(dir, record(1));
		expect(stored).toHaveLength(1);
		expect(listPushSubscriptions(dir)[0]?.endpoint).toBe("https://push.example.com/1");
		expect(statSync(join(dir, SUBSCRIPTIONS_FILE)).mode & 0o777).toBe(0o600);
	});

	it("同一 endpoint 重复注册是幂等的，且保留原始 createdAt", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1, { createdAt: 111 }));
		const stored = replacePushSubscription(dir, record(1, { createdAt: 999, label: "Chrome/142" }));
		expect(stored).toHaveLength(1);
		expect(stored[0]?.createdAt).toBe(111);
		expect(stored[0]?.label).toBe("Chrome/142");
	});

	it("同一 clientId 换新 endpoint 时，旧 endpoint 被清掉（否则留下永远发不出去的死条目）", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1, { clientId: "same" }));
		const stored = replacePushSubscription(dir, record(2, { clientId: "same" }));
		expect(stored.map((s) => s.endpoint)).toEqual(["https://push.example.com/2"]);
	});

	it("多个设备共存", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		replacePushSubscription(dir, record(2));
		expect(listPushSubscriptions(dir)).toHaveLength(2);
	});

	it("数量有上限，挤掉最老的（不让客户端无限撑大文件）", () => {
		const dir = tempDataDir();
		for (let i = 0; i < MAX_SUBSCRIPTIONS + 6; i++) replacePushSubscription(dir, record(i));
		const endpoints = listPushSubscriptions(dir).map((s) => s.endpoint);
		expect(endpoints).toHaveLength(MAX_SUBSCRIPTIONS);
		expect(endpoints).not.toContain("https://push.example.com/0");
		expect(endpoints).toContain(`https://push.example.com/${MAX_SUBSCRIPTIONS + 5}`);
	});

	it("不留 .tmp 残渣（原子写：写完即 rename）", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});
});

describe("removePushSubscription", () => {
	it("按 endpoint 删除", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		replacePushSubscription(dir, record(2));
		expect(removePushSubscription(dir, "https://push.example.com/1")).toHaveLength(1);
		expect(listPushSubscriptions(dir)[0]?.endpoint).toBe("https://push.example.com/2");
	});

	it("删不存在的 endpoint 不报错", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		expect(removePushSubscription(dir, "https://push.example.com/nope")).toHaveLength(1);
	});
});

describe("recordPushResult", () => {
	it("成功写入 lastOkAt 并清掉旧错误", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		recordPushResult(dir, "https://push.example.com/1", { ok: false, error: "503 retry later", now: 5 });
		expect(listPushSubscriptions(dir)[0]?.lastError).toBe("503 retry later");
		recordPushResult(dir, "https://push.example.com/1", { ok: true, now: 9 });
		const after = listPushSubscriptions(dir)[0];
		expect(after?.lastOkAt).toBe(9);
		expect(after?.lastError).toBeUndefined();
	});

	it("只动命中的那条", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		replacePushSubscription(dir, record(2));
		recordPushResult(dir, "https://push.example.com/1", { ok: true, now: 9 });
		expect(listPushSubscriptions(dir).find((s) => s.endpoint.endsWith("/2"))?.lastOkAt).toBeUndefined();
	});

	it("错误信息会被截断（诊断面板要显示它，别把整页塞进去）", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		recordPushResult(dir, "https://push.example.com/1", { ok: false, error: "x".repeat(500) });
		expect(listPushSubscriptions(dir)[0]?.lastError?.length).toBe(200);
	});
});

describe("健壮性", () => {
	it("文件损坏 → 当作空表，不抛", () => {
		const dir = tempDataDir();
		writeFileSync(join(dir, SUBSCRIPTIONS_FILE), "{ not json", "utf8");
		expect(() => listPushSubscriptions(dir)).not.toThrow();
		expect(listPushSubscriptions(dir)).toEqual([]);
	});

	it("subscriptions 不是数组 → 当作空表", () => {
		const dir = tempDataDir();
		writeFileSync(join(dir, SUBSCRIPTIONS_FILE), JSON.stringify({ subscriptions: "nope" }), "utf8");
		expect(listPushSubscriptions(dir)).toEqual([]);
	});

	it("VAPID 公钥变了 → 旧订阅全部丢弃（浏览器把它们绑死在旧公钥上，留着只会一直失败）", () => {
		const dir = tempDataDir();
		replacePushSubscription(dir, record(1));
		expect(listPushSubscriptions(dir)).toHaveLength(1);

		// 模拟：dataDir 丢了 vapid.json（或运维通过环境变量轮换了密钥）
		rmSync(join(dir, VAPID_FILE), { force: true });
		resetVapidCache();

		const warnings: string[] = [];
		expect(listPushSubscriptions(dir, { warn: (m) => warnings.push(m) })).toEqual([]);
		expect(warnings.join(" ")).toMatch(/VAPID key changed/);
	});

	it("写不进去时返回旧列表而不抛（启动路径不能因为磁盘问题崩）", () => {
		const dir = tempDataDir();
		// 父级是普通文件 → mkdir 必然 ENOTDIR → 写入失败
		writeFileSync(join(dir, "blocker"), "x", "utf8");
		const warnings: string[] = [];
		let stored: PushSubscriptionRecord[] = [{ ...record(0) }];
		expect(() => {
			stored = replacePushSubscription(dir + "/blocker/nested", record(1), { warn: (m) => warnings.push(m) });
		}).not.toThrow();
		expect(stored).toEqual([]);
		expect(warnings.join(" ")).toMatch(/could not persist/);
	});
});
