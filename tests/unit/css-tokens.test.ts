/**
 * 自定义属性（CSS 变量）引用体检。
 *
 * 背景：引用一个**从未定义**的 token 时，CSS 规范按 guaranteed-invalid 处理 ——
 * 该声明在计算值阶段整体失效：
 *   · 不带 fallback → 属性回落到 initial/unset（背景、阴影直接没了）；
 *   · 带 fallback   → 静默改用硬编码值（插件里写的 #16161d 在浅色主题下必错）。
 * 主应用只定义 `--bg-elev`/`--bg-elev2`/`--bg-elev3`，却长期写着从未存在的
 * `--bg-elev1`（`git log --all -S"--bg-elev1:"` 为空）：结果 goalbar 全家没有填充、
 * 输入框丢掉整条 box-shadow、插件按钮在白色/暖纸/雾蓝/樱粉主题下是深色块。
 *
 * 本测试是**静态**体检：只读源文件文本，毫秒级、零端口、零浏览器（CI 必跑）。
 * 扫描范围：web/src、plugins、themes、web/index.html（server/extensions/desktop
 * 里没有内联 CSS，不必扫）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 锚到仓库根（不用 process.cwd()：vitest 从别的工作目录跑时 cwd 不是仓库根，
// 扫描会直接 ENOENT，报错信息也看不出原因）。repo 内其他单测同惯例。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 运行时注入的自定义属性：不在任何 CSS 文件里声明，只由 JS 设置。 */
const RUNTIME_TOKENS = new Map<string, string>([
	["--fp-zoom", "web/src/components/FilePreview.tsx（inline style）"],
	["--left-w", "web/src/App.tsx（inline style，面板拖拽宽度）"],
	["--right-w", "web/src/App.tsx（inline style，面板拖拽宽度）"],
	["--rail-gap", "web/src/components/MessageList.tsx（inline style）"],
	["--scm-sidebar-w", "web/src/components/SCMPanel.tsx（inline style，Git 左栏拖拽宽度，issue #139）"],
	["--msgs-gutter", "web/src/scrollbar-gutter.ts（style.setProperty）"],
]);

/**
 * 刻意写的外部中性兜底：这些名字属于「组件在宿主之外也能看」的写法，fallback 就是
 * 设计本身（transparent / var(--border) / 中性灰），保持原样。
 */
const GUEST_FALLBACK_TOKENS = new Set(["--bg-input", "--border-subtle", "--muted", "--warning"]);

/** 第三方 vendored 前缀：monaco 编辑器自带一大票 --vscode-* 变量。 */
const VENDORED_PREFIXES = ["--vscode-"];

const SOURCE_EXT = /\.(css|mjs|js|ts|tsx|html)$/;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === ".git" || name === "dist") continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else if (SOURCE_EXT.test(name)) out.push(p);
	}
	return out;
}

interface VarRef {
	token: string;
	file: string;
	line: number;
	hasFallback: boolean;
}

/** 收集「定义过的 token」与「引用点」。定义按全仓取并集（同一 token 可在多处声明）。 */
function scanSources() {
	const defined = new Set<string>();
	const refs: VarRef[] = [];
	const files = [
		...walk(join(ROOT, "web/src")),
		...walk(join(ROOT, "plugins")),
		...walk(join(ROOT, "themes")),
		join(ROOT, "web/index.html"),
	];
	for (const file of files) {
		const rel = relative(ROOT, file);
		readFileSync(file, "utf8")
			.split("\n")
			.forEach((line, i) => {
				for (const m of line.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(m[1]);
				for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,?)/g)) {
					refs.push({ token: m[1], file: rel, line: i + 1, hasFallback: m[2] === "," });
				}
			});
	}
	return { defined, refs };
}

const { defined, refs } = scanSources();

const isExempt = (token: string) =>
	RUNTIME_TOKENS.has(token) ||
	GUEST_FALLBACK_TOKENS.has(token) ||
	VENDORED_PREFIXES.some((prefix) => token.startsWith(prefix));

const unresolved = (hasFallback: boolean): string[] =>
	refs
		.filter((r) => r.hasFallback === hasFallback && !defined.has(r.token) && !isExempt(r.token))
		.map((r) => `${r.token} → ${r.file}:${r.line}`);

describe("CSS 变量引用体检", () => {
	it("不带 fallback 的引用必须有定义（否则整条声明失效）", () => {
		expect(unresolved(false)).toEqual([]);
	});

	it("带 fallback 的引用也要有定义（fallback 会掩盖问题；vendored/运行时/中性兜底已豁免）", () => {
		expect(unresolved(true)).toEqual([]);
	});
});
