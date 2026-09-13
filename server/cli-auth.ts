/**
 * cli-auth — 命令行工具（CLI）的登录编排（RFC 002 第 1 阶段）。
 *
 * 目标：像 `/login` 之于模型供应商那样，让 **CLI 工具**也能从 UI 完成认证，
 * 凭据落在持久化的 `~/.config`（第 0 阶段已完成）。
 *
 * 设计：机制只有三种，覆盖真实 CLI 的全部行为 ——
 *
 *   1. `key`        向用户索要 API key / PAT，经 stdin 传给命令（或直接落文件）。
 *                   例：`gh auth login --with-token`
 *   2. `deviceCode` CLI 自己打印「URL + 验证码」，用户在浏览器输入验证码即可。
 *                   例：`az login --use-device-code`
 *   3. `manualCode` CLI 打印 URL，然后要求把浏览器里的码 **贴回来**。
 *                   例：`gcloud auth login --no-launch-browser`（我们真正缺的那个）
 *
 *   （另有 `note`：不需要显式登录、消费其他工具凭据的，如 tofu/terraform。）
 *
 * 菜谱（recipe）= 数据，不是代码：
 *   - 内置常用工具（见 BUILTIN_RECIPES）
 *   - 用户可在 `~/.config/cli-auth/recipes.yaml` 增补/覆盖 —— 加一个新工具
 *     不需要改代码、不需要重建镜像、不需要新的挂载点。
 *
 * 本模块不碰 UI：进度经 `auth_flow` 推送（前端复用 /login 的横幅），
 * 提问经 `question_pending`/`question_answer`（复用 DshQuestionDialog）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { QuestionAnswer, UiQuestion } from "./protocol.js";

/** 进度/提示消息（SlashHost.emit 的子集，便于单测）。 */
export type CliAuthEmit = (
	msg:
		| {
				type: "auth_flow";
				state: "device_code" | "waiting" | "done" | "error";
				verificationUri?: string;
				userCode?: string;
				message?: string;
		  }
		| { type: "notice"; level: "info" | "warning" | "error"; text: string; textEn: string },
) => void;

export interface CliAuthDeps {
	emit: CliAuthEmit;
	/** 交互式提问（复用 /login 的机制）；缺省则无法完成需要输入的流程。 */
	askUser?: (questions: UiQuestion[]) => Promise<QuestionAnswer[] | null>;
	/** 登录命令的工作目录（缺省 $HOME）。 */
	cwd?: string;
	/** 用于展开 `~`，便于测试注入。 */
	home?: string;
}

/** `key`：向用户索要密钥。`command` 经 stdin 收密钥；`target` 则直接落文件。 */
export interface KeyRecipe {
	prompt: string;
	detail?: string;
	command?: string;
	/** 相对 `~` 或绝对路径；父目录会自动创建。 */
	target?: string;
}

/** `deviceCode`：CLI 自己打印 URL + 验证码。 */
export interface DeviceCodeRecipe {
	command: string;
	urlPattern?: string;
	codePattern?: string;
}

/** `manualCode`：CLI 打印 URL，用户把浏览器里的码贴回来。 */
export interface ManualCodeRecipe {
	command: string;
	urlPattern?: string;
	prompt?: string;
}

export interface CliAuthRecipe {
	label?: string;
	/** 凭据落点（信息性 + 登录后校验）。 */
	creds?: string[];
	key?: KeyRecipe;
	deviceCode?: DeviceCodeRecipe;
	manualCode?: ManualCodeRecipe;
	/** 不需要显式登录（消费其他工具的凭据）。 */
	note?: string;
}

// ---------------------------------------------------------------------------
// 内置菜谱
// ---------------------------------------------------------------------------

const DEFAULT_URL = "https?://[^\\s\"'<>]+";
const DEFAULT_CODE = "\\b[A-Z0-9]{4,6}(?:-[A-Z0-9]{4,6}){0,3}\\b";

/** 注意：`creds` 用 `~` 相对路径，运行期展开。 */
export const BUILTIN_RECIPES: Record<string, CliAuthRecipe> = {
	gcloud: {
		label: "Google Cloud",
		creds: ["~/.config/gcloud"],
		// gcloud 打印 URL，然后把浏览器里的验证码贴回 stdin —— 不是标准 device flow。
		manualCode: {
			command: "gcloud auth login --no-launch-browser --update-adc",
			urlPattern: DEFAULT_URL,
			prompt: "把浏览器里的验证码贴进来 / Paste the verification code from the browser",
		},
	},
	az: {
		label: "Azure",
		creds: ["~/.config/azure"],
		deviceCode: {
			command: "az login --use-device-code",
			urlPattern: DEFAULT_URL,
			codePattern: DEFAULT_CODE,
		},
	},
	gh: {
		label: "GitHub CLI",
		creds: ["~/.config/gh/hosts.yml"],
		key: {
			prompt: "GitHub Personal Access Token / PAT",
			detail: "留空则改用 `gh auth login`（设备码流程）在终端完成 / Leave blank to use `gh auth login` in the terminal",
			command: "gh auth login --with-token",
		},
	},
	aws: {
		label: "AWS",
		creds: ["~/.config/aws"],
		note: "AWS 需要多段输入（keyID + secret + region），请在终端执行 `aws configure`（凭据会落在 ~/.config/aws，持久化）/ AWS needs several inputs: run `aws configure` in the terminal",
	},
	terraform: {
		label: "Terraform",
		creds: ["~/.terraform.d"],
		note: "Terraform 消费云凭据（先 /cli_auth gcloud|az|aws）；只有 Terraform Cloud 需要 `terraform login` / Terraform consumes cloud credentials",
	},
	tofu: {
		label: "OpenTofu",
		creds: ["~/.terraform.d"],
		note: "OpenTofu 与 Terraform 同理：消费云凭据，本身不登录 / OpenTofu consumes cloud credentials",
	},
};

// ---------------------------------------------------------------------------
// 用户菜谱：~/.config/cli-auth/recipes.yaml
// ---------------------------------------------------------------------------

export interface CliAuthRecipeFile {
	/** 说明性字段（本模块忽略），让配置文件能自我解释。 */
	_readme?: string | string[];
	recipes?: Record<string, CliAuthRecipe>;
}

/**
 * 菜谱文件路径（`CLI_AUTH_RECIPES` 可覆盖，便于测试）。
 *
 * 用 JSON 而非 YAML 是刻意的：项目里没有声明 YAML 解析器（`js-yaml` 只是传递
 * 依赖，靠它很脆弱，显式声明又会给每次 upstream 同步增加 package.json 冲突）。
 * 零依赖换来确定性 —— 这个文件对操作者来说足够小，用 JSON 完全够用。
 * `_readme` 字段用来补上 JSON 没有注释这一短板。
 */
export function recipesPath(home = homedir()): string {
	return process.env.CLI_AUTH_RECIPES || join(home, ".config", "cli-auth", "recipes.json");
}

/**
 * 合并内置 + 用户菜谱。用户可以新增工具，也可以覆盖内置项（例如换登录命令）。
 * 文件不存在 / 解析失败 → 只用内置，并返回 `error` 供调用方提示（不抛）。
 */
export function loadRecipes(home = homedir()): {
	recipes: Record<string, CliAuthRecipe>;
	error?: string;
	path: string;
} {
	const path = recipesPath(home);
	const out: Record<string, CliAuthRecipe> = { ...BUILTIN_RECIPES };
	if (!existsSync(path)) return { recipes: out, path };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CliAuthRecipeFile;
		for (const [tool, recipe] of Object.entries(parsed.recipes ?? {})) {
			if (recipe && typeof recipe === "object") out[tool] = recipe;
		}
		return { recipes: out, path };
	} catch (err) {
		return { recipes: out, path, error: err instanceof Error ? err.message : String(err) };
	}
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

/** 展开 `~`；相对路径按「相对 HOME」处理（契约见字段注释），而不是相对进程 CWD。 */
const expandHome = (p: string, home: string): string => {
	if (p.startsWith("~")) return join(home, p.slice(1).replace(/^[/\\]/, ""));
	return isAbsolute(p) ? p : join(home, p);
};

/** 在累积输出里找第一个匹配；找不到返回 undefined。 */
function firstMatch(text: string, pattern?: string): string | undefined {
	if (!pattern) return undefined;
	try {
		const m = text.match(new RegExp(pattern));
		return m?.[0];
	} catch {
		return undefined;
	}
}

/** 命令尾部的若干行，用于把失败原因回显给用户（而不是只说「失败」）。 */
function tail(text: string, lines = 3): string {
	return text
		.trim()
		.split("\n")
		.filter((l) => l.trim())
		.slice(-lines)
		.join(" · ");
}

interface RunResult {
	code: number | null;
	output: string;
}

/**
 * 运行命令，可选地把一段输入写进 stdin，并可选地在输出里监听 pattern
 * （命中一次即回调，用于「拿到 URL/验证码就立刻推给前端」）。
 */
function run(
	command: string,
	opts: {
		cwd: string;
		stdin?: string;
		/** 保持 stdin 打开，稍后由调用方写入（manualCode：等用户贴验证码）。 */
		keepStdin?: boolean;
		watch?: { re: string; onMatch: (found: string, output: string) => void };
	} = { cwd: homedir() },
): { done: Promise<RunResult>; proc: ChildProcessWithoutNullStreams } {
	const proc = spawn(command, {
		shell: true,
		cwd: opts.cwd,
		env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
	}) as ChildProcessWithoutNullStreams;

	let output = "";
	let matched = false;
	const onChunk = (buf: Buffer) => {
		output += buf.toString("utf8");
		if (!matched && opts.watch) {
			const found = firstMatch(output, opts.watch.re);
			if (found) {
				matched = true;
				opts.watch.onMatch(found, output);
			}
		}
	};
	proc.stdout.on("data", onChunk);
	proc.stderr.on("data", onChunk);

	if (opts.stdin !== undefined) {
		proc.stdin.write(opts.stdin.endsWith("\n") ? opts.stdin : `${opts.stdin}\n`);
	}
	// manualCode 需要等用户回答后再写 stdin —— 此时不能提前关掉它。
	if (!opts.keepStdin) proc.stdin.end();

	const done = new Promise<RunResult>((resolve) => {
		proc.on("error", (err) => resolve({ code: -1, output: `${output}\n${err.message}` }));
		proc.on("close", (code) => resolve({ code, output }));
	});
	return { done, proc };
}

/** 成功/失败的统一收尾（顺带校验凭据是否真的出现了）。 */
function report(tool: string, recipe: CliAuthRecipe, result: RunResult, deps: CliAuthDeps): void {
	const home = deps.home ?? homedir();
	const { emit } = deps;
	if (result.code !== 0) {
		const why = tail(result.output) || `exit ${result.code}`;
		emit({ type: "auth_flow", state: "error", message: why });
		emit({
			type: "notice",
			level: "error",
			text: `${tool} 登录失败：${why}`,
			textEn: `${tool} sign-in failed: ${why}`,
		});
		return;
	}
	// 校验凭据落点：命令退出 0 不等于真的写了凭据。
	const missing = (recipe.creds ?? []).map((c) => expandHome(c, home)).filter((p) => !existsSync(p));
	const where = (recipe.creds ?? []).join(", ") || "~/.config";
	if (missing.length > 0) {
		emit({ type: "auth_flow", state: "done", message: tool });
		emit({
			type: "notice",
			level: "warning",
			text: `${tool} 命令已完成，但没看到凭据落点（${where}）——请确认是否真的登录成功`,
			textEn: `${tool} finished, but no credentials found at ${where} — verify the sign-in actually worked`,
		});
		return;
	}
	emit({ type: "auth_flow", state: "done", message: tool });
	emit({
		type: "notice",
		level: "info",
		text: `✅ 已登录 ${tool}（凭据在 ${where}，持久化）`,
		textEn: `✅ Signed in to ${tool} (credentials in ${where}, persisted)`,
	});
}

/** 一道提示题（复用 question_pending 协议）。取消 → undefined。 */
async function ask(
	deps: CliAuthDeps,
	q: { header?: string; question: string; detail?: string; secret?: boolean },
): Promise<string | undefined> {
	const askUser = deps.askUser;
	if (!askUser) throw new Error("当前宿主不支持交互式提问（askUser 未接线）");
	const answers = await askUser([{ id: "cli-auth", ...q }]);
	// 取消 = answers 为空数组；「提交空值」= [{ selected: [] }]，两者必须区分。
	if (!answers || answers.length === 0) return undefined;
	const custom = answers[0]?.custom;
	if (custom !== undefined) return custom.trim();
	return answers[0]?.selected?.[0] ?? "";
}

/**
 * 执行一个工具（或列表）的登录。多个机制并存时依次尝试，第一个成功的即止。
 * 全部取消 → 返回 false（调用方给「已取消」提示）。
 */
export async function runCliAuth(tool: string, recipe: CliAuthRecipe, deps: CliAuthDeps): Promise<boolean> {
	const home = deps.home ?? homedir();
	const cwd = deps.cwd ?? home;
	const { emit } = deps;

	// --- note：不需要显式登录 ---------------------------------------------
	if (recipe.note && !recipe.key && !recipe.deviceCode && !recipe.manualCode) {
		emit({
			type: "notice",
			level: "info",
			text: `${tool}：${recipe.note}`,
			textEn: `${tool}: ${recipe.note}`,
		});
		return true;
	}

	// --- key：索要密钥 → stdin（或直接落文件） ----------------------------
	if (recipe.key) {
		const answer = await ask(deps, {
			header: recipe.label ?? tool,
			question: recipe.key.prompt,
			detail: recipe.key.detail,
			secret: true,
		});
		if (answer === undefined) return false;
		if (answer === "" && recipe.key.command) {
			// 留空 = 用户选择放弃这条路（例如 gh 改用终端里的设备码流程）。
			emit({
				type: "notice",
				level: "info",
				text: `已跳过 ${tool} 的密钥登录`,
				textEn: `Skipped key sign-in for ${tool}`,
			});
			return true;
		}
		if (recipe.key.target) {
			const target = expandHome(recipe.key.target, home);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, `${answer}\n`, { mode: 0o600 });
		} else if (recipe.key.command) {
			emit({ type: "auth_flow", state: "waiting", message: `${tool}…` });
			const { done } = run(recipe.key.command, { cwd, stdin: answer });
			report(tool, recipe, await done, deps);
			return true;
		} else {
			throw new Error(`${tool} recipe has neither key.command nor key.target`);
		}
		report(tool, recipe, { code: 0, output: "" }, deps);
		return true;
	}

	// --- deviceCode：CLI 自己打印 URL + 验证码 ----------------------------
	if (recipe.deviceCode) {
		const { done } = run(recipe.deviceCode.command, {
			cwd,
			watch: {
				re: recipe.deviceCode.codePattern ?? DEFAULT_CODE,
				onMatch: (code, output) => {
					emit({
						type: "auth_flow",
						state: "device_code",
						userCode: code,
						verificationUri: firstMatch(output, recipe.deviceCode?.urlPattern),
					});
				},
			},
		});
		emit({ type: "auth_flow", state: "waiting", message: `${tool}…` });
		report(tool, recipe, await done, deps);
		return true;
	}

	// --- manualCode：CLI 打印 URL，用户把码贴回来 --------------------------
	if (recipe.manualCode) {
		let url: string | undefined;
		const proc = run(recipe.manualCode.command, {
			cwd,
			keepStdin: true,
			watch: {
				re: recipe.manualCode.urlPattern ?? DEFAULT_URL,
				onMatch: (found) => {
					url = found;
					emit({ type: "auth_flow", state: "device_code", verificationUri: found, userCode: "" });
				},
			},
		});
		emit({ type: "auth_flow", state: "waiting", message: `${tool}…` });
		const code = await ask(deps, {
			header: recipe.label ?? tool,
			question: recipe.manualCode.prompt ?? "把浏览器里的验证码贴进来 / Paste the verification code",
			detail: url ? `${url}` : undefined,
		});
		if (code === undefined) {
			proc.proc.kill();
			return false;
		}
		proc.proc.stdin.write(`${code}\n`);
		report(tool, recipe, await proc.done, deps);
		return true;
	}

	throw new Error(`${tool} recipe has no available sign-in mechanism (key / deviceCode / manualCode / note)`);
}
