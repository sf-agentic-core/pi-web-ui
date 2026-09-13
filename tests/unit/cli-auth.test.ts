import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BUILTIN_RECIPES,
	loadRecipes,
	runCliAuth,
	type CliAuthDeps,
	type CliAuthRecipe,
} from "../../server/cli-auth.js";
import type { QuestionAnswer, UiQuestion } from "../../server/protocol.js";

/**
 * /cli_auth 的登录编排单测（RFC 002 第 1 阶段）。
 *
 * 进程型机制（manualCode / deviceCode）用真的 shell 命令跑 —— 这是行为测试，
 * 不是 mock 掉 spawn 后自说自话。重点覆盖：
 *  - key：密钥必须走 stdin、提问必须标记 secret、落文件时必须 0600
 *  - key 空提交：「跳过」而不是「失败」（两者都返回 true，语义不同）
 *  - select/manualCode：URL 与验证码的提取（提取不到也不能崩）
 *  - 取消失败：用户取消 → false
 *  - 凭据校验：命令退出 0 但没写凭据 → warning（不能说「成功」）
 *  - 菜谱合并：内置 + 用户覆盖 + 坏文件回落
 */

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "cli-auth-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 收集 emit 出来的 auth_flow 状态与 notice。 */
function harness(answers: QuestionAnswer[] | null, opts: { home?: string } = {}) {
	const flows: { state: string; userCode?: string; verificationUri?: string; message?: string }[] = [];
	const notices: { level: string; textEn: string }[] = [];
	const asks: UiQuestion[][] = [];
	const home = opts.home ?? tmp();
	const deps: CliAuthDeps = {
		home,
		cwd: home,
		emit: (msg) => {
			if (msg.type === "auth_flow") flows.push(msg);
			else notices.push({ level: msg.level, textEn: msg.textEn });
		},
		askUser: async (q) => {
			asks.push(q);
			return answers;
		},
	};
	return { deps, flows, notices, asks, home };
}

const ok = (custom: string): QuestionAnswer[] => [{ id: "cli-auth", selected: [], custom }];

describe("loadRecipes", () => {
	it("没有用户文件时只用内置菜谱", () => {
		const home = tmp();
		const { recipes, error } = loadRecipes(home);
		expect(error).toBeUndefined();
		expect(recipes.gcloud).toBe(BUILTIN_RECIPES.gcloud);
	});

	it("用户文件可新增工具，也可覆盖内置工具", () => {
		const home = tmp();
		const { path } = loadRecipes(home);
		mkdirSync(join(home, ".config", "cli-auth"), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				recipes: {
					gcloud: { label: "GC custom", note: "overridden" },
					mytool: { label: "My Tool", note: "hello" },
				},
			}),
		);
		const { recipes } = loadRecipes(home);
		expect(recipes.gcloud.label).toBe("GC custom");
		expect(recipes.mytool.label).toBe("My Tool");
		// 其余内置不能被用户文件抹掉
		expect(recipes.gh).toBe(BUILTIN_RECIPES.gh);
	});

	it("坏 JSON → 回落到内置并给出 error（不抛）", () => {
		const home = tmp();
		const { path } = loadRecipes(home);
		mkdirSync(join(home, ".config", "cli-auth"), { recursive: true });
		writeFileSync(path, "{ esto no es json");
		const { recipes, error } = loadRecipes(home);
		expect(error).toBeTruthy();
		expect(recipes.gcloud).toBe(BUILTIN_RECIPES.gcloud);
	});
});

describe("机制：note", () => {
	it("只提示，不跑命令", async () => {
		const h = harness(null);
		const done = await runCliAuth("tofu", { note: "usa credenciales de cloud" }, h.deps);
		expect(done).toBe(true);
		expect(h.notices[0].textEn).toContain("usa credenciales de cloud");
		expect(h.deps.cwd).toBe(h.home);
	});
});

describe("机制：key", () => {
	it("提问标记为 secret，并把密钥写进命令的 stdin", async () => {
		const h = harness(ok("sk-test-123"));
		const out = join(h.home, "out.txt");
		process.env.CLI_AUTH_TEST_OUT = out;
		await runCliAuth("t", { key: { prompt: "Token", command: 'cat > "$CLI_AUTH_TEST_OUT"' } }, h.deps);
		expect(h.asks[0][0].secret).toBe(true);
		expect(readFileSync(out, "utf8").trim()).toBe("sk-test-123");
		delete process.env.CLI_AUTH_TEST_OUT;
	});

	it("key.target → 直接落文件，且权限 0600", async () => {
		const h = harness(ok("tok"));
		await runCliAuth("t", { key: { prompt: "T", target: ".config/t/creds" } }, h.deps);
		const f = join(h.home, ".config", "t", "creds");
		expect(existsSync(f)).toBe(true);
		expect(readFileSync(f, "utf8").trim()).toBe("tok");
		expect(statSync(f).mode & 0o777).toBe(0o600);
	});

	it("空提交 = 跳过（不是失败）", async () => {
		const h = harness(ok(""));
		const done = await runCliAuth("t", { key: { prompt: "T", command: "false" } }, h.deps);
		expect(done).toBe(true);
		expect(h.notices.some((n) => n.textEn.includes("Skipped"))).toBe(true);
		expect(h.flows).toEqual([]);
	});

	it("用户取消 → false", async () => {
		const h = harness(null);
		expect(await runCliAuth("t", { key: { prompt: "T", command: "true" } }, h.deps)).toBe(false);
	});
});

describe("机制：deviceCode", () => {
	it("从输出里提取 URL + 验证码并推给前端", async () => {
		const h = harness(null);
		const recipe: CliAuthRecipe = {
			creds: [h.home], // 用一个一定存在的路径，避免 creds 警告
			deviceCode: {
				command: `printf 'Go to https://example.com/device and enter ABCD-1234\\n'`,
				urlPattern: "https://[^\\s]+",
				codePattern: "\\b[A-Z]{4}-[0-9]{4}\\b",
			},
		};
		await runCliAuth("t", recipe, h.deps);
		const dc = h.flows.find((f) => f.state === "device_code");
		expect(dc?.userCode).toBe("ABCD-1234");
		expect(dc?.verificationUri).toBe("https://example.com/device");
		expect(h.flows.at(-1)?.state).toBe("done");
	});

	it("命令失败 → error + 回显原因（不是静默成功）", async () => {
		const h = harness(null);
		await runCliAuth("t", { deviceCode: { command: "echo boom; exit 3" } }, h.deps);
		expect(h.flows.at(-1)?.state).toBe("error");
		expect(h.flows.at(-1)?.message).toContain("boom");
		expect(h.notices.at(-1)?.level).toBe("error");
	});

	it("命令成功但凭据不存在 → warning（不能说成功）", async () => {
		const h = harness(null);
		await runCliAuth("t", { creds: ["~/.config/definitely-not-there"], deviceCode: { command: "true" } }, h.deps);
		expect(h.flows.at(-1)?.state).toBe("done");
		expect(h.notices.at(-1)?.level).toBe("warning");
		expect(h.notices.at(-1)?.textEn).toContain("verify the sign-in");
	});
});

describe("机制：manualCode", () => {
	it("提取 URL、把用户贴回来的码写进 stdin", async () => {
		const h = harness(ok("4/0AX-code"));
		const out = join(h.home, "got.txt");
		process.env.CLI_AUTH_TEST_OUT = out;
		const recipe: CliAuthRecipe = {
			creds: [h.home],
			manualCode: {
				command: `printf 'Visit https://accounts.example.com/o/oauth?x=1\\n'; read code; printf '%s' "$code" > "$CLI_AUTH_TEST_OUT"`,
				urlPattern: "https://[^\\s]+",
			},
		};
		const done = await runCliAuth("t", recipe, h.deps);
		expect(done).toBe(true);
		expect(h.flows.find((f) => f.state === "device_code")?.verificationUri).toBe(
			"https://accounts.example.com/o/oauth?x=1",
		);
		expect(readFileSync(out, "utf8")).toBe("4/0AX-code");
		delete process.env.CLI_AUTH_TEST_OUT;
	});

	it("用户取消 → 杀掉进程并返回 false", async () => {
		const h = harness(null);
		const done = await runCliAuth("t", { manualCode: { command: "sleep 30", urlPattern: "https://x" } }, h.deps);
		expect(done).toBe(false);
	});
});

describe("菜谱错误", () => {
	it("没有任何可用机制 → 抛错（配置错误不该静默）", async () => {
		const h = harness(null);
		await expect(runCliAuth("t", { label: "vacío" }, h.deps)).rejects.toThrow(/no available sign-in/);
	});
});
