// ---------------------------------------------------------------------------
// subagents.ts — 第一方轻量子代理：工具定义与运行态模型
// ---------------------------------------------------------------------------
// 架构（相对参考项目的大幅简化）：
//
// 参考项目（tintinweb / nicobailon 的 pi-subagents）把子代理做成「完整子会话」
// —— 独立 SessionManager / SettingsManager / 模型 / 工具隔离 / resume /
// steer / 并发池 / 工作区隔离，复杂度来自「要独立支撑一个完整会话」。
//
// pi-web-ui 的 ClientSession 天生就是多会话并发的：一个 conversation 就有
// 一个独立 AgentSessionRuntime + TerminalManager，所有 conversation 共享
// 同一个 modelRuntime，创建走 createAgentSessionServices + FromServices（已
// 封装好）。因此本模块把子代理定义为：
//
//   子代理 = 一个标记了 isSubagent 的普通 Conversation（inMemory session，
//   不落盘、不进历史/resume 列表）
//   - 出现在左栏「运行的对话」列表，带「子代理」徽标
//   - 用户可以像普通对话一样：点开查看实时消息流、输入补充（= steer）、
//     中止（= abort）、完成后移出（= dismiss）
//   - 运行态经现有快照/消息管线推送，不需要单独的可视化桥
//
// 本文件只定义：运行态快照类型、host 接口（由 ClientSession 实现，操作的是
// 它的 conversation 体系）、以及注册给每个会话的 subagent_* 工具。真正创建
// conversation / 跑 prompt 全部在 agent-service.ts 的 spawnSubagent 里完成。
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 子代理的状态（由 conversation 派生的轻量视图）。 */
export type SubagentState = "running" | "queued" | "done" | "canceled";

/** 单个子代理的运行态快照（供 subagent_list / subagent_get_result 与左栏徽标）。 */
export interface SubagentSnapshot {
	/** conversation id（= 工具的 runId；左栏点击即 switch 到它）。 */
	convId: string;
	/** 展示类型 / 角色（explore / implement / review …，默认 general）。 */
	type: string;
	/** 标题：prompt 首行（截断）。 */
	title: string;
	/** 原始 prompt。 */
	prompt: string;
	state: SubagentState;
	/** 是否正在流式输出。 */
	streaming: boolean;
	/** 会话消息数（近似活动量）。 */
	messageCount: number;
	/** 会话模型 id（可空）。 */
	model?: string;
	/** 已收集的 assistant 最后文本（运行中为最新输出）。 */
	output: string;
}

/**
 * 由 ClientSession 实现的子代理操作接口。所有操作都作用于它的
 * conversation 体系（convs.map 里的 isSubagent 对话）。
 */
export interface SubagentToolHost {
	/** 创建子代理 conversation 并触发 prompt。`templateName` 可选：设置面板配置
	 *  的子代理模板（角色 prompt + 技能/扩展白名单）；不传 = 按主会话默认配置。
	 *  模板不存在/已停用时应抛错（工具把错误转给 AI 而不是启动。）。 */
	spawnSubagent(prompt: string, type: string, cwd: string, templateName?: string): Promise<string>;
	/** 取单个子代理快照（按 convId）。 */
	getSubagent(convId: string): SubagentSnapshot | undefined;
	/** 列出现有的子代理（按创建顺序）。 */
	listSubagents(): SubagentSnapshot[];
	/** 向运行中的子代理注入消息（未在运行的内容直接排队为下一次回合）。 */
	steerSubagent(convId: string, message: string): Promise<void>;
	/** 中止运行中的子代理。 */
	stopSubagent(convId: string): Promise<void>;
	/** 列出可供 AI 选择的子代理模板（名 + 简介）。只含 enabled 的（停用的对 AI 不可见）。 */
	listTemplates(): { name: string; description: string }[];
	/** 检查某个模板名是否可用于派生子代理（存在且 enabled）。 */
	isTemplateUsable(name: string): boolean;
}

/** 从 prompt 取首行作为标题（截断 40 字符）。 */
export function subagentTitle(prompt: string): string {
	const line = prompt.split("\n")[0]?.trim() ?? "";
	return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/**
 * 子代理工具集（注册进每个会话的 customTools，供主 agent 驱动子代理）。
 * 用 `subagent_*` 前缀命名，避免与第三方 pi-subagents 的
 * `Agent`/`get_subagent_result`/`steer_subagent` 冲突。
 */
export function makeSubagentTools(host: SubagentToolHost): ToolDefinition[] {
	const text = (t: string, details: unknown = {}): { content: { type: "text"; text: string }[]; details: unknown } => ({
		content: [{ type: "text", text: t }],
		details,
	});
	return [
		defineTool({
			name: "subagent_spawn",
			label: "Spawn subagent",
			description:
				"在后台启动一个独立的子代理对话，用一个明确的指令去完成一项可独立交付的工作（调研/实现/审查等）。" +
				"子代理会出现在左栏「运行的对话」列表（带子代理标识），用户可点开查看、补充、中止。主 agent 可并行派发多个：" +
				"用 subagent_list 查看运行态、subagent_get_result 取结果、subagent_steer 中途改向、subagent_stop 停止。" +
				"适合：长耗时探索、并行调研、独立子任务委派。可选 template 参数：使用设置面板配置的子代理模板" +
				"（角色系统提示词 + 技能/扩展白名单）；用 subagent_templates 查看可用清单，不传 = 不用模板。",
			promptSnippet: "spawn an independent background subagent for a deliverable task (parallel work)",
			parameters: Type.Object({
				prompt: Type.String({ description: "交给子代理的完整指令（要达成的目标 + 约束 + 期望产出）。" }),
				type: Type.Optional(
					Type.String({ description: "子代理类型/角色名（如 explore/implement/review），用于展示。默认 general。" }),
				),
				template: Type.Optional(
					Type.String({
						description:
							"可选：子代理模板名（设置面板「子代理模板」配置的预设，见 subagent_templates 工具）。" +
							"模板 = 角色系统提示词 + 技能/扩展白名单；不传 = 不使用模板，按主会话默认配置运行。",
					}),
				),
				cwd: Type.Optional(Type.String({ description: "子代理工作目录（相对/绝对）。默认继承主会话工作目录。" })),
			}),
			execute: async (_id, p, _signal, _onUpdate, ctx) => {
				if (p.template && !host.isTemplateUsable(p.template)) {
					return text(
						`子代理模板不可用：${p.template}（不存在或已停用）。用 subagent_templates 查看当前可用模板清单；不传 template 则按默认配置运行。`,
					);
				}
				const convId = await host.spawnSubagent(p.prompt, p.type ?? "general", p.cwd ?? ctx.cwd, p.template);
				return text(
					`子代理已启动（运行列表可见）：${convId}\n类型：${p.type ?? "general"} · 标题：${subagentTitle(p.prompt)}` +
						(p.template ? `\n模板：${p.template}` : "") +
						`\n用 subagent_get_result 取结果，subagent_list 看运行态，subagent_steer 改向，subagent_stop 停止。`,
					{ convId, template: p.template },
				);
			},
		}),
		defineTool({
			name: "subagent_get_result",
			label: "Get subagent result",
			description: "取一个子代理的结果或当前运行态。若尚未完成，返回当前状态与已产出的文本。",
			promptSnippet: "fetch a subagent's result / current progress",
			parameters: Type.Object({
				runId: Type.String({ description: "subagent_spawn 返回的 convId。左栏点击同名对话可直接查看。" }),
			}),
			execute: async (_id, p) => {
				const r = host.getSubagent(p.runId);
				if (!r) return text(`未找到子代理 ${shortId(p.runId)}（可能已移出）。`, undefined);
				if (r.streaming || r.state === "running") {
					return text(
						`子代理 ${shortId(r.convId)}（${r.type}）仍在运行（状态 ${r.state}）。\n当前输出：\n${r.output || "（暂无输出）"}`,
						r,
					);
				}
				return text(`子代理 ${shortId(r.convId)}（${r.type}）状态：${r.state}\n${r.output || "（无结果）"}`, r);
			},
		}),
		defineTool({
			name: "subagent_steer",
			label: "Steer subagent",
			description: "向一个子代理注入一条消息，重定向/补充它的工作方向（等同用户在它的对话里发消息）。",
			promptSnippet: "inject a message into a running subagent to redirect its work",
			parameters: Type.Object({
				runId: Type.String({ description: "目标子代理 convId。" }),
				message: Type.String({ description: "要注入的方向调整/补充信息。" }),
			}),
			execute: async (_id, p) => {
				await host.steerSubagent(p.runId, p.message);
				return text(`已向子代理 ${shortId(p.runId)} 注入消息。`);
			},
		}),
		defineTool({
			name: "subagent_list",
			label: "List subagents",
			description: "列出全部子代理的运行态：convId、类型、状态、标题、消息数。",
			promptSnippet: "list all subagents and their live status",
			parameters: Type.Object({}),
			execute: async () => {
				const list = host.listSubagents();
				if (list.length === 0) return text("当前没有子代理。");
				const lines = list.map((r) => `- ${r.convId} · ${r.type} · ${r.state} · ${r.title}（msg: ${r.messageCount}）`);
				return text(lines.join("\n"));
			},
		}),
		defineTool({
			name: "subagent_stop",
			label: "Stop subagent",
			description: "停止一个运行中的子代理（等同用户在它的对话里点中止）。已完成的不受影响。",
			promptSnippet: "stop a running subagent",
			parameters: Type.Object({ runId: Type.String({ description: "目标子代理 convId。" }) }),
			execute: async (_id, p) => {
				await host.stopSubagent(p.runId);
				return text(`已请求停止子代理 ${shortId(p.runId)}。`);
			},
		}),
		defineTool({
			name: "subagent_templates",
			label: "List subagent templates",
			description:
				"列出设置面板「子代理模板」配置的可用模板（角色系统提示词 + 技能/扩展白名单的组合预设），" +
				"供 subagent_spawn 的 template 参数选用。已停用的模板不会出现在这里。list 为空 = 未配置模板，子代理按默认配置运行。",
			promptSnippet: "list configurable subagent templates (role prompt + skills/extensions whitelist presets)",
			parameters: Type.Object({}),
			execute: async () => {
				const list = host.listTemplates();
				if (list.length === 0) {
					return text("当前没有可用的子代理模板（设置面板 → 子代理模板 添加后可用）。子代理默认按主会话配置运行。");
				}
				const lines = list.map((t) => `- ${t.name}${t.description ? `：${t.description}` : ""}`);
				return text(
					`可用的子代理模板（subagent_spawn 的 template 参数传名字，如 subagent_spawn(template="${list[0]?.name}"))：\n${lines.join("\n")}`,
				);
			},
		}),
	];
}

/** 短 id 前缀（前端展示/日志用）。 */
function shortId(id: string): string {
	return id.slice(0, 8);
}
