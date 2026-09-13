import { describe, expect, it, vi } from "vitest";
import { SlashCommandsService } from "../../server/slash-commands.js";
import type { QuestionAnswer, UiQuestion } from "../../server/protocol.js";

/**
 * /login、/logout 的交互式流程单测（零 token / 零会话）。
 *
 * 覆盖的重点是「prompt 通用入口」的转换逻辑 —— 也就是本次改动的核心：
 * 任何 provider 的 API key / OAuth 都经由它流转，转换错了就整条链断掉。
 * 具体校验：
 *  - secret 提问 → 前端收 secret 标记（密码框），返回用户输入的 key；
 *  - select 提问 → 回传的是选项 **id**（前端给的是 label，必须反查）；
 *  - 用户取消（answers: []） → 抛「Login cancelled」，登录中止；
 *  - 空提交（selected: []，无 custom） → 返回空串，而不是当成取消
 *    （GitHub Enterprise 域名留空 = github.com，是合法答案）；
 *  - 无参数 /login /logout → 弹选择器并用选中的 provider。
 */

/** 最小 modelRuntime mock：两个 provider，一个 OAuth-only，一个 API-key-only。 */
function runtime(over: Record<string, unknown> = {}) {
	return {
		getProviders: () => [
			{ id: "github-copilot", name: "GitHub Copilot", auth: { oauth: {} } },
			{ id: "anthropic", name: "Anthropic", auth: { apiKey: {} } },
		],
		getProviderAuthStatus: (id: string) =>
			id === "github-copilot" ? { configured: true, label: "auth.json" } : { configured: false },
		isUsingOAuth: () => true,
		login: vi.fn(async () => ({})),
		logout: vi.fn(async () => {}),
		listCredentials: vi.fn(async () => []),
		...over,
	};
}

const host = (over: Record<string, unknown> = {}) => ({
	emit: vi.fn(),
	cwd: () => "/tmp",
	getSession: () => ({ modelRuntime: runtime() }),
	newChat: vi.fn(async () => {}),
	setModel: vi.fn(async () => {}),
	setCwd: vi.fn(async () => {}),
	setThinking: vi.fn(),
	...over,
});

/** answers 里第 0 题的回答（本服务只发一道题）。 */
const answer = (selected: string[], custom?: string): QuestionAnswer[] => [
	custom === undefined ? { id: "auth", selected } : { id: "auth", selected, custom },
];

/** exec 是 fire-and-forget（void runLogin），等 mock 被调用即可。 */
async function started(fn: ReturnType<typeof vi.fn>): Promise<unknown[]> {
	await vi.waitFor(() => expect(fn).toHaveBeenCalled());
	return fn.mock.calls[0];
}

describe("/login 参数解析", () => {
	it("provider + 认证方式由参数直给时不再提问", async () => {
		const rt = runtime();
		const askUser = vi.fn(async () => answer([], "sk-test"));
		const h = host({ askUser, getSession: () => ({ modelRuntime: rt }) });
		await new SlashCommandsService(h as never).exec("login", "anthropic api_key");
		const call = await started(rt.login);
		expect(call[0]).toBe("anthropic");
		expect(call[1]).toBe("api_key");
		expect(askUser).not.toHaveBeenCalled();
	});

	it("参数顺序无关（oauth anthropic 亦可）", async () => {
		const rt = runtime();
		const h = host({ askUser: vi.fn(async () => null), getSession: () => ({ modelRuntime: rt }) });
		await new SlashCommandsService(h as never).exec("login", "oauth github-copilot");
		const call = await started(rt.login);
		expect(call[0]).toBe("github-copilot");
		expect(call[1]).toBe("oauth");
	});
});

describe("prompt 通用入口（所有 provider 的关键路径）", () => {
	/** 起一个 /login，返回 SDK 拿到的 interaction。 */
	async function interaction(answers: QuestionAnswer[] | null, askCalls: UiQuestion[][] = []) {
		const rt = runtime();
		const askUser = vi.fn(async (qs: UiQuestion[]) => {
			askCalls.push(qs);
			return answers;
		});
		const h = host({ askUser, getSession: () => ({ modelRuntime: rt }) });
		await new SlashCommandsService(h as never).exec("login", "anthropic api_key");
		const call = await started(rt.login);
		return call[2] as { prompt: (p: unknown) => Promise<string> };
	}

	it("secret 提问：标记为敏感输入并返回用户填的 key", async () => {
		const calls: UiQuestion[][] = [];
		const i = await interaction(answer([], "sk-live-123"), calls);
		const key = await i.prompt({ type: "secret", message: "Paste your API key" });
		expect(key).toBe("sk-live-123");
		expect(calls[0][0].secret).toBe(true);
	});

	it("text 提问：不标记敏感", async () => {
		const calls: UiQuestion[][] = [];
		const i = await interaction(answer([], "acme.ghe.com"), calls);
		expect(await i.prompt({ type: "text", message: "GitHub Enterprise URL/domain" })).toBe(
			"acme.ghe.com",
		);
		expect(calls[0][0].secret).toBeFalsy();
	});

	it("Enterprise 域名留空：返回空串而不是当成取消", async () => {
		// 前端「提交空文本」= { selected: [], 无 custom }；取消 = answers: []。
		const i = await interaction(answer([]));
		await expect(i.prompt({ type: "text", message: "GitHub Enterprise URL/domain" })).resolves.toBe(
			"",
		);
	});

	it("select 提问：回传选项 id（前端给的是 label）", async () => {
		const i = await interaction([{ id: "auth", selected: ["Corporate account"] }]);
		const got = await i.prompt({
			type: "select",
			message: "Pick one",
			options: [
				{ id: "personal", label: "Personal account" },
				{ id: "corporate", label: "Corporate account" },
			],
		});
		expect(got).toBe("corporate");
	});

	it("用户取消：抛 Login cancelled 并报错，不静默继续", async () => {
		const i = await interaction(null);
		await expect(i.prompt({ type: "secret", message: "Paste your API key" })).rejects.toThrow(
			"Login cancelled",
		);
	});
});

describe("无参数交互选择", () => {
	it("/login 从 provider 列表选，且列出认证方式与已登录状态", async () => {
		const rt = runtime();
		const asks: UiQuestion[][] = [];
		const askUser = vi.fn(async (qs: UiQuestion[]) => {
			asks.push(qs);
			return answer(["Anthropic"]);
		});
		const h = host({ askUser, getSession: () => ({ modelRuntime: rt }) });
		await new SlashCommandsService(h as never).exec("login", "");
		const call = await started(rt.login);
		expect(call[0]).toBe("anthropic"); // 选的是 label，登录用的是 id
		const opts = asks[0][0].options ?? [];
		expect(opts.map((o) => o.label)).toEqual(["Anthropic", "GitHub Copilot"]);
		expect(opts.find((o) => o.label === "GitHub Copilot")?.description).toContain("✅");
	});

	it("/logout 列出已保存凭据并退出所选", async () => {
		const rt = runtime({
			listCredentials: vi.fn(async () => [{ providerId: "anthropic", type: "api_key" }]),
		});
		const askUser = vi.fn(async () => answer(["anthropic"]));
		const h = host({ askUser, getSession: () => ({ modelRuntime: rt }) });
		await new SlashCommandsService(h as never).exec("logout", "");
		await vi.waitFor(() => expect(rt.logout).toHaveBeenCalledWith("anthropic"));
	});

	it("/logout 取消时不退出任何 provider", async () => {
		const rt = runtime({
			listCredentials: vi.fn(async () => [{ providerId: "anthropic", type: "api_key" }]),
		});
		const h = host({ askUser: vi.fn(async () => null), getSession: () => ({ modelRuntime: rt }) });
		await new SlashCommandsService(h as never).exec("logout", "");
		await new Promise((r) => setTimeout(r, 10));
		expect(rt.logout).not.toHaveBeenCalled();
	});
});
