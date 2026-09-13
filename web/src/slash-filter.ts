/**
 * slash 命令的候选匹配 —— 纯函数、零依赖（可被 tsconfig.tests.json 单测）。
 *
 * 目录里的 skill 条目名是 `skill:<目录名>`（`server/slash-commands.ts` 里拼的
 * `` `skill:${skill.name}` ``），而用户实际习惯直接敲 skill 名。这里让 skill 条目
 * 同时用「完整名」与「去掉 `skill:` 的裸名」参与匹配：
 *   - 敲 `/review` 能列出并补全 `skill:review`（此前直接空匹配 → 菜单连消失）；
 *   - 补全插入的仍是 `/skill:review `——SDK 只展开 `startsWith("/skill:")` 的调用，
 *     所以裸名只解决「找得到」，不改变调用形态，也不动服务端协议。
 *
 * 只放宽 skill：扩展命令的 `new:2` 是重名去冲突后缀、插件名可能自带命名空间，
 * 它们的裸名没有「必须显式写前缀才能调用」的语义，不该跟着放宽。
 */

/** skill 命令在目录里的命名空间前缀。 */
export const SKILL_NAMESPACE = "skill:";

/** 一条命令参与匹配的候选串（均为小写）。非 skill 命令只有它自己的名字。 */
export function slashCandidates(name: string, source: string): string[] {
	const full = name.toLowerCase();
	if (source === "skill" && full.startsWith(SKILL_NAMESPACE)) {
		return [full, full.slice(SKILL_NAMESPACE.length)];
	}
	return [full];
}

/**
 * 按已输入的 `prefix`（`/` 之后、首个空格之前的那段）过滤候选，保持目录原顺序。
 *
 * 对 skill 条目：`revi` / `review` / `skill:review` 都能命中 `skill:review`。
 * `prefix` 为空即返回全部（组件用「结果为空」来决定收起菜单，所以这里必须返回
 * 新数组，不能用惰性视图）。
 */
export function filterSlashCommands<T extends { name: string; source: string }>(
	commands: readonly T[],
	prefix: string,
): T[] {
	const query = prefix.toLowerCase();
	if (!query) return [...commands];
	return commands.filter((c) => slashCandidates(c.name, c.source).some((n) => n.startsWith(query)));
}
