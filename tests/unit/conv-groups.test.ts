/**
 * 左栏「运行的对话」分组（#140 的回归）：当前项目那组不显示组标题（项目名）。
 *
 * 关键回归：`set_cwd` / 跨项目切对话时，`conversations` 推送先到（activeId 已是
 * 新对话），带新 cwd 的快照后到 —— 中间那一帧只按 cwd 判定会把当前项目当成
 * 「别的项目」，顶上闪一下项目名再消失。含当前对话的组必须直接算当前项目。
 */
import { describe, expect, it } from "vitest";
import { groupConversations } from "../../web/src/conv-groups.js";
import type { ConversationSummary } from "../../web/src/types.js";

const conv = (id: string, cwd: string, extra: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id,
	title: id,
	cwd,
	messageCount: 1,
	isStreaming: false,
	isSubagent: false,
	...extra,
});

const A = "C:/proj/a";
const B = "C:/proj/b";

describe("groupConversations", () => {
	it("按 cwd 分组，当前项目排最前并标记 isCurrent", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], B, "c2");
		expect(groups.map((g) => g.cwd)).toEqual([B, A]);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("cwd 还没跟上、但 activeId 已在目标项目时，当前项目以 activeId 为准", () => {
		// 切到 B 的那一帧：客户端 cwd 还是 A，列表里 active 已经是 B 的对话。
		// 当前项目只能有一个（B）：A 那组是别的项目的后台运行，标题照旧显示。
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c2");
		expect(groups[0].cwd).toBe(B);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].cwd).toBe(A);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("只有一个项目时（切过去只有一条对话）也认 activeId", () => {
		const groups = groupConversations([conv("c9", A)], B, "c9");
		expect(groups).toHaveLength(1);
		expect(groups[0].isCurrent).toBe(true);
	});

	it("activeId 不在列表里（空白新对话）时只按 cwd 判定", () => {
		const groups = groupConversations([conv("c1", A), conv("c2", B)], A, "c-blank");
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].isCurrent).toBe(true);
		expect(groups[1].isCurrent).toBe(false);
	});

	it("子代理挂在父对话的项目下（即使自己 cwd 不同）", () => {
		const groups = groupConversations([conv("p", A), conv("s", B, { isSubagent: true, parentId: "p" })], B, "s");
		expect(groups).toHaveLength(1);
		expect(groups[0].cwd).toBe(A);
		expect(groups[0].convs.map((c) => c.id)).toEqual(["p", "s"]);
		// 父组是当前项目（其中就有当前对话），所以不显示组标题
		expect(groups[0].isCurrent).toBe(true);
	});

	it("空列表 → 空分组", () => {
		expect(groupConversations([], A, "")).toEqual([]);
	});
});
