import { describe, expect, it } from "vitest";
import { filterSlashCommands, slashCandidates } from "../../web/src/slash-filter.js";

/**
 * slash 候选匹配单测：用户敲裸 skill 名（`/review`）也必须能列出 `skill:review`
 * —— 此前前缀匹配只对着目录名 `skill:review` 做，裸名零匹配会让整个菜单收起。
 */
const COMMANDS = [
	{ name: "reload", source: "builtin" },
	{ name: "resume", source: "builtin" },
	{ name: "review", source: "prompt" },
	{ name: "skill:review", source: "skill" },
	{ name: "skill:tdd", source: "skill" },
	{ name: "page-picker:pick", source: "plugin" },
];

const names = (prefix: string) => filterSlashCommands(COMMANDS, prefix).map((c) => c.name);

describe("filterSlashCommands", () => {
	it("裸 skill 名命中带命名空间的 skill 条目", () => {
		expect(names("review")).toEqual(["review", "skill:review"]);
	});

	it("skill 名的前缀也能命中（同名模板与 skill 并列，按目录顺序）", () => {
		expect(names("revi")).toEqual(["review", "skill:review"]);
	});

	it("带命名空间照旧命中（没破坏原来的输入方式）", () => {
		expect(names("skill:re")).toEqual(["skill:review"]);
	});

	it("大小写不敏感", () => {
		expect(names("REVIEW")).toEqual(["review", "skill:review"]);
	});

	it("保持目录原顺序（内置 → 扩展/模板 → skill → 插件）", () => {
		expect(names("re")).toEqual(["reload", "resume", "review", "skill:review"]);
	});

	it("只放宽 skill：别的命名空间命令不会被裸名命中", () => {
		expect(names("pick")).toEqual([]);
		expect(names("page-picker:pick")).toEqual(["page-picker:pick"]);
	});

	it("空前缀返回全部（组件靠「结果为空」决定是否收起菜单）", () => {
		expect(names("")).toEqual(COMMANDS.map((c) => c.name));
		// 新数组：组件会把它直接塞进 state，不该复用入参引用
		expect(filterSlashCommands(COMMANDS, "")).not.toBe(COMMANDS);
	});

	it("无匹配时返回空数组", () => {
		expect(names("zzz")).toEqual([]);
	});

	it("不改动入参", () => {
		const snapshot = [...COMMANDS];
		filterSlashCommands(COMMANDS, "re");
		expect(COMMANDS).toEqual(snapshot);
	});
});

describe("slashCandidates", () => {
	it("skill 条目同时给出完整名与裸名", () => {
		expect(slashCandidates("skill:review", "skill")).toEqual(["skill:review", "review"]);
	});

	it("非 skill 条目只给出自己的名字", () => {
		expect(slashCandidates("reload", "builtin")).toEqual(["reload"]);
		expect(slashCandidates("page-picker:pick", "plugin")).toEqual(["page-picker:pick"]);
	});

	it("source 不是 skill 时不做前缀剥离", () => {
		expect(slashCandidates("skill:review", "extension")).toEqual(["skill:review"]);
	});
});
