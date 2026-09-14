/**
 * 服务可用性播报的纯函数单测（web/src/availability.ts）。
 *
 * 这个功能存在的理由是「部署完了，你可以继续干活了」，所以边界很具体：
 *   - 普通刷新**不能**响（否则每次 F5 都响一声，很快就变成噪音被关掉）；
 *   - 断线期间刷新页面**必须**响 —— 那是用户正等着听一声的场景，而这条新加载
 *     的页面从没见过之前的 ready，只看「重连」会刚好哑掉；
 *   - 版本变了要说清是哪个版本变成哪个版本（update 的确认）。
 * 另外：这套逻辑结构上不可能播报「服务挂了」——那只能来自外部监控，
 * 从掉线的 socket 反推等于每次笔记本休眠/Tailscale 抖动都误报。
 */
import { describe, expect, it } from "vitest";
import {
	decideAvailabilityAnnouncement,
	loadLastSeenVersion,
	saveLastSeenVersion,
	type AvailabilityInput,
} from "../../web/src/availability.js";

/** 默认：从「未就绪」进入「就绪」的重连场景，版本没变。 */
const input = (patch: Partial<AvailabilityInput> = {}): AvailabilityInput => ({
	wasReady: false,
	isReady: true,
	sawReadyBefore: true,
	version: "0.84.0",
	lastSeenVersion: "0.84.0",
	...patch,
});

describe("decideAvailabilityAnnouncement", () => {
	it("同一个 build 回来了 → online", () => {
		expect(decideAvailabilityAnnouncement(input())).toEqual({
			kind: "online",
			version: "0.84.0",
			previousVersion: "0.84.0",
		});
	});

	it("build 变了 → updated，并带上前后版本", () => {
		expect(decideAvailabilityAnnouncement(input({ version: "0.85.0" }))).toEqual({
			kind: "updated",
			version: "0.85.0",
			previousVersion: "0.84.0",
		});
	});

	it("断线期间刷新页面（新页面没见过 ready，但版本变了）→ updated", () => {
		// 这条是「只看重连」会漏掉的场景：用户正等着听一声。
		expect(
			decideAvailabilityAnnouncement(input({ sawReadyBefore: false, version: "0.85.0", lastSeenVersion: "0.84.0" })),
		).toEqual({ kind: "updated", version: "0.85.0", previousVersion: "0.84.0" });
	});

	it("普通刷新（版本没变、也没见过 ready）→ 不响", () => {
		expect(decideAvailabilityAnnouncement(input({ sawReadyBefore: false }))).toBeNull();
	});

	it("首次访问（没有历史版本可对比）→ 不响", () => {
		expect(decideAvailabilityAnnouncement(input({ sawReadyBefore: false, lastSeenVersion: "" }))).toBeNull();
	});

	it("版本未知时不猜「更新了」；但重连仍然报 online", () => {
		expect(decideAvailabilityAnnouncement(input({ version: "" }))).toEqual({
			kind: "online",
			version: "",
			previousVersion: "0.84.0",
		});
		expect(decideAvailabilityAnnouncement(input({ version: "", sawReadyBefore: false }))).toBeNull();
	});

	it("updated 优先于 online（信息更多的那条）", () => {
		const result = decideAvailabilityAnnouncement(input({ sawReadyBefore: true, version: "0.85.0" }));
		expect(result?.kind).toBe("updated");
	});

	it("ready 已经是 true 时不再重复播报（快照会把 ready 反复置回 true）", () => {
		expect(decideAvailabilityAnnouncement(input({ wasReady: true }))).toBeNull();
	});

	it("未就绪 / 掉线方向都不播报", () => {
		expect(decideAvailabilityAnnouncement(input({ isReady: false }))).toBeNull();
		// 掉线：现在 false，之前 true —— 没有任何一条通知（掉线不能由服务自己宣布）
		expect(decideAvailabilityAnnouncement(input({ wasReady: true, isReady: false }))).toBeNull();
	});

	it("版本两侧空白不算变更", () => {
		expect(decideAvailabilityAnnouncement(input({ version: " 0.84.0 ", lastSeenVersion: "0.84.0" }))?.kind).toBe(
			"online",
		);
	});

	it("服务端没报版本、本地也没有 → 只报一次 online，不会误判成 updated", () => {
		expect(decideAvailabilityAnnouncement(input({ version: "", lastSeenVersion: "" }))?.kind).toBe("online");
	});
});

describe("last-seen version storage", () => {
	it("storage 不可用时读回空串、写入不抛（private mode / node 环境）", () => {
		expect(loadLastSeenVersion()).toBe("");
		expect(() => saveLastSeenVersion("0.85.0")).not.toThrow();
		expect(() => saveLastSeenVersion("")).not.toThrow();
	});
});
