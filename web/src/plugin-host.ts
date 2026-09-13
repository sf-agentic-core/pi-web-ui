/// <reference lib="dom" />
/**
 * 插件宿主动作桥（`window.__piWebUiHost`）。
 *
 * 插件的 client bundle 是运行时动态 import 的裸 ESM，**不能 import 应用内部模块**，
 * 但它有时需要主应用配合做动作（切视图、新建对话并把一段话作为用户消息发出去 ——
 * 例如 legado-web 插件的「AI 修复源」按钮）。这些动作走 window 上的单例：
 *
 *   window.__piWebUiHost = {
 *     version: 3,
 *     setView("chat" | "terminal" | "git" | `plugin:<id>`),
 *     startChat({ prompt, newChat?, cwd? }) → boolean   // 已受理，动作在后台串行完成
 *     compose({ text?, attachments? }) → boolean        // 放进输入框草稿，等用户自己发
 *     pageCall({ op, args?, target?, timeoutMs? }) → Promise<{ok, result?, error?}>
 *   }
 *
 * pageCall 是「AI 操作页面」的通道：服务端把模型的动作（`page_request`）推过来，这里转给
 * **浏览器扩展**（page-picker 注入在页面主世界的 `window.__piBridge`），再把结果回给服务端。
 * 它不抛错，而是返回 `{ok:false,error}` —— 这个错误要原样写进工具结果里让模型看到。
 *
 * startChat 与 compose 是两条不同的路：前者“直接开一个新对话把话发出去”（脚本化），
 * 后者“把内容放进输入框草稿让用户补一句再发”（人在环中）—— 元素拾取这类需要用户
 * 补充描述的场景走 compose（见 composer-bridge.ts）。
 *
 * 时序坑：服务端的 `new_chat` 是异步的（`void cs.newChat()`），紧接着发 `prompt` 会落到
 * **旧对话**里（activeId 要等 runtime 建好才切）。所以这里串行等待：先等 cwd 切过去、
 * 再等对话变成空白（新对话就绪或本来就是空白对话），最后才发 prompt。
 *
 * 与 app-globals 的分工：那边放「状态 + 唯一的全局发送器」，这里放需要 React 侧
 * 注入实现（setView/chat 快照）的**跨边界动作**，两者都不吃快照流。
 */

import type { AppSend } from "./app-globals";
import { composeToComposer, isComposerReady, type ComposerPayload } from "./composer-bridge";

export const PLUGIN_HOST_GLOBAL = "__piWebUiHost";
/** 宿主 API 版本：插件可用它判断宿主能力（> 本值表示宿主更新）。
 *  2 = 新增 `compose()`（注入输入框草稿）。
 *  3 = 新增 `pageCall()`（把模型的动作转给浏览器扩展，见 plugin-host 注释）。 */
export const PLUGIN_HOST_API_VERSION = 3;

export interface PluginHostStartChatOptions {
	/** 要作为用户消息发出的文本（必填，空串直接拒绝）。 */
	prompt: string;
	/** 是否先新开一个对话，默认 true。 */
	newChat?: boolean;
	/** 新对话的工作目录（不给 = 不动；切目录失败时服务端会自己提示，流程继续）。 */
	cwd?: string;
}

/** 注入输入框草稿的内容（见 composer-bridge.ts 的 ComposerPayload）。 */
export type PluginHostComposeOptions = ComposerPayload;

export interface PluginHostApi {
	version: number;
	/** 切主视图（"chat" | "terminal" | "git" | `plugin:<id>`）。 */
	setView(view: string): void;
	/** 新建对话（可选切工作目录）并把 prompt 作为用户消息发出去。
	 *  返回「已受理」；完整流程在后台串行完成（每步都有超时，超时也照发，不静默丢消息）。 */
	startChat(opts: PluginHostStartChatOptions): boolean;
	/** 把内容放进**输入框草稿**（用户补一句话再自己发），返回是否受理。
	 *  与 startChat 的差别：不要求连接就绪（草稿是本地状态，断线也能先攒着），
	 *  但输入框还没挂载时返回 false；内容全空也返回 false。 */
	compose(opts: PluginHostComposeOptions): boolean;
	/** 让浏览器扩展操作**被授权的页面**（AI 操作页面的通道）。
	 *  永远 resolve：失败原因放在 `{ok:false,error}` 里回给模型，不抛给调用方。 */
	pageCall(opts: PluginHostPageCallOptions): Promise<PluginHostPageResult>;
}

/** 模型想执行的一个页面动作（op 词表在扩展侧，服务端只透传）。 */
export interface PluginHostPageCallOptions {
	op: string;
	args?: Record<string, unknown>;
	/** 目标页面 origin（有多个已授权页面时必填）。 */
	target?: string;
	timeoutMs?: number;
}

/** `{ok:true,result}` 或 `{ok:false,error}` —— 后者会变成模型看到的失败原因。 */
export type PluginHostPageResult = { ok: true; result?: unknown } | { ok: false; error: string };

/** 扩展注入到页面主世界的桥（只用到 call 这一个方法）。 */
interface PageBridgeLike {
	call(req: { op: string; args?: unknown; to?: string; timeoutMs?: number }): Promise<unknown>;
}

export interface PluginHostDeps {
	/** 全局发送器（app-globals 的 appSend）。 */
	send: AppSend;
	/** 连接是否可用（WS 开着 + 已有快照）。false 时 startChat 直接拒绝。 */
	isReady: () => boolean;
	setView: (view: string) => void;
	/** 当前工作目录（快照里的）。 */
	getCwd: () => string;
	/** 当前活动对话 id（还没快照时为 null）。 */
	getConversationId: () => string | null;
	/** 当前对话是否还是空白（没有消息 = 它就是「新对话」，new_chat 不会换 id）。 */
	isConversationBlank: () => boolean;
	/** 轮询间隔 / 单步超时（测试可调小）。 */
	pollMs?: number;
	timeoutMs?: number;
	/** 等扩展注入页面桥的窗口（默认 3000ms；测试调小，免得为了一个「没插桥」的分支等三秒）。 */
	bridgeWaitMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 等扩展把页面桥装上（MAIN world 注入是异步的，页面刚加载时可能还没有）。
 *
 * 为什么不一口气等很久：桥不在通常意味着**扩展没装 / 没启用 / 本页地址没绑**，那是配置问题，
 * 等再久也不会变好。给一个短窗口（默认 3s）盖住「刚刷新完」这一种情况即可。 */
async function waitForPageBridge(timeoutMs = 3000): Promise<PageBridgeLike | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const bridge = (window as unknown as { __piBridge?: PageBridgeLike }).__piBridge;
		if (bridge && typeof bridge.call === "function") return bridge;
		if (Date.now() >= deadline) return null;
		await sleep(100);
	}
}

export function createPluginHostApi(deps: PluginHostDeps): PluginHostApi {
	const pollMs = Math.max(1, Number(deps.pollMs ?? 100));
	const timeoutMs = Math.max(pollMs, Number(deps.timeoutMs ?? 8000));

	/** 轮询等条件成立；超时返回 false（调用方继续，不静默放弃）。 */
	const waitFor = async (ok: () => boolean): Promise<boolean> => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (ok()) return true;
			if (Date.now() >= deadline) return ok();
			await sleep(pollMs);
		}
	};

	const run = async (prompt: string, opts: PluginHostStartChatOptions): Promise<void> => {
		const cwd = String(opts.cwd ?? "").trim();
		if (cwd && deps.getCwd() !== cwd) {
			deps.send({ type: "set_cwd", path: cwd });
			await waitFor(() => deps.getCwd() === cwd);
		}
		if (opts.newChat !== false) {
			const before = deps.getConversationId();
			deps.send({ type: "new_chat" });
			// 新对话换上（id 变）/ 本来就是空白对话，两者都算就绪
			await waitFor(() => deps.getConversationId() !== before || deps.isConversationBlank());
		}
		deps.send({ type: "prompt", text: prompt });
	};

	return {
		version: PLUGIN_HOST_API_VERSION,
		setView(view) {
			const v = String(view ?? "").trim();
			if (v) deps.setView(v);
		},
		startChat(opts) {
			const prompt = String(opts?.prompt ?? "").trim();
			if (!prompt) return false;
			if (!deps.isReady()) return false;
			void run(prompt, opts ?? { prompt }).catch(() => {
				/* 发送失败已有各自的上层提示，这里不抛到调用方 */
			});
			return true;
		},
		compose(opts) {
			if (!isComposerReady()) return false;
			return composeToComposer({
				text: typeof opts?.text === "string" ? opts.text : undefined,
				attachments: Array.isArray(opts?.attachments) ? opts.attachments : undefined,
			});
		},
		async pageCall(opts) {
			const op = String(opts?.op ?? "").trim();
			if (!op) return { ok: false, error: "pageCall 需要一个动作名（op）" };
			const bridge = await waitForPageBridge(deps.bridgeWaitMs ?? 3000);
			if (!bridge) {
				return {
					ok: false,
					error: "浏览器扩展的页面桥没就绪：确认已安装并启用 page-picker 扩展、本页地址已绑定，然后刷新本页",
				};
			}
			try {
				const result = await bridge.call({
					op,
					...(opts.args === undefined ? {} : { args: opts.args }),
					...(opts.target ? { to: opts.target } : {}),
					...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
				});
				return result === undefined ? { ok: true } : { ok: true, result };
			} catch (err) {
				// 桥把对端/准入的失败原因包在 Error.message 里（见扩展的 bridge-page.ts）
				return { ok: false, error: err instanceof Error ? err.message : String(err) };
			}
		},
	};
}

/** 装上 / 卸下宿主 API（App 挂载时装，卸载时传 null 摘掉）。 */
export function installPluginHostApi(api: PluginHostApi | null): void {
	try {
		const w = window as unknown as Record<string, unknown>;
		if (api) w[PLUGIN_HOST_GLOBAL] = api;
		else delete w[PLUGIN_HOST_GLOBAL];
	} catch {
		/* 非浏览器环境（单测）忽略 */
	}
}
