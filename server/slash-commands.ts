/**
 * slash-commands — 斜杠命令目录与内置命令执行，从 agent-service.ts 抽出。
 *
 * 职责：
 *  - NATIVE_COMMANDS：web 服务端原生实现的斜杠命令清单（pi CLI 的交互式内置命令
 *    如 /model /new 不经 SDK prompt()——不拦截会被当普通文本发给模型）
 *  - push()：目录 = 内置命令 + 活动对话的扩展命令 / 提示模板 / 技能（与 SDK
 *    展开行为一致），推 slash_commands 供输入框选择器使用
 *  - exec()：拦截执行内置命令；返回 false 表示非内置命令，prompt 落到 SDK
 *
 * 经 SlashHost 窄接口与 ClientSession 解耦（同 settings-service/goal-service 模式）。
 * UI 文案直接中文（服务端 notice 约定）。/help 与 /copy 是纯客户端动作（不到服务端），
 * 保留在目录里供选择器展示，exec 里吞掉防止 SDK 当文本。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ServerMessage, SlashCommandInfo, UiQuestionOption } from "./protocol.js";
import { loadRecipes, runCliAuth as runCliAuthRecipe } from "./cli-auth.js";
import { installTool, listTools } from "./tool-install.js";
import type { PluginCommandDef } from "./plugins.js";

/** 登录认证方式（与 SDK 的 AuthType 一致）。 */
type AuthKind = "oauth" | "api_key";

/** 一个 provider 的一条登录路径（镜像 TUI 的 getLoginProviderOptions）。
 *  同一 provider 可同时提供 OAuth 与 API key —— 各自是独立的一项。 */
interface LoginProviderOption {
	id: string;
	name: string;
	authType: AuthKind;
	/** 当前保存的凭据是否属于这条路径。 */
	configured: boolean;
	/** 凭据来源说明（auth.json / 环境变量…）。 */
	source?: string;
}

/** ClientSession 提供给本服务的宿主能力（窄接口，便于独立测试）。 */
export interface SlashHost {
	emit: (msg: ServerMessage) => void;
	/** 当前工作目录（/cwd 无参数时回显）。 */
	cwd: () => string;
	/** 活动对话的 session。 */
	getSession: () => AgentSession;
	/** 新建/切到一个空白对话。返回 false = 没能进入新对话（准入关闭 / 同项目
	 *  对话数达上限 / runtime 创建失败）——此时 /new <prompt> 不能把首条提示发
	 *  出去，否则会落进用户原本正在用的那个对话。不返回（void）视为成功。 */
	newChat: () => Promise<void | boolean>;
	/** Send a prompt in the active conversation (used by /new <prompt>). */
	prompt?: (text: string) => Promise<void>;
	setModel: (modelId: string) => Promise<void>;
	setCwd: (path: string) => Promise<void>;
	setThinking: (level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
	renameSession?: (name: string) => Promise<void> | void;
	forkSession?: (newName?: string) => Promise<void> | void;
	refreshSessions: () => Promise<void>;
	/** 交互式提问（复用 question_pending/question_answer 协议，
	 *  前端由 DshQuestionDialog 富渲染）。返回用户回答；取消时 null。
	 *  /login 用它选 provider、认证方式、输入 API key。 */
	askUser?: (
		questions: import("./protocol.js").UiQuestion[],
	) => Promise<import("./protocol.js").QuestionAnswer[] | null>;
	/** supervisor 的优雅重启调度；返回 false 时 exec 兜底 process.exit(0)。 */
	onQuit?: () => boolean;
	/** session.reload() 之后的钩子（重放终端工具开关等设置门控）。 */
	afterReload?: () => void;
	/** 插件注册的斜杠命令（registerCommand）——目录展示 + exec 拦截执行。 */
	pluginCommands?: () => PluginCommandDef[];
	/** 执行一个插件命令：找到并调用 run，返回 true；没这个命令返回 false。
	 *  放在宿主层而不是本服务里，因为 clientId/通知回显需要 ClientSession 环境。 */
	execPluginCommand?: (name: string, args: string) => Promise<boolean> | boolean;
}

/** Slash commands implemented natively by the web server (the pi CLI's built-in
 * interactive commands like /model and /new are NOT handled by the SDK's
 * prompt() — without this they'd be sent to the model as plain text). Keep in
 * sync with exec(). */
export const NATIVE_COMMANDS: {
	name: string;
	description: string;
	descriptionEn: string;
	argumentHint?: string;
	argumentHintEn?: string;
}[] = [
	{
		name: "new",
		description: "新建对话（可带首条提示：/new <提示>）",
		descriptionEn: "New chat (optional first prompt: /new <prompt>)",
		argumentHint: "[提示]",
		argumentHintEn: "[prompt]",
	},
	{
		name: "name",
		description: "重命名当前会话",
		descriptionEn: "Set session display name",
		argumentHint: "<名称>",
		argumentHintEn: "<name>",
	},
	{
		name: "fork",
		description: "Bifurca la conversación actual en una nueva",
		descriptionEn: "Fork current conversation into a new one",
		argumentHint: "[nuevo nombre]",
		argumentHintEn: "[new name]",
	},
	{
		name: "name",
		description: "重命名当前会话",
		descriptionEn: "Set session display name",
		argumentHint: "<名称>",
		argumentHintEn: "<name>",
	},
	{
		name: "model",
		description: "切换模型",
		descriptionEn: "Switch model",
		argumentHint: "[名称]",
		argumentHintEn: "[name]",
	},
	{
		name: "compact",
		description: "压缩上下文",
		descriptionEn: "Compact context",
		argumentHint: "[说明]",
		argumentHintEn: "[instructions]",
	},
	{
		name: "cwd",
		description: "切换工作目录",
		descriptionEn: "Switch workspace",
		argumentHint: "<路径>",
		argumentHintEn: "<path>",
	},
	{
		name: "thinking",
		description: "设置思考强度",
		descriptionEn: "Set thinking level",
		argumentHint: "<off|low|medium|high|xhigh|max>",
		argumentHintEn: "<off|low|medium|high|xhigh|max>",
	},
	{ name: "resume", description: "刷新会话列表", descriptionEn: "Refresh session list" },
	{ name: "reload", description: "重新加载扩展、技能与模板", descriptionEn: "Reload extensions, skills & templates" },
	{
		name: "login",
		description: "登录账号 (OAuth)",
		descriptionEn: "Sign in with an account (OAuth)",
		argumentHint: "[provider]",
		argumentHintEn: "[provider]",
	},
	{
		name: "logout",
		description: "退出账号",
		descriptionEn: "Sign out",
		argumentHint: "[provider]",
		argumentHintEn: "[provider]",
	},
	{
		name: "tool",
		description: "安装命令行工具（持久化）",
		descriptionEn: "Install CLI tools (persisted)",
		argumentHint: "install <nombre>[@version] | list",
		argumentHintEn: "install <name>[@version] | list",
	},
	{
		name: "cli_auth",
		description: "登录命令行工具（gcloud、gh、az…）",
		descriptionEn: "Sign in a CLI tool (gcloud, gh, az…)",
		argumentHint: "[工具]",
		argumentHintEn: "[tool]",
	},
	{ name: "help", description: "显示全部命令", descriptionEn: "Show all commands" },
	{ name: "copy", description: "复制上一条助手回复", descriptionEn: "Copy last assistant reply" },
	{ name: "pi-web-ui:quit", description: "退出服务", descriptionEn: "Quit server (supervisor will restart)" },
];

/** Parse a prompt into "/command args" — returns null when it isn't one. */
export function parseSlash(text: string): { name: string; args: string } | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = trimmed.match(/^\/([^\s]+)\s*([\s\S]*)$/);
	if (!m || !m[1]) return null;
	return { name: m[1], args: m[2].trim() };
}

export class SlashCommandsService {
	constructor(private readonly host: SlashHost) {}

	/**
	 * Catalog of slash commands for the chat input: web-native builtins first,
	 * then the SDK's invokable commands for the ACTIVE conversation (extension
	 * commands, prompt templates, skills) — the same set the SDK expands when a
	 * prompt text starts with "/" (see AgentSession.prompt).
	 */
	async push(): Promise<void> {
		const commands: SlashCommandInfo[] = [];
		const seen = new Set<string>();
		for (const c of NATIVE_COMMANDS) {
			commands.push({ ...c, source: "builtin" });
			seen.add(c.name);
		}
		try {
			const s = this.host.getSession();
			// Extension commands — the SDK already suffixes collisions with builtin
			// names ("new:2"), and those still reach the SDK since exec() only
			// intercepts the exact native names.
			for (const cmd of s.extensionRunner.getRegisteredCommands()) {
				if (seen.has(cmd.invocationName)) continue;
				commands.push({
					name: cmd.invocationName,
					description: cmd.description,
					source: "extension",
				});
				seen.add(cmd.invocationName);
			}
			// Prompt templates: /templatename args
			for (const t of s.promptTemplates) {
				if (seen.has(t.name)) continue;
				commands.push({
					name: t.name,
					description: t.description,
					source: "prompt",
				});
				seen.add(t.name);
			}
			// Skills: /skill:name args
			for (const skill of s.resourceLoader.getSkills().skills) {
				const name = `skill:${skill.name}`;
				if (seen.has(name)) continue;
				commands.push({
					name,
					description: skill.description,
					source: "skill",
				});
				seen.add(name);
			}
		} catch {
			// Session not ready yet — native-only catalog still serves the picker.
		}
		// UI 插件注册的命令（host.registerCommand）——全局，不依赖会话就绪。
		for (const cmd of this.host.pluginCommands?.() ?? []) {
			if (seen.has(cmd.name)) continue; // 与内置/扩展重名时先到先得（内置优先）
			commands.push({
				name: cmd.name,
				description: cmd.description,
				descriptionEn: cmd.descriptionEn,
				argumentHint: cmd.argumentHint,
				argumentHintEn: cmd.argumentHintEn,
				source: "plugin",
			});
			seen.add(cmd.name);
		}
		this.host.emit({ type: "slash_commands", commands });
	}

	/** Run a native slash command (see NATIVE_COMMANDS). Returns false when the
	 *  name is not a native command (the prompt falls through to the SDK). */
	async exec(name: string, args: string): Promise<boolean> {
		switch (name) {
			case "new": {
				const first = args.trim();
				const ready = await this.host.newChat();
				// /new <prompt>: deliver the text as the new session's first
				// prompt, exactly as if typed after the switch. Empty = old
				// behavior (blank chat, no send). Only when the switch actually
				// landed on a blank chat — newChat() reports false when it bailed
				// (cap reached / runtime creation failed) and sending anyway would
				// drop the text into the conversation the user was already in.
				if (ready !== false && first && this.host.prompt) await this.host.prompt(first);
				return true;
			}
			case "fork":
				if (this.host.forkSession) {
					await this.host.forkSession(args || undefined);
				} else {
					this.host.emit({
						type: "notice",
						level: "error",
						text: "当前环境不支持 bifurcar 会话",
						textEn: "Forking session is not supported in the current environment",
					});
				}
				return true;
			case "name": {
				const trimmed = args.trim();
				if (!trimmed) {
					const current = this.host.getSession().sessionName;
					this.host.emit({
						type: "notice",
						level: "info",
						text: current ? `当前会话名称：${current}。用法：/name <名称>` : `用法：/name <名称>`,
						textEn: current ? `Current session name: ${current}. Usage: /name <name>` : `Usage: /name <name>`,
					});
					return true;
				}
				if (this.host.renameSession) {
					await this.host.renameSession(trimmed);
				} else {
					this.host.getSession().setSessionName(trimmed);
					await this.host.refreshSessions();
					this.host.emit({
						type: "notice",
						level: "info",
						text: `已重命名当前会话为「${trimmed}」`,
						textEn: `Renamed current session to "${trimmed}"`,
					});
				}
				return true;
			}
			case "model": {
				if (!args) {
					const current = this.host.getSession().model;
					this.host.emit({
						type: "notice",
						level: "info",
						text: current
							? `当前模型：${current.name}（${current.provider}/${current.id}）。用法：/model <名称>`
							: `用法：/model <名称>`,
						textEn: current
							? `Current model: ${current.name} (${current.provider}/${current.id}). Usage: /model <name>`
							: `Usage: /model <name>`,
					});
					return true;
				}
				const query = args.toLowerCase();
				const available = await this.host.getSession().modelRuntime.getAvailable();
				// Prefer an exact "provider/id" match, else id/name substring.
				const exact = available.find((m) => m.provider + "/" + m.id === args.trim());
				const matches = exact
					? [exact]
					: available.filter(
							(m) =>
								m.id.toLowerCase().includes(query) ||
								m.name.toLowerCase().includes(query) ||
								m.provider.toLowerCase().includes(query),
						);
				if (matches.length === 0) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `没有匹配到模型：${args}（可用模型见顶栏模型列表）`,
						textEn: `No matching model: ${args} (see the model list in the top bar)`,
					});
					return true;
				}
				const pick = matches[0];
				if (matches.length > 1) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `找到 ${matches.length} 个匹配模型，已选用：${pick.name}（精确匹配请用 provider/id）`,
						textEn: `Found ${matches.length} matching models, using: ${pick.name} (use provider/id for an exact match)`,
					});
				}
				await this.host.setModel(`${pick.provider}/${pick.id}`);
				return true;
			}
			case "compact":
				try {
					await this.host.getSession().compact(args || undefined);
				} catch {
					// 压缩过程/结果/错误反馈统一由 agent-service onEvent 的
					// compaction_start / compaction_end 事件处理（含 errorMessage），
					// 这里不重复发通知；SDK 在 throw 前必发 compaction_end（issue #33）。
				}
				return true;
			case "cwd":
				if (!args) {
					this.host.emit({
						type: "notice",
						level: "info",
						text: `当前工作目录：${this.host.cwd()}。用法：/cwd <路径>`,
						textEn: `Current directory: ${this.host.cwd()}. Usage: /cwd <path>`,
					});
				} else {
					await this.host.setCwd(args);
				}
				return true;
			case "thinking": {
				const ALIAS: Record<string, string> = {
					off: "off",
					minimal: "minimal",
					low: "low",
					medium: "medium",
					high: "high",
					xhigh: "xhigh",
					max: "max",
					关闭: "off",
					极简: "minimal",
					低: "low",
					中: "medium",
					高: "high",
					极高: "xhigh",
					最大: "max",
				};
				const level = ALIAS[args.trim().toLowerCase()];
				if (!level) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `无效的思考强度：${args || "（空）"}。可用：off / minimal / low / medium / high / xhigh / max`,
						textEn: `Invalid thinking level: ${args || "(empty)"}. Available: off / minimal / low / medium / high / xhigh / max`,
					});
					return true;
				}
				this.host.setThinking(level as Parameters<SlashHost["setThinking"]>[0]);
				return true;
			}
			case "resume":
				await this.host.refreshSessions();
				this.host.emit({
					type: "notice",
					level: "info",
					text: "会话列表已刷新，请在左侧「历史对话」中选择",
					textEn: "Session list refreshed — pick one under History on the left",
				});
				return true;
			case "reload":
				try {
					// Re-discovers extensions / skills / prompt templates from disk and
					// re-pushes the picker catalog (the CLI's /reload semantics).
					await this.host.getSession().reload();
					// reload() 会把 custom 工具加回活跃集——重放设置门控（终端开关等）。
					this.host.afterReload?.();
					await this.push();
					this.host.emit({
						type: "notice",
						level: "info",
						text: "已重新加载扩展、技能与提示模板",
						textEn: "Reloaded extensions, skills and prompt templates",
					});
				} catch (err) {
					this.host.emit({
						type: "notice",
						level: "error",
						text: `重新加载失败：${(err as Error).message}`,
						textEn: `Reload failed: ${(err as Error).message}`,
					});
				}
				return true;
			case "pi-web-ui:quit": {
				this.host.emit({
					type: "notice",
					level: "info",
					text: "正在退出 pi-web-ui… supervisor 将自动重启服务",
					textEn: "Quitting pi-web-ui… the supervisor will restart the service",
				});
				setTimeout(() => {
					const didSchedule = this.host.onQuit?.() ?? false;
					if (!didSchedule) {
						setTimeout(() => process.exit(0), 100);
					}
				}, 300);
				return true;
			}
			case "login": {
				// /login [provider] [oauth|api_key] —— 两者皆可省略，缺什么问什么。
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const kind = parts.find((x) => x === "oauth" || x === "api_key") as AuthKind | undefined;
				const provider = parts.find((x) => x !== "oauth" && x !== "api_key");
				void this.runLogin(provider, kind);
				return true;
			}
			case "tool": {
				// RFC 002 第 2 阶段：装到持久化的 ~/.local（mise）。
				const parts = args.trim().split(/\s+/).filter(Boolean);
				void this.runToolCommand(parts[0], parts.slice(1));
				return true;
			}
			case "cli_auth": {
				// RFC 002 第 1 阶段：把 CLI 工具的登录搬进 UI（复用 /login 的机制）。
				void this.runCliAuth(args.trim().split(/\s+/).filter(Boolean)[0]);
				return true;
			}
			case "logout": {
				// /logout [provider] —— 无参数时列出已保存的凭据让用户选。
				void this.runLogout(args.trim().split(/\s+/).filter(Boolean)[0]);
				return true;
			}
			case "help":
			case "copy":
				// Client-side UI actions — the client handles them before sending;
				// swallow here so the SDK never sees them as plain prompt text.
				return true;
			default:
				// 插件命令：拦截执行（纯配置动作，与内置命令同级，不到 SDK）。
				return (await this.host.execPluginCommand?.(name, args)) ?? false;
		}
	}

	/** 交互式登录（/login）：provider 与认证方式可由参数直给，缺省则弹对话框
	 *  让用户选，随后交给 SDK 的 login() 驱动具体流程 —— OAuth 设备码或 API key
	 *  输入，对任何 provider 都一致（不再写死 github-copilot）。
	 *
	 *  进度经 `auth_flow` 推给客户端（常驻横幅）；提问走 question_pending 协议
	 *  （前端 DshQuestionDialog 富渲染）。Fire-and-forget：exec 立即返回，用户在
	 *  浏览器里完成流程。 */
	private async runLogin(providerArg?: string, kindArg?: AuthKind): Promise<void> {
		try {
			const session = this.host.getSession();
			const providerId = providerArg ?? (await this.pickLoginProvider());
			if (!providerId) {
				this.emitCancelled("login");
				return;
			}
			const authType = kindArg ?? (await this.pickLoginAuthType(providerId));
			if (!authType) {
				this.emitCancelled("login");
				return;
			}
			this.host.emit({
				type: "notice",
				level: "info",
				text: `正在为 ${providerId} 启动登录（${authType}）…`,
				textEn: `Starting login for ${providerId} (${authType})…`,
			});
			await session.modelRuntime.login(providerId, authType, {
				// 「prompt 通用入口」：SDK 借它索取 API key（secret）、GitHub
				// Enterprise 域名（text，留空 = github.com）、OAuth manual_code
				// 或 select。统一转成一道对话框题目 —— 实现这一处，所有 provider
				// 的 API key 与 OAuth 就都通了。
				prompt: async (p: {
					type?: string;
					message?: string;
					placeholder?: string;
					options?: readonly { id: string; label: string; description?: string }[];
				}) => {
					const message = p?.message ?? "";
					const enterprise = /enterprise/i.test(message);
					if (p?.type === "select") {
						const opts = p.options ?? [];
						const picked = await this.askOne({
							header: "Auth",
							question: message,
							options: opts.map((o) => ({ label: o.label, description: o.description })),
						});
						if (picked === undefined) throw new Error("Login cancelled");
						// select 回传的是选项 id（前端给的是 label）——按 label 反查。
						return opts.find((o) => o.label === picked)?.id ?? picked;
					}
					const answer = await this.askOne({
						header: enterprise ? "GitHub Enterprise" : "Auth",
						question: message,
						detail: enterprise ? "留空 = github.com / Leave blank for github.com" : undefined,
						secret: p?.type === "secret",
					});
					if (answer === undefined) throw new Error("Login cancelled");
					return answer;
				},
				notify: (event) => {
					const e = event as {
						type?: string;
						userCode?: string;
						verificationUri?: string;
						url?: string;
						message?: string;
					};
					if (e.type === "device_code") {
						this.host.emit({
							type: "auth_flow",
							state: "device_code",
							verificationUri: e.verificationUri,
							userCode: e.userCode,
						});
					} else if (e.type === "auth_url") {
						// Non-device providers expose a URL + instructions instead.
						this.host.emit({
							type: "auth_flow",
							state: "device_code",
							verificationUri: e.url,
							userCode: "",
						});
					} else if (e.type === "info") {
						this.host.emit({
							type: "notice",
							level: "info",
							text: e.message ?? "",
							textEn: e.message ?? "",
						});
					} else {
						this.host.emit({
							type: "auth_flow",
							state: "waiting",
							message: e.message,
						});
					}
				},
			});
			this.host.emit({ type: "auth_flow", state: "done", message: providerId });
			this.host.emit({
				type: "notice",
				level: "info",
				text: `✅ 已登录 ${providerId}`,
				textEn: `✅ Logged in to ${providerId}`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.host.emit({ type: "auth_flow", state: "error", message });
			this.host.emit({
				type: "notice",
				level: "error",
				text: `登录失败：${message}`,
				textEn: `Login failed: ${message}`,
			});
		}
	}

	/** 弹一道题并等回答（question_pending 协议）。返回用户填写的文本或选中的
	 *  选项 label；用户取消 → undefined。
	 *
	 *  必须区分「取消」与「提交空值」：前端取消发 `answers: []`，而提交空文本发
	 *  `[{ selected: [] }]`（custom 省略）——「留空」在登录里是合法答案
	 *  （例如 GitHub Enterprise 域名留空 = github.com）。 */
	private async askOne(q: {
		header?: string;
		question: string;
		detail?: string;
		options?: UiQuestionOption[];
		secret?: boolean;
	}): Promise<string | undefined> {
		const ask = this.host.askUser;
		if (!ask) throw new Error("当前宿主不支持交互式提问（askUser 未接线）");
		const answers = await ask([{ id: "auth", ...q }]);
		if (!answers || answers.length === 0) return undefined;
		const custom = answers[0]?.custom;
		if (custom !== undefined) return custom.trim();
		return answers[0]?.selected?.[0] ?? "";
	}

	/** 取消登录 / 退出：统一文案。 */
	private emitCancelled(action: "login" | "logout"): void {
		this.host.emit({
			type: "notice",
			level: "info",
			text: action === "login" ? "已取消登录" : "已取消退出登录",
			textEn: action === "login" ? "Login cancelled" : "Sign-out cancelled",
		});
	}

	/** provider 候选（镜像 TUI 的 getLoginProviderOptions）。 */
	private loginProviderOptions(authType?: AuthKind): LoginProviderOption[] {
		const runtime = this.host.getSession().modelRuntime;
		const providers = runtime.getProviders() as readonly {
			id: string;
			name: string;
			auth?: { oauth?: unknown; apiKey?: unknown };
		}[];
		const out: LoginProviderOption[] = [];
		for (const provider of providers) {
			const status = runtime.getProviderAuthStatus(provider.id) as {
				configured?: boolean;
				label?: string;
				source?: string;
			};
			const configured: AuthKind | undefined = status.configured
				? runtime.isUsingOAuth(provider.id)
					? "oauth"
					: "api_key"
				: undefined;
			for (const type of ["oauth", "api_key"] as const) {
				if (authType && authType !== type) continue;
				const method = type === "oauth" ? provider.auth?.oauth : provider.auth?.apiKey;
				if (!method) continue;
				out.push({
					id: provider.id,
					name: provider.name,
					authType: type,
					configured: configured === type,
					source: status.configured ? (status.label ?? status.source) : undefined,
				});
			}
		}
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** 同一 provider 的两条登录路径合并成一行展示。 */
	private describeProvider(group: LoginProviderOption[]): string {
		const kinds = group.map((o) => (o.authType === "oauth" ? "OAuth" : "API key")).join(" / ");
		const done = group.find((o) => o.configured);
		return done ? `${kinds} · ✅ ${done.source ?? "configured"}` : kinds;
	}

	/** /login 无参数：弹对话框选 provider。返回 provider id；取消 → undefined。 */
	private async pickLoginProvider(): Promise<string | undefined> {
		const byId = new Map<string, LoginProviderOption[]>();
		for (const o of this.loginProviderOptions()) byId.set(o.id, [...(byId.get(o.id) ?? []), o]);
		const groups = [...byId.values()];
		if (groups.length === 0) throw new Error("当前没有可登录的 provider");
		const picked = await this.askOne({
			header: "Provider",
			question: "选择要登录的 provider / Choose a provider to sign in",
			detail: "✅ = 已保存凭据 / already has saved credentials",
			options: groups.map((g) => ({ label: g[0].name, description: this.describeProvider(g) })),
		});
		if (picked === undefined) return undefined;
		return groups.find((g) => g[0].name === picked)?.[0].id;
	}

	/** /login 已知 provider：选认证方式；只有一条路径时直接用。 */
	private async pickLoginAuthType(providerId: string): Promise<AuthKind | undefined> {
		const opts = this.loginProviderOptions().filter((o) => o.id === providerId);
		if (opts.length === 0) throw new Error(`provider 不存在或不支持登录：${providerId}`);
		if (opts.length === 1) return opts[0].authType;
		const label = (k: AuthKind): string =>
			k === "oauth" ? "Sign in with an account (OAuth)" : "Sign in with an API key";
		const picked = await this.askOne({
			header: providerId,
			question: "选择登录方式 / Choose how to sign in",
			options: opts.map((o) => ({
				label: label(o.authType),
				description: o.configured ? `✅ ${o.source ?? "configured"}` : undefined,
			})),
		});
		if (picked === undefined) return undefined;
		return picked === label("oauth") ? "oauth" : "api_key";
	}

	/** /logout [provider]：无参数时列出已保存的凭据让用户选。 */
	private async runLogout(providerArg?: string): Promise<void> {
		try {
			const session = this.host.getSession();
			let target = providerArg;
			if (!target) {
				const creds = (await session.modelRuntime.listCredentials({
					signal: AbortSignal.timeout(15_000),
				})) as readonly { providerId: string; type?: string }[];
				if (creds.length === 0) {
					this.host.emit({
						type: "notice",
						level: "info",
						text: "没有已保存的凭据",
						textEn: "No saved credentials",
					});
					return;
				}
				const picked = await this.askOne({
					header: "Logout",
					question: "选择要退出的 provider / Choose a provider to sign out from",
					options: creds.map((c) => ({ label: c.providerId, description: c.type })),
				});
				if (picked === undefined) {
					this.emitCancelled("logout");
					return;
				}
				target = picked;
			}
			await session.modelRuntime.logout(target);
			this.host.emit({
				type: "notice",
				level: "info",
				text: `已退出 ${target}`,
				textEn: `Signed out of ${target}`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.host.emit({
				type: "notice",
				level: "error",
				text: `退出失败：${message}`,
				textEn: `Sign-out failed: ${message}`,
			});
		}
	}

	/** CLI 工具登录（RFC 002 第 1 阶段）：/cli_auth [tool]。
	 *
	 *  菜谱是数据：内置常用工具 + 用户在 `~/.config/cli-auth/recipes.json` 的
	 *  增补/覆盖。因此新增一个工具不需要改代码、不需要重建镜像、不需要新挂载。
	 *  进度复用 /login 的 `auth_flow` 横幅，提问复用 question_pending 协议。 */
	private async runCliAuth(toolArg?: string): Promise<void> {
		try {
			const home = process.env.HOME || "/home/tachikoma";
			const { recipes, error, path } = loadRecipes(home);
			if (error) {
				// 坏菜谱文件不该让命令无法使用：回落到内置并说明原因。
				this.host.emit({
					type: "notice",
					level: "warning",
					text: `CLI 菜谱文件无法解析（已忽略）：${error}`,
					textEn: `CLI recipe file could not be parsed (ignored): ${error}`,
				});
			}
			const names = Object.keys(recipes).sort();
			let tool = toolArg;
			if (!tool || !recipes[tool]) {
				if (tool) {
					this.host.emit({
						type: "notice",
						level: "warning",
						text: `没有 ${tool} 的菜谱，请从列表中选择`,
						textEn: `No recipe for ${tool} — pick one from the list`,
					});
				}
				if (names.length === 0) throw new Error("没有任何 CLI 菜谱");
				const picked = await this.askOne({
					header: "CLI auth",
					question: "选择要登录的 CLI 工具 / Choose a CLI tool to authenticate",
					detail: `菜谱：${path}`,
					options: names.map((n) => ({
						label: n,
						description: [recipes[n].label, this.recipeKind(recipes[n])].filter(Boolean).join(" · "),
					})),
				});
				if (picked === undefined) {
					this.emitCancelled("login");
					return;
				}
				tool = picked;
			}
			const recipe = recipes[tool];
			this.host.emit({
				type: "notice",
				level: "info",
				text: `正在为 ${tool} 启动登录…`,
				textEn: `Starting ${tool} sign-in…`,
			});
			const done = await runCliAuthRecipe(tool, recipe, {
				emit: (msg) => this.host.emit(msg as ServerMessage),
				askUser: this.host.askUser,
				cwd: home,
				home,
			});
			if (!done) this.emitCancelled("login");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.host.emit({ type: "auth_flow", state: "error", message });
			this.host.emit({
				type: "notice",
				level: "error",
				text: `CLI 登录失败：${message}`,
				textEn: `CLI sign-in failed: ${message}`,
			});
		}
	}

	/** 安装工具（RFC 002 第 2 阶段）：`/tool install <nombre>[@version]`、`/tool list`。
	 *
	 *  装到 `~/.local`（PVC），`~/.local/bin` 已在 PATH 最前 → 装完立刻可用，
	 *  而且重启 pod 后仍在。底层用 mise（版本管理器，不是清单）。 */
	private async runToolCommand(sub?: string, rest: string[] = []): Promise<void> {
		try {
			const home = process.env.HOME || "/home/tachikoma";
			const deps = { emit: (m: unknown) => this.host.emit(m as ServerMessage), home };
			if (sub === "list") {
				const tools = await listTools(deps);
				this.host.emit({
					type: "notice",
					level: "info",
					text: tools.length ? `已安装：${tools.join(", ")}` : "还没有安装任何工具",
					textEn: tools.length ? `Installed: ${tools.join(", ")}` : "No tools installed yet",
				});
				return;
			}
			// `/tool <nombre>` es azúcar para `/tool install <nombre>`.
			let spec = sub === "install" ? rest[0] : sub;
			if (!spec) {
				const picked = await this.askOne({
					header: "Tool install",
					question: "要安装哪个工具？/ Which tool?（如 tofu、awscli、gh@latest）",
					detail: "装到 ~/.local（持久化）/ installed into ~/.local (persisted)",
				});
				if (picked === undefined || picked === "") {
					this.emitCancelled("login");
					return;
				}
				spec = picked;
			}
			this.host.emit({
				type: "notice",
				level: "info",
				text: `正在安装 ${spec}…`,
				textEn: `Installing ${spec}…`,
			});
			await installTool(spec, deps);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.host.emit({ type: "auth_flow", state: "error", message });
			this.host.emit({
				type: "notice",
				level: "error",
				text: `安装失败：${message}`,
				textEn: `Install failed: ${message}`,
			});
		}
	}

	/** 选择器里的一句话描述：这个工具是哪种登录方式。 */
	private recipeKind(r: { key?: unknown; deviceCode?: unknown; manualCode?: unknown; note?: unknown }): string {
		if (r.key) return "API key / PAT";
		if (r.deviceCode) return "device code";
		if (r.manualCode) return "paste code";
		if (r.note) return "no sign-in";
		return "";
	}
}
