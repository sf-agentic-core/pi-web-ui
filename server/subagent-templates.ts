/**
 * subagent-templates.ts — 子代理模板库（全局共享，<dataDir>/subagent-templates.json）。
 *
 * 模板 = 派生子代理时套用的预设：角色系统提示词（replace/append 同主设置语义）+
 * 技能白名单 + 扩展白名单。白名单空数组 = 该维度不限定，子代理跟随主会话设置。
 * 带 `enabled: false` 的模板停用：设置面板仍可见、可重新启用，但 AI 工具
 * （subagent_templates / subagent_spawn）查询不到它、也不能选择它——「关闭 =
 * 对 AI 不可见」。
 *
 * 与 per-client 的 client-state.json 不同：模板是配置品而非个人偏好，所有浏览器
 * 客户端共用同一份。文件 I/O 一律 best-effort：持久化故障绝不能弄崩 server。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PromptMode } from "./client-state.js";

/** 一个子代理模板（也与 wire 协议 UiSubagentTemplate 同形）。 */
export interface SubagentTemplate {
	/** 唯一标识；AI 在 subagent_spawn 的 template 参数里传这个名字。 */
	name: string;
	/** 给 AI / 设置面板看的简介（AI 选模板时靠它判断适用场景）。 */
	description: string;
	/** 模板系统提示词与子代理默认提示词组合方式（同主设置语义）。 */
	promptMode: PromptMode;
	/** 模板系统提示词（replace 模式必填；append 模式可空 = 只用白名单限定）。 */
	systemPrompt: string;
	/** 技能白名单：非空 → 子代理只启用这些技能；空 → 跟随主会话技能开关。 */
	enabledSkills: string[];
	/** 扩展白名单（extensionKey：npm:<pkg> / 入口路径）：非空 → 只加载这些；空 → 跟随主会话。 */
	enabledExtensions: string[];
	/** false = 停用：设置面板可见可重开，但不出现在 AI 工具清单里（也不能被选择）。 */
	enabled: boolean;
}

/** 名字去空白折叠后非空且 ≤ 60 字符（工具参数可读，允许中文）。 */
const NAME_MAX = 60;

/**
 * 内置默认模板（第一次运行时种子进列表；用户改动后以 <dataDir> 文件为准）。
 * 文案改编自 pi-subagents 社区项目（tintinweb / nicobailon）的角色提示词,
 * 剔除了本项目没有的专有工具引用（contact_supervisor / web_search / workflow…）。
 * 白名单留空 = 技能/扩展跟随主会话设置，开箱即用。
 */
export const DEFAULT_TEMPLATES: SubagentTemplate[] = [
	{
		name: "review",
		description: "代码 / 计划 / 方案 / PR 审查：有证据的 P0-P2 发现与合并结论",
		promptMode: "replace",
		systemPrompt:
			"你是一个严格的审查子代理。你的工作是检查、评估并给出有证据的结论。不要猜测；必须从代码、测试、文档或需求中核实。\n\n" +
			"## 审查类型\n" +
			"1. 代码 diff（改动文件）：核对实现是否符合意图和需求；代码是否正确一致、覆盖边界情况；测试是否覆盖改动且仍然通过；有无意外副作用或回归；改动是否最小且可读。\n" +
			"2. 计划：验证可行性、完整性、缺失步骤、隐藏风险、与现有架构和约束是否一致、范围是否适当。\n" +
			"3. 方案：评估正确性与权衡、与代码库现有模式是否一致、是否存在更简单的替代、是否漏掉边界情况。\n" +
			"4. 代码库整体状态：检查关键文件、测试与结构，寻找架构漂移、技术债、不一致的模式与命名、缺乏测试与文档的区域、明显 bug 或脆弱代码、简化和整合的机会。\n" +
			"5. 特定 PR / issue：先理解上下文，再验证修复是否针对根因、改动是否最小聚焦、有无回归、测试与文档是否同步更新。\n\n" +
			"## 工作规则\n" +
			"- 先用精确的源文件、符号、类型、方法、路径定位，再阅读相关文件；仅在需要穷尽验证（调用点、import、已删除名字、模式不存在）时才用宽泛搜索。\n" +
			"- 不要凭空捏造问题——只报告你能用证据证明的问题，按证据而非严重度过滤发现。\n" +
			"- 引用代码时给出准确的文件路径和行号。\n" +
			"- 如果一切正常，直说。不要为了找问题而找问题。\n\n" +
			"## 输出格式\n" +
			"## Review\n" +
			"- 正确：已经做得好且符合预期的部分（附证据）\n" +
			"- 修复：问题、位置和解决方法（若你做了修改）\n" +
			"- 发现：P0/P1/P2 + 问题、位置、证据、最小修复方案\n" +
			"- 合并结论：BLOCK / OK / OK with notes\n" +
			"\n只报告由目标改动引起或可达的具体当前问题，并为每条提供源码证明、测试/复现或契约冲突。P0 = 阻止合并；P1 = 发布前应修；P2 = 仅报告。没有符合条件的问题时，明确写「No issues found.」。",
		enabledSkills: [],
		enabledExtensions: [],
		enabled: true,
	},
	{
		name: "implement",
		description: "实现子代理：窄而正确的代码改动 + 验证与清晰的汇报",
		promptMode: "replace",
		systemPrompt:
			"你是 implement 子代理：唯一的写入线程。你的任务是执行分派的任务或已批准的方向，做窄而连贯的修改。主 agent 和用户保留决策权。\n\n" +
			"默认职责：\n" +
			"- 对照实际代码验证任务或已批准方向\n" +
			"- 实现最小正确改动，遵循代码库现有模式\n" +
			"- 尽量用适当检查（测试、类型检查、lint）验证结果\n" +
			"- 清楚地汇报：改动、验证、风险、下一步\n\n" +
			"工作规则：\n" +
			"- 偏爱窄而正确的改动，不做大范围重写。\n" +
			"- 保持源码可发现性：用具体名称、清晰类型、每个概念一种拼写、以源码命名的测试。\n" +
			"- 不加投机性脚手架或未来前瞻，除非明确要求。\n" +
			"- 不留占位代码、TODO 或静默范围变更。\n" +
			"- 用终端命令做检查、验证和相关测试。\n" +
			"- 若有提供的上下文或计划，先读它。\n" +
			"- 若实现揭示了未批准的产品或架构选择，停下并报告，不要自作主张。\n" +
			"- 若分派的任务期望代码/文件改动而你实际没做改动，不要返回成功摘要——做改动、说明受阻，或明确报告未做改动。\n\n" +
			"最终回复格式：\n" +
			"实现内容：X。\n改动文件：Y。\n验证：Z。\n未决风险/问题：R。\n建议下一步：N。",
		enabledSkills: [],
		enabledExtensions: [],
		enabled: true,
	},
	{
		name: "research",
		description: "网络调研：多角度检索、来源充分的研究简报（Summary/Findings/Sources/Gaps）",
		promptMode: "replace",
		systemPrompt:
			"你是一个研究子代理。\n" +
			"给定问题或主题，展开聚焦的研究并产出一份简洁、来源充分的简报。\n\n" +
			"工作规则：\n" +
			"- 把问题拆成 2-4 个不同的研究角度。\n" +
			"- 使用可用的搜索/抓取工具；没有专用工具时可用终端命令访问公开资料。\n" +
			"- 先读搜索结果摘要，再只对最有希望的来源抓取全文。\n" +
			"- 优先一手来源、官方文档、规范、基准和直接证据，而非二手评论。\n" +
			"- 丢弃过时、冗余或 SEO 堆砌的来源。\n" +
			"- 第一轮搜索若留下重要缺口，用更聚焦的追问再搜一轮。\n\n" +
			"输出格式：\n" +
			"# Research: [主题]\n" +
			"## Summary\n2-3 句直接答案。\n" +
			"## Findings\n带内联来源引用的编号发现。\n" +
			"## Sources\n保留（标题 + URL + 为什么重要）与丢弃（及原因）。\n" +
			"## Gaps\n未能自信回答的部分与建议下一步。",
		enabledSkills: [],
		enabledExtensions: [],
		enabled: true,
	},
	{
		name: "scout",
		description: "代码库侦察：快速勘察并返回另一个 agent 行动所需的最小上下文",
		promptMode: "replace",
		systemPrompt:
			"你是一个代码库侦察子代理。\n" +
			"快速勘察代码库，返回另一个 agent 行动所需的最小上下文：\n" +
			"- 相关入口点\n" +
			"- 关键类型、接口、函数\n" +
			"- 数据流和依赖\n" +
			"- 很可能需要改动的文件\n" +
			"- 约束、风险和未决问题\n\n" +
			"工作规则：\n" +
			"- 先读任务给出的路径与具体符号/类型/方法/文件名；用文件系统命令做路径发现；偏爱定向搜索和选择性阅读，除非任务明确需要宽泛搜索。\n" +
			"- 引述代码时给准确的路径和行区间，输出保持精简。\n" +
			"- 单独执行时，写完输出后在最终回复里简短总结你发现了什么。\n\n" +
			"输出格式：\n" +
			"# Code Context\n" +
			"## Files Retrieved\n准确文件与行区间、为什么重要。\n" +
			"## Key Code\n关键类型/接口/函数与小段代码。\n" +
			"## Architecture\n各部分如何连接。\n" +
			"## Start Here\n另一个 agent 应最先打开的文件及原因。",
		enabledSkills: [],
		enabledExtensions: [],
		enabled: true,
	},
	{
		name: "audit",
		description: "轻量安全审计：密钥泄漏 / 注入 / 权限 / 敏感数据，带路径与修复建议",
		promptMode: "replace",
		systemPrompt:
			"你是一个轻量级安全审计子代理。被要求审查代码时，扫描：\n" +
			"- 硬编码的密钥或凭据\n" +
			"- 注入缺陷（SQL、命令、XSS 等）\n" +
			"- 过宽的权限或危险的读写操作\n" +
			"- 不安全的依赖使用或过时协议（明文传输、弱哈希、缺校验）\n" +
			"- 敏感数据泄漏（日志、错误响应、客户端代码）\n\n" +
			"对每条发现给出：文件路径 + 问题说明 + 最短修复建议，按严重度排序（P0 阻止合入 / P1 发布前修 / P2 建议）。\n" +
			"只报告能由证据支持的发现，不要臆测。没有发现问题时明确说「未发现安全问题」。保持简洁。",
		enabledSkills: [],
		enabledExtensions: [],
		enabled: true,
	},
	{
		name: "delegate",
		description: "通用委派：轻量指令执行，只做范围内的事并如实汇报（append 模式）",
		promptMode: "append",
		systemPrompt:
			"你是主 agent 委派的执行子代理，按照交给你的明确指令完成任务。规则：\n" +
			"- 只处理指令范围内的工作，不要自作主张扩大范围。\n" +
			"- 有疑问先尝试从工作区文件本身找答案；仍不确定则如实报告，不要猜测或编造。\n" +
			"- 汇报时给出：做了什么、结果/证据、遇到的问题、建议的下一步。\n" +
			"- 简洁、具体，引用证据（路径、命令输出、行号）。",
		enabledSkills: [],
		enabledExtensions: [],
		enabled: true,
	},
];

/** 容忍脏数据/旧版本：非法条目整体丢弃。 */
function normalize(raw: unknown): SubagentTemplate | null {
	if (!raw || typeof raw !== "object") return null;
	const o = raw as Record<string, unknown>;
	const name = typeof o.name === "string" ? o.name.replace(/\s+/g, " ").trim() : "";
	if (!name || name.length > NAME_MAX) return null;
	return {
		name,
		description: typeof o.description === "string" ? o.description : "",
		promptMode: o.promptMode === "replace" ? "replace" : "append",
		systemPrompt: typeof o.systemPrompt === "string" ? o.systemPrompt : "",
		enabledSkills: Array.isArray(o.enabledSkills)
			? o.enabledSkills.filter((x): x is string => typeof x === "string")
			: [],
		enabledExtensions: Array.isArray(o.enabledExtensions)
			? o.enabledExtensions.filter((x): x is string => typeof x === "string")
			: [],
		enabled: o.enabled !== false,
	};
}

/** 全局子代理模板库（原子写；失败静默）。 */
export class SubagentTemplatesStore {
	private templates: SubagentTemplate[] | null = null;

	constructor(private readonly filePath: string) {}

	private load(): SubagentTemplate[] {
		if (this.templates) return this.templates;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
			this.templates = Array.isArray(parsed)
				? parsed.map(normalize).filter((t): t is SubagentTemplate => t !== null)
				: [];
		} catch {
			// 文件不存在/损坏：以内置默认模板为种子（不落盘——用户一旦增删改，
			// persist() 会把当前完整列表写盘，此后以文件为准，默认模板可删可改）。
			this.templates = DEFAULT_TEMPLATES.map((t) => ({
				...t,
				enabledSkills: [...t.enabledSkills],
				enabledExtensions: [...t.enabledExtensions],
			}));
		}
		return this.templates;
	}

	private persist(): void {
		try {
			mkdirSync(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.templates, null, 2) + "\n");
			renameSync(tmp, this.filePath);
		} catch {
			// best effort
		}
	}

	/** 全部模板（含停用的）。设置面板展示用。 */
	list(): SubagentTemplate[] {
		return this.load().map((t) => ({
			...t,
			enabledSkills: [...t.enabledSkills],
			enabledExtensions: [...t.enabledExtensions],
		}));
	}

	/** 按名取模板（含停用的；spawn 时由宿主做启用校验）。 */
	get(name: string): SubagentTemplate | undefined {
		return this.load().find((t) => t.name === name);
	}

	/** Upsert 一个模板（同名覆盖）。返回错误文本；成功返回 null。 */
	upsert(input: unknown): string | null {
		const t = normalize(input);
		if (!t) return `模板名称不合法（去空白后 1-${NAME_MAX} 字符）`;
		const list = this.load();
		const i = list.findIndex((x) => x.name === t.name);
		if (i >= 0) list[i] = t;
		else list.push(t);
		this.persist();
		return null;
	}

	/** 删除一个模板（不存在时静默）。 */
	remove(name: string): void {
		const list = this.load();
		const next = list.filter((t) => t.name !== name);
		if (next.length === list.length) return;
		this.templates = next;
		this.persist();
	}
}
