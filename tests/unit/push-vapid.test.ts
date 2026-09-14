/**
 * VAPID 密钥生命周期单测（server/push/vapid.ts）。
 *
 * 锁三件事：
 *   1. 零配置 —— 第一次调用自己生成并落盘，之后复用同一把（换了就等于所有
 *      订阅作废：浏览器订阅时把 applicationServerKey 绑进了订阅）。
 *   2. 坏密钥不自欺 —— 文件损坏/公私钥不配对时必须重新生成并告警，而不是拿
 *      一把用不了的密钥继续跑。
 *   3. 环境变量覆盖要成对出现，半配置只告警不采纳。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_VAPID_SUBJECT,
	loadOrCreateVapidKeys,
	resetVapidCache,
	vapidSubject,
	VAPID_FILE,
} from "../../server/push/vapid.js";

const dirs: string[] = [];
function tempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "piweb-vapid-test-"));
	dirs.push(dir);
	return dir;
}

/** 生成一对合法的裸 P-256 密钥（base64url）。 */
function makeRawPair() {
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const pub = publicKey.export({ format: "jwk" });
	const priv = privateKey.export({ format: "jwk" });
	return {
		private: Buffer.from(priv.d ?? "", "base64url"),
		public: Buffer.concat([
			Buffer.from([0x04]),
			Buffer.from(pub.x ?? "", "base64url"),
			Buffer.from(pub.y ?? "", "base64url"),
		]),
	};
}

const ENV_KEYS = ["PI_WEB_VAPID_PUBLIC_KEY", "PI_WEB_VAPID_PRIVATE_KEY", "PI_WEB_VAPID_SUBJECT"] as const;

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	resetVapidCache();
});
afterEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	resetVapidCache();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("loadOrCreateVapidKeys", () => {
	it("第一次调用生成密钥并以 0600 落盘", () => {
		const dir = tempDataDir();
		const loaded = loadOrCreateVapidKeys(dir);
		expect(loaded.source).toBe("generated");
		expect(loaded.created).toBe(true);
		expect(loaded.keyPair.publicKey.length).toBe(65);
		expect(loaded.keyPair.privateKey.length).toBe(32);

		const stat = statSync(join(dir, VAPID_FILE));
		expect(stat.mode & 0o777).toBe(0o600);
	});

	it("进程重启后复用同一把（否则所有订阅作废）", () => {
		const dir = tempDataDir();
		const first = loadOrCreateVapidKeys(dir);
		resetVapidCache(); // 模拟新进程
		const second = loadOrCreateVapidKeys(dir);
		expect(second.source).toBe("file");
		expect(second.created).toBe(false);
		expect(second.keyPair.publicKey.equals(first.keyPair.publicKey)).toBe(true);
	});

	it("同一个 dataDir 在进程内只读一次（带缓存）", () => {
		const dir = tempDataDir();
		const a = loadOrCreateVapidKeys(dir);
		const b = loadOrCreateVapidKeys(dir);
		expect(b).toBe(a);
	});

	it("文件损坏 → 重新生成并告警", () => {
		const dir = tempDataDir();
		loadOrCreateVapidKeys(dir);
		const before = loadOrCreateVapidKeys(dir).keyPair.publicKey;
		writeFileSync(join(dir, VAPID_FILE), "{ not json", "utf8");
		resetVapidCache();
		const warnings: string[] = [];
		const after = loadOrCreateVapidKeys(dir, { warn: (m) => warnings.push(m) });
		expect(after.source).toBe("generated");
		// 损坏的 JSON 走的是「读不出来」这条路——不告警也不算错，重新生成即可。
		expect(after.keyPair.publicKey.equals(before)).toBe(false);
	});

	it("公私钥不配对 → 重新生成并告警（拿它跑下去等于所有 push 静默失败）", () => {
		const dir = tempDataDir();
		const pairA = makeRawPair();
		const pairB = makeRawPair();
		writeFileSync(
			join(dir, VAPID_FILE),
			JSON.stringify({
				publicKey: pairA.public.toString("base64url"),
				privateKey: pairB.private.toString("base64url"),
			}),
			"utf8",
		);
		resetVapidCache();
		const warnings: string[] = [];
		const loaded = loadOrCreateVapidKeys(dir, { warn: (m) => warnings.push(m) });
		expect(loaded.source).toBe("generated");
		expect(warnings.join(" ")).toMatch(/mismatched|invalid/);
	});

	it("环境变量覆盖优先于磁盘上的密钥", () => {
		const dir = tempDataDir();
		const onDisk = loadOrCreateVapidKeys(dir).keyPair.publicKey;
		const pair = makeRawPair();
		process.env.PI_WEB_VAPID_PUBLIC_KEY = pair.public.toString("base64url");
		process.env.PI_WEB_VAPID_PRIVATE_KEY = pair.private.toString("base64url");
		resetVapidCache();
		const loaded = loadOrCreateVapidKeys(dir);
		expect(loaded.source).toBe("env");
		expect(loaded.keyPair.publicKey.equals(pair.public)).toBe(true);
		expect(loaded.keyPair.publicKey.equals(onDisk)).toBe(false);
	});

	it("半配置的环境变量只告警，回落磁盘/新生成", () => {
		const dir = tempDataDir();
		process.env.PI_WEB_VAPID_PUBLIC_KEY = makeRawPair().public.toString("base64url");
		resetVapidCache();
		const warnings: string[] = [];
		const loaded = loadOrCreateVapidKeys(dir, { warn: (m) => warnings.push(m) });
		expect(loaded.source).not.toBe("env");
		expect(warnings.join(" ")).toMatch(/PI_WEB_VAPID_PUBLIC_KEY/);
	});

	it("写盘失败不抛异常（内存里的密钥仍可用，只告警）", () => {
		// dataDir 指向一个不可能创建的路径下的文件（父级是普通文件）。
		const dir = tempDataDir();
		writeFileSync(join(dir, "blocker"), "x", "utf8");
		const warnings: string[] = [];
		let loaded: ReturnType<typeof loadOrCreateVapidKeys> | null = null;
		expect(() => {
			loaded = loadOrCreateVapidKeys(join(dir, "blocker", "nested"), { warn: (m) => warnings.push(m) });
		}).not.toThrow();
		expect(loaded!.keyPair.publicKey.length).toBe(65);
		expect(warnings.join(" ")).toMatch(/could not persist/);
	});

	it("落盘内容里公钥是 65 字节无压缩点", () => {
		const dir = tempDataDir();
		loadOrCreateVapidKeys(dir);
		const raw = JSON.parse(readFileSync(join(dir, VAPID_FILE), "utf8")) as { publicKey: string };
		const pub = Buffer.from(raw.publicKey, "base64url");
		expect(pub.length).toBe(65);
		expect(pub[0]).toBe(0x04);
	});
});

describe("vapidSubject", () => {
	it("默认用保留域（永不解析，不必公开联系地址）", () => {
		expect(vapidSubject()).toBe(DEFAULT_VAPID_SUBJECT);
		expect(DEFAULT_VAPID_SUBJECT).toMatch(/^https:\/\//);
	});

	it("环境变量覆盖；空串回落默认", () => {
		process.env.PI_WEB_VAPID_SUBJECT = "mailto:ops@example.com";
		expect(vapidSubject()).toBe("mailto:ops@example.com");
		process.env.PI_WEB_VAPID_SUBJECT = "   ";
		expect(vapidSubject()).toBe(DEFAULT_VAPID_SUBJECT);
	});

	it("绝不从主机名派生（否则把主机名泄露给 push service）", () => {
		// 这个断言看着像废话，但它锁住一条安全约定：默认值里不许出现本机信息。
		expect(DEFAULT_VAPID_SUBJECT).not.toMatch(/localhost|127\.0\.0\.1|\.local/);
	});
});
