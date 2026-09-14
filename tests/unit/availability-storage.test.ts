// @vitest-environment jsdom
/**
 * 可用性播报的**持久化**部分（web/src/availability.ts）——需要真实 localStorage，
 * 所以这个文件跑在 jsdom 里（其余版本的判定在 availability.test.ts，纯 node）。
 *
 * 为什么值得单独测：这条持久化的「上次看到的版本」正是「普通刷新不要响」这条
 * 规则的唯一依据。它如果坏了，表现不是崩溃，而是**每次 F5 都响一声** —— 用户
 * 关掉这个功能之后就再也不会打开了。而 storage 在 private mode / 满了 时会抛，
 * 那些路径必须静默降级。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { LAST_SEEN_VERSION_KEY, loadLastSeenVersion, saveLastSeenVersion } from "../../web/src/availability.js";

beforeEach(() => {
	localStorage.clear();
});

describe("last-seen version (localStorage real)", () => {
	it("保存后能读回", () => {
		saveLastSeenVersion("0.85.1");
		expect(loadLastSeenVersion()).toBe("0.85.1");
	});

	it("空值不覆盖已存的版本", () => {
		// 服务端没报 appVersion 时不能把上次的版本抹掉，否则下一次 ready 会被
		// 误判成「首次访问」而哑掉，或者更糟：被误判成「更新了」而乱报。
		saveLastSeenVersion("0.85.1");
		saveLastSeenVersion("");
		saveLastSeenVersion("   ");
		expect(loadLastSeenVersion()).toBe("0.85.1");
	});

	it("两侧空白会被裁掉", () => {
		saveLastSeenVersion("  0.85.1  ");
		expect(loadLastSeenVersion()).toBe("0.85.1");
	});

	it("没有记录时读回空串（首次访问）", () => {
		expect(loadLastSeenVersion()).toBe("");
	});

	it("存储键名是稳定契约（改名 = 所有浏览器都当自己是首次访问）", () => {
		saveLastSeenVersion("0.85.1");
		expect(localStorage.getItem("pi-web-ui:app-version")).toBe("0.85.1");
		expect(LAST_SEEN_VERSION_KEY).toBe("pi-web-ui:app-version");
	});

	it("写入失败不抛（storage 不可用时静默降级）", () => {
		const original = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem");
		Object.defineProperty(Storage.prototype, "setItem", {
			configurable: true,
			value: () => {
				throw new Error("QuotaExceededError");
			},
		});
		try {
			expect(() => saveLastSeenVersion("0.85.1")).not.toThrow();
		} finally {
			if (original) Object.defineProperty(Storage.prototype, "setItem", original);
		}
	});
});
