/**
 * 左栏「运行的对话」的分组（跨项目）：当前项目排最前、不显示组标题（项目名），
 * 其余项目按路径稳定排序并挂上组标题。
 *
 * 抽成纯函数是为了那个「切项目时项目名闪一下」的坑（#140 的回归），有单测：
 * `tests/unit/conv-groups.test.ts`。
 */
import type { ConversationSummary } from "./types";

export interface ConvGroup {
	cwd: string;
	isCurrent: boolean;
	convs: ConversationSummary[];
}

/**
 * Group the (now cross-project) running-conversation list by workspace,
 * current project first, others in stable path order. Lets the left panel
 * disambiguate same-titled chats across projects and shows where each
 * background run lives.
 *
 * 「当前项目」取哪个信号：`set_cwd` / 跨项目切对话时，服务端先推 `conversations`
 * （activeId 已经是新项目的对话），带新 `cwd` 的快照随后才到 —— 两个信号不同时
 * 到达。所以**只要当前对话在列表里，就认它所在的分组为当前项目**（唯一），
 * `currentCwd` 只作为它不在列表里时（空白新对话）的回落。只按 `cwd` 判定的那一
 * 帧会把当前项目当成「别的项目」，于是它顶上闪一下项目名再消失（实测约 8ms 一帧，
 * 正是用户看到的那一跳）；同一组立即置顶，也免掉了随后的位置跳动。
 */
export function groupConversations(
	list: ConversationSummary[],
	currentCwd: string,
	activeConversationId: string,
): ConvGroup[] {
	const byId = new Map(list.map((c) => [c.id, c]));
	/** 分组归属：子对话（即使自己 cwd 不同）跟着父对话的项目走。 */
	const groupCwdOf = (c: ConversationSummary): string => (c.parentId ? (byId.get(c.parentId)?.cwd ?? c.cwd) : c.cwd);
	const activeConv = list.find((c) => c.id === activeConversationId);
	const effectiveCwd = activeConv ? groupCwdOf(activeConv) : currentCwd;

	const byCwd = new Map<string, ConversationSummary[]>();
	for (const c of list) {
		const groupCwd = groupCwdOf(c);
		const arr = byCwd.get(groupCwd) ?? [];
		arr.push(c);
		byCwd.set(groupCwd, arr);
	}
	const groups: ConvGroup[] = [...byCwd.entries()].map(([cwd, convs]) => ({
		cwd,
		isCurrent: cwd === effectiveCwd,
		convs,
	}));
	groups.sort((a, b) => (a.isCurrent ? -1 : b.isCurrent ? 1 : a.cwd < b.cwd ? -1 : a.cwd > b.cwd ? 1 : 0));
	return groups;
}
