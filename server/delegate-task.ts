/**
 * delegate_task —— 结构化派单工具（oh-my-pi 委派协议的代码级硬化）。
 *
 * 背景：单纯靠提示词要求模型“派单写详细”是没有强制力的——模型糊弄也不会有
 * 任何后果。本工具把六段式派单格式写进参数 schema + 服务端校验：缺段/太短/
 * 模板不可用直接报错打回（错误文本留在上下文里，模型补全后重试）。
 *
 * 与 subagent_spawn 的关系：并存。subagent_spawn 是通用自由派单；delegate_task
 * 是走 specialist 模板的结构化派单（agent 必填且必须是启用的模板）。执行体复用
 * 同一条 spawn 通道（SubagentToolHost.spawnSubagent）：真子代理会话、白名单、
 * 模型优先级、左栏徽标、等待/改向/停止全套机制都不用重写。
 *
 * 纯函数（validateDelegation / buildDelegationPrompt）可单测；语言按 ServerLang
 * 切中英（section 头固定英文——子代理侧各模板早已习惯英文段头；面向派单者的
 * 错误文本走 pick，key 缺失时自动回落英文，见 server/i18n.ts）。
 */
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bilingual, pick, type ServerLang } from "./i18n.js";
import { subagentTitle, type SubagentToolHost } from "./subagents.js";

/** 工具名（前端 ToolCallBlock 派单卡片靠它识别；改名需同步改前端）。 */
export const DELEGATE_TOOL_NAME = "delegate_task";

/** 各段最小长度（trim 后字符数）：TASK 必须具体，OUTCOME 必须可验收，其余段不许空着。 */
const MIN_TASK = 20;
const MIN_OUTCOME = 10;

/** 六段的固定英文名（校验报错与拼装 prompt 共用，子代理侧无需翻译）。 */
const SECTIONS = ["TASK", "EXPECTED OUTCOME", "REQUIRED TOOLS", "MUST DO", "MUST NOT DO", "CONTEXT"] as const;

/** 归一化后的派单输入（执行前把脏参数洗成字符串；非字符串一律按缺失处理）。 */
export interface DelegationInput {
	agent: string;
	task: string;
	expected_outcome: string;
	required_tools: string;
	must_do: string;
	must_not_do: string;
	context: string;
	model?: string;
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** 把模型传进来的脏参数归一化（缺字段/错类型不抛错，交给校验报错）。 */
export function normalizeDelegation(params: unknown): DelegationInput {
	const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
	return {
		agent: str(p.agent).trim(),
		task: str(p.task),
		expected_outcome: str(p.expected_outcome),
		required_tools: str(p.required_tools),
		must_do: str(p.must_do),
		must_not_do: str(p.must_not_do),
		context: str(p.context),
		model: str(p.model).trim() || undefined,
	};
}

/**
 * 校验派单输入；通过返回 null，否则返回直接回给模型的错误文本（已按 lang 选好语言）。
 * `usableNames` = 当前可用模板名（host.listTemplates()，只含 enabled 的）。
 */
export function validateDelegation(
	input: DelegationInput,
	usableNames: string[],
	lang: ServerLang = "en",
): string | null {
	if (!input.agent || !usableNames.includes(input.agent)) {
		const shown = usableNames.slice(0, 12).join(" · ") + (usableNames.length > 12 ? " · …" : "");
		return pick(
			lang,
			`派单被驳回：模板 "${input.agent || "(空)"}" 不可用（不存在或已停用）。可用模板：${shown || "(无)"}。用 subagent_templates 查简介再选；不要编造模板名。`,
			`Delegation rejected: template "${input.agent || "(empty)"}" is unavailable (missing or disabled). Available templates: ${shown || "(none)"}. Use subagent_templates for descriptions; do not invent template names.`,
			"delegate.validate.agent",
			{ agent: input.agent, available: shown },
		);
	}
	const checks: { section: (typeof SECTIONS)[number]; text: string; min: number }[] = [
		{ section: "TASK", text: input.task, min: MIN_TASK },
		{ section: "EXPECTED OUTCOME", text: input.expected_outcome, min: MIN_OUTCOME },
		{ section: "REQUIRED TOOLS", text: input.required_tools, min: 1 },
		{ section: "MUST DO", text: input.must_do, min: 1 },
		{ section: "MUST NOT DO", text: input.must_not_do, min: 1 },
		{ section: "CONTEXT", text: input.context, min: 1 },
	];
	for (const c of checks) {
		if (c.text.trim().length < c.min) {
			return pick(
				lang,
				`派单被驳回：${c.section} 段太短（至少 ${c.min} 字，当前 ${c.text.trim().length} 字）。六段缺一不可、含糊不得：补全后重试，不要改用 subagent_spawn 绕过校验。`,
				`Delegation rejected: section ${c.section} is too short (minimum ${c.min} chars, got ${c.text.trim().length}). All six sections are mandatory and vague prompts fail: complete it and retry; do not bypass validation via subagent_spawn.`,
				"delegate.validate.short",
				{ section: c.section, min: c.min },
			);
		}
	}
	return null;
}

/** 拼装发给子代理的标准六段 prompt（段头固定英文；收尾一行为汇报纪律）。 */
export function buildDelegationPrompt(input: DelegationInput, lang: ServerLang = "en"): string {
	const firstLine = input.task.split("\n")[0]?.trim().slice(0, 80) || input.agent;
	const closer =
		lang === "zh"
			? "汇报要简洁：做了什么、证据（路径/行号/输出）、遇到的问题、下一步建议。不扩大范围。"
			: "Report back concisely: what was done, evidence (paths/line numbers/output), problems, suggested next steps. Do not expand scope.";
	return [
		`# ${input.agent}: ${firstLine}`,
		``,
		`## TASK`,
		input.task.trim(),
		``,
		`## EXPECTED OUTCOME`,
		input.expected_outcome.trim(),
		``,
		`## REQUIRED TOOLS`,
		input.required_tools.trim(),
		``,
		`## MUST DO`,
		input.must_do.trim(),
		``,
		`## MUST NOT DO`,
		input.must_not_do.trim(),
		``,
		`## CONTEXT`,
		input.context.trim(),
		``,
		`---`,
		closer,
	].join("\n");
}

const delegateSchema = Type.Object({
	agent: Type.String({
		description: bilingual(
			"Specialist template to delegate to (e.g. oracle, metis, momus, explore, librarian, sisyphus-junior, multimodal-looker, review). Must be an enabled template — use subagent_templates to see descriptions and pick the domain match.",
			"派单的目标 specialist 模板（如 oracle、metis、momus、explore、librarian、sisyphus-junior、multimodal-looker、review）。必须是启用的模板——先用 subagent_templates 看简介、按任务领域匹配。",
		),
	}),
	task: Type.String({
		description: bilingual(
			"Atomic, specific goal: ONE action per delegation (minimum 20 chars). Vague tasks are rejected.",
			"原子化具体目标：一次派单只做一件事（至少 20 字）。含糊的任务会被驳回。",
		),
	}),
	expected_outcome: Type.String({
		description: bilingual(
			"Concrete deliverables with done criteria: what does success look like (minimum 10 chars).",
			"具体交付物 + 完成标准：什么样算做完（至少 10 字）。",
		),
	}),
	required_tools: Type.String({
		description: bilingual(
			"Explicit tool whitelist for the subagent (prevents tool sprawl).",
			"子代理可用工具白名单（防工具乱用）。",
		),
	}),
	must_do: Type.String({
		description: bilingual("Exhaustive requirements — leave NOTHING implicit.", "必须做的要求——写尽，不要留隐含项。"),
	}),
	must_not_do: Type.String({
		description: bilingual("Forbidden actions — anticipate and block rogue behavior.", "禁止事项——预判并堵住乱发挥。"),
	}),
	context: Type.String({
		description: bilingual(
			"File paths, existing patterns, constraints the subagent must know.",
			"子代理必须知道的文件路径、既有模式、约束。",
		),
	}),
	model: Type.Optional(
		Type.String({
			description: bilingual(
				'Optional model "provider/id" for this delegation; omit = template model → panel default → follow the main conversation model.',
				"可选：本次派单的子代理模型（provider/id）；不传 = 模板模型 → 面板默认 → 跟随主对话模型。",
			),
		}),
	),
});

/** 结构化派单工具：校验六段 → 拼装标准 prompt → 走 host.spawnSubagent 真子代理。 */
export function makeDelegateTaskTool(host: SubagentToolHost, lang?: () => ServerLang): ToolDefinition {
	const getLang: () => ServerLang = lang ?? host.lang ?? (() => "en");
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return defineTool({
		name: DELEGATE_TOOL_NAME,
		label: "Delegate task",
		description: bilingual(
			"Delegate ONE well-defined task to a specialist subagent template with a structured six-section brief " +
				"(TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT). The brief is validated " +
				"server-side: missing or vague sections are rejected with an error, so fill every section concretely. " +
				"Prefer this over subagent_spawn when the work fits a specialist template. The delegation spawns a real " +
				"subagent conversation (visible in the left running list); use subagent_wait_all / subagent_get_result to " +
				"collect results, subagent_steer to redirect, subagent_stop to stop. For follow-ups continue the SAME " +
				"subagent session instead of delegating again.",
			"把一个定义清楚的任务派给 specialist 子代理模板，派单文本是结构化六段 " +
				"（TASK / EXPECTED OUTCOME / REQUIRED TOOLS / MUST DO / MUST NOT DO / CONTEXT）。六段在服务端校验：" +
				"缺段或含糊直接报错打回，所以每段都要写实在。任务适合 specialist 模板时优先用它而不是 subagent_spawn。" +
				"派单会启动真实子代理会话（左栏运行列表可见）；用 subagent_wait_all / subagent_get_result 收结果、" +
				"subagent_steer 改向、subagent_stop 停止。追问要在同一子代理会话里继续，不要重复派单。",
		),
		promptSnippet: bilingual(
			"Delegate a well-defined task to a specialist template with a validated six-section brief",
			"把定义清楚的任务派给 specialist 模板，六段派单文本带服务端校验",
		),
		promptGuidelines: [
			bilingual(
				"Prefer delegate_task over subagent_spawn when the work matches a specialist template's domain",
				"任务落在 specialist 模板领域内时，优先用 delegate_task 而不是 subagent_spawn",
			),
			bilingual(
				"Before delegating, declare which template you chose and WHY its description matches the task",
				"派单前先声明选了哪个模板、它的简介与任务哪里匹配",
			),
			bilingual(
				"After delegation ALWAYS verify the result: does it work, does it follow codebase patterns, did it respect MUST DO / MUST NOT DO",
				"拿到派单结果必须验证：能跑吗、符合代码库模式吗、遵守 MUST DO / MUST NOT DO 了吗",
			),
			bilingual(
				"Never start implementing work that a pending delegated result was asked to decide",
				"已派出去待定的结论回来之前，不准先把相关的实现写了",
			),
		],
		parameters: delegateSchema,
		execute: async (_id, params, _signal, _onUpdate, ctx) => {
			const input = normalizeDelegation(params);
			const usable = host.listTemplates().map((t) => t.name);
			const err = validateDelegation(input, usable, getLang());
			if (err) return text(err, { delegated: false, agent: input.agent });
			const prompt = buildDelegationPrompt(input, getLang());
			const convId = await host.spawnSubagent(prompt, "delegate", ctx.cwd, input.agent, input.model);
			const title = subagentTitle(prompt);
			const modelLineZh = input.model ? `\n模型：${input.model}` : "";
			const modelLineEn = input.model ? `\nModel: ${input.model}` : "";
			return text(
				pick(
					getLang(),
					`已派单：${convId}\n模板：${input.agent} · 标题：${title}${modelLineZh}` +
						`\n子代理已在左栏运行列表中。用 subagent_wait_all 一次等全部完成（不用轮询）、subagent_get_result 取单个结果；` +
						`追问请在同一子代理会话里继续（subagent_steer），不要重复派单。拿到结果后必须验证再汇报。`,
					`Delegated: ${convId}\nTemplate: ${input.agent} · Title: ${title}${modelLineEn}` +
						`\nThe subagent is in the left running list. Use subagent_wait_all to wait for all at once (no polling), ` +
						`subagent_get_result for a single result; continue follow-ups in the SAME subagent session (subagent_steer), ` +
						`do not delegate again. Verify the result before reporting.`,
					"delegate.started",
					{ convId: convId, agent: input.agent, title: title, "input.model": input.model },
				),
				{ convId, agent: input.agent, template: input.agent, model: input.model },
			);
		},
	});
}
