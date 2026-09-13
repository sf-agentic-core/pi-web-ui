/**
 * tool-install — 工具安装编排（RFC 002 第 2 阶段）。
 *
 * 让 agent 能像 `apt-get install` 一样装工具，但**装进持久卷**：
 *   - 二进制落在 `~/.local`（PVC，第 2 阶段基础设施已挂载）
 *   - `~/.local/bin` 已在 PATH 最前（所以装完立刻可用）
 *
 * 用 `mise` 作为版本管理器（RFC 002 决策：**版本管理器，不是清单**）：
 *   - 动态：`/tool install tofu@1.9` 装任何它注册表里有的工具
 *   - 持久：数据在 `$MISE_DATA_DIR`（= `~/.local/share/mise`，PVC 上）
 *   - 可复现（可选）：`mise use -g` 会把工具写进全局 config
 *     （`~/.config/mise/config.toml`，同样在 PVC 上）——那就是 RFC 里说的
 *     「清单是事实，二进制是缓存」
 *
 * mise 不在镜像里（把基础镜像重打需要跨 3 个仓库，另开一次改动），所以这里
 * **按固定版本**从 GitHub Releases 下载到 `~/.local/bin`。这是一次性的，
 * 之后就在持久卷上。
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliAuthEmit } from "./cli-auth.js";
import { findOnPath, runCommand } from "./cli-auth.js";

/** 固定版本：可复现，不用「latest」这种会漂的别名。 */
export const MISE_VERSION = "v2026.9.6";

export interface ToolDeps {
	emit: CliAuthEmit;
	home?: string;
	/** 用于测试注入：直接指定 mise 可执行文件。 */
	mise?: string;
}

const homeOf = (deps: ToolDeps): string => deps.home ?? homedir();

/** `process.arch` → mise 的发布物后缀。 */
function miseAsset(): string | undefined {
	const arch = { x64: "x64", arm64: "arm64" }[process.arch as "x64" | "arm64"];
	return arch ? `mise-${MISE_VERSION}-linux-${arch}` : undefined;
}

/** mise 可执行文件路径：注入的 → PATH 上 → `~/.local/bin/mise`。 */
export function findMise(deps: ToolDeps): string | undefined {
	if (deps.mise) return deps.mise;
	const local = join(homeOf(deps), ".local", "bin", "mise");
	if (existsSync(local)) return local;
	return findOnPath("mise");
}

/**
 * 确保 mise 可用：没有就按固定版本下载到 `~/.local/bin`（持久卷）。
 * 返回可执行文件路径；用户取消 → undefined。
 */
export async function ensureMise(deps: ToolDeps): Promise<string | undefined> {
	const existing = findMise(deps);
	if (existing) return existing;

	const asset = miseAsset();
	if (!asset) throw new Error(`不支持的架构：${process.arch} / unsupported architecture`);
	const url = `https://github.com/jdx/mise/releases/download/${MISE_VERSION}/${asset}`;
	const dest = join(homeOf(deps), ".local", "bin", "mise");
	mkdirSync(join(homeOf(deps), ".local", "bin"), { recursive: true });

	deps.emit({
		type: "auth_flow",
		state: "waiting",
		message: `下载 mise ${MISE_VERSION}…`,
	});
	deps.emit({
		type: "notice",
		level: "info",
		text: `首次使用：正在下载 mise ${MISE_VERSION}（约 100MB，只需一次）`,
		textEn: `First run: downloading mise ${MISE_VERSION} (~100MB, one time only)`,
	});

	const res = spawnSync("curl", ["-fsSL", "--retry", "3", "-o", dest, url], {
		encoding: "utf8",
		timeout: 300_000,
	});
	if (res.status !== 0) {
		throw new Error(`下载 mise 失败 / failed to download mise: ${(res.stderr || "").trim() || `exit ${res.status}`}`);
	}
	chmodSync(dest, 0o755);
	return dest;
}

/** `mise` 装出来的 shim 目录（也是工具可执行文件的入口）。 */
export function miseShimsDir(deps: ToolDeps): string {
	return join(process.env.MISE_DATA_DIR || join(homeOf(deps), ".local", "share", "mise"), "shims");
}

/**
 * 把 shim 链接进 `~/.local/bin`（已在 PATH 最前）。
 *
 * 为什么需要：mise 的 shim 在 `$MISE_DATA_DIR/shims`，那不在 PATH 上。与其再改
 * 一次 ConfigMap 的 PATH，不如把 shim 链到已经生效的目录 —— 链接指向 shim，
 * 版本选择仍由 mise 负责，所以这个链接是稳定的。
 */
function linkShims(deps: ToolDeps, names: string[]): void {
	const binDir = join(homeOf(deps), ".local", "bin");
	mkdirSync(binDir, { recursive: true });
	const shims = miseShimsDir(deps);
	for (const n of names) {
		const src = join(shims, n);
		const dst = join(binDir, n);
		if (!existsSync(src)) continue;
		try {
			symlinkSync(src, dst);
		} catch {
			/* 已存在就算成功 */
		}
	}
}

/** shims 目录里所有可用命令名（用于把新装的工具链接进来）。 */
function shimNames(deps: ToolDeps): string[] {
	const dir = miseShimsDir(deps);
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * `spec` 会被拼进 shell 命令，所以必须严格校验 —— 否则就是一个注入点。
 * 允许 mise 的写法：`name` / `name@version` / `backend:name@version`。
 */
const SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?::[A-Za-z0-9._+-]+)?(?:@[A-Za-z0-9._+-]+)?$/;

export function validSpec(spec: string): boolean {
	return spec.length <= 80 && SPEC_RE.test(spec);
}

export interface InstallResult {
	ok: boolean;
	/** 装完后在 PATH 上找到的可执行文件。 */
	binary?: string;
}

/**
 * 安装一个工具。`spec` 形如 `tofu` 或 `tofu@1.9.0`（缺省版本 = mise 的默认）。
 */
export async function installTool(spec: string, deps: ToolDeps): Promise<InstallResult> {
	if (!validSpec(spec)) {
		deps.emit({
			type: "notice",
			level: "error",
			text: `无效的工具名：${spec}（只允许字母、数字、. _ + - : @）`,
			textEn: `Invalid tool name: ${spec} (only letters, digits, . _ + - : @)`,
		});
		return { ok: false };
	}
	const mise = await ensureMise(deps);
	if (!mise) return { ok: false };
	// `use -g` 既安装又写进全局 config（= 可复现的「清单」）。
	const res = runCommand(`${mise} use -g ${spec}`, { cwd: homeOf(deps) });
	const { code, output } = await res.done;
	if (code !== 0) {
		const why = output.trim().split("\n").slice(-3).join(" · ");
		deps.emit({
			type: "notice",
			level: "error",
			text: `安装 ${spec} 失败：${why}`,
			textEn: `Failed to install ${spec}: ${why}`,
		});
		return { ok: false };
	}
	// 让新工具的 shim 出现在 PATH 上（见 linkShims 的说明）。
	runCommand(`${mise} reshim`, { cwd: homeOf(deps) });
	linkShims(deps, shimNames(deps));

	const bin = spec.split("@")[0];
	const found = findOnPath(bin);
	deps.emit({
		type: "auth_flow",
		state: "done",
		message: spec,
	});
	deps.emit({
		type: "notice",
		level: "info",
		text: found
			? `✅ 已安装 ${spec}（${found}，持久化：重启 pod 后仍在）`
			: `✅ 已安装 ${spec}（持久化）。提示：可执行文件名可能与包名不同，用 /tool list 查看`,
		textEn: found
			? `✅ Installed ${spec} (${found}, persisted across pod restarts)`
			: `✅ Installed ${spec} (persisted). Note: the binary name may differ from the package name — see /tool list`,
	});
	return { ok: true, binary: found };
}

/** 已安装的工具列表（`mise ls`，去掉表头）。 */
export async function listTools(deps: ToolDeps): Promise<string[]> {
	const mise = findMise(deps);
	if (!mise) return [];
	const res = runCommand(`${mise} ls --porcelain`, { cwd: homeOf(deps) });
	const { code, output } = await res.done;
	if (code !== 0) return [];
	return output
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}
