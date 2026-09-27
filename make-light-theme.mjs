#!/usr/bin/env node
/**
 * Regenerates the built-in themes as PURE PALETTE files (since the 布局与主题
 * 解耦 refactor):
 *
 *   themes/white.css     — 纯白底 + GitHub 蓝强调（浅色）
 *   themes/paper.css     — 暖纸米黄底 + 赭石强调（浅色护眼）
 *   themes/mist.css      — 雾蓝灰底 + 天青蓝强调（浅色冷淡风）
 *   themes/sakura.css    — 粉白底 + 樱粉强调（浅色柔和风）
 *   themes/md-preview.css— 暗色紫晕：深黑底 + 紫色径向渐变，chrome 全透明
 *   themes/cyberpunk.css — 赛博朋克（霓虹青/品红，近黑底）
 *   themes/dazzle.css    — 炫彩（高对比多彩，近黑底）
 *
 * THEMING MODEL: web/src/styles.css is the SINGLE layout file — it defines the
 * whole UI layout plus the default (dark) palette as :root CSS variables
 * (including the derived color vars like --tooltip-bg/--code-bg/--notice-*).
 * A theme is just a :root override of those variables — NO layout code ships
 * in theme files anymore, so layout changes never need to touch themes.
 *
 * The frontend (web/src/theme.ts applyTheme) injects <link>/themes/<id>.css
 * AFTER the bundled styles.css, so its :root variables win the cascade.
 *
 * Run whenever styles.css or a palette changes:
 *
 *   node make-light-theme.mjs
 *
 * User themes (<dataDir>/themes/<id>.css) follow the same model: just write
 * :root { ...vars... } (or drop a full standalone stylesheet if you must).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, "web", "src", "styles.css");

const css = readFileSync(srcPath, "utf8").replace(/\r\n/g, "\n");

// --- 1) parse the :root variable list (name → default value) from styles.css
// A theme only overrides the entries it wants; the generator emits the FULL
// list so styles.css adding a new variable automatically flows into every
// builtin theme (default value), keeping them in sync forever.
const rootBlock = css.match(/:root \{[^}]*\}/);
if (!rootBlock) throw new Error("make-light-theme: :root block not found in styles.css");
const defaults = new Map();
for (const line of rootBlock[0].split("\n")) {
	const m = line.match(/^\s*(--[a-z0-9-]+):\s*(.*?);\s*$/);
	if (m) defaults.set(m[1], m[2]);
}

/** Emit a theme file: full :root (defaults + overrides) + optional tail. */
const emitTheme = (name, overrides = {}, tail = "", nameEn = "") => {
	const lines = ["/* theme-name: " + name + " */"];
	if (nameEn) lines.push("/* theme-name-en: " + nameEn + " */");
	lines.push(":root {");
	// color-scheme: themes default to light unless told otherwise.
	lines.push("\tcolor-scheme: " + (overrides["color-scheme"] ?? "light") + ";");
	for (const [k, v] of defaults) {
		lines.push(`\t${k}: ${overrides[k] ?? v};`);
	}
	lines.push("}", "");
	return lines.join("\n") + tail;
};

const writeTheme = (name, file, body) => writeFileSync(join(here, "themes", file), body, "utf8");

// --- 2) palettes -----------------------------------------------------------
// Only the variables that differ from the dark default are listed. The light
// values mirror the old make-light-theme colorMap (dark surfaces → light).
const LIGHT_DERIVED = {
	"--tooltip-bg": "#ffffff",
	"--code-bg": "#f6f8fa",
	"--code-text": "#1f2937",
	"--err-text": "#dc2626",
	"--red-text": "#dc2626",
	"--amber-text": "#b45309",
	"--info-blue": "#2563eb",
	"--link": "#0969da",
	"--link-hover": "#0550ae",
	"--link-soft": "#0969da",
	"--md-strong": "#111827",
	"--skill-blue": "#2563eb",
	"--auth-green": "#059669",
	"--scroll-thumb": "#c7ccd8",
	"--scroll-thumb-hover": "#aab2c0",
	"--notice-err-bg": "#eadadf",
	"--notice-warn-bg": "#eae2dc",
	"--notice-info-bg": "#d8e0f3",
	"--notice-err-border": "#dc2626",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#2563eb",
	"--send-blue": "#0969da",
	"--send-blue-hover": "#0550ae",
	/* 收起/展开按钮的常驻对照色（issue #100）：浅色下用灰底灰边框 */
	"--control-fg": "#59636e",
	"--control-bg": "#f6f8fa",
	"--control-border": "#d0d7de",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(0, 0, 0, 0.03)",
	/* 凹陷内容面（右栏扩展 widgets 区等）：深色默认是 15% 黑（压在深底上只深一点点），
	   浅色下压到 4%（浅底上 15% 会变成一块明显的深灰），既与面板分区分层、
	   又不至于吃撑卡片（.widget 用 --bg-elev2） */
	"--sunken-bg": "rgba(0, 0, 0, 0.04)",
	"--glow-015": "rgba(0, 0, 0, 0.02)",
	"--glow-025": "rgba(0, 0, 0, 0.02)",
	"--glow-03": "rgba(0, 0, 0, 0.02)",
	"--glow-04": "rgba(0, 0, 0, 0.03)",
	"--glow-05": "rgba(0, 0, 0, 0.03)",
	"--glow-12": "rgba(0, 0, 0, 0.08)",
	"--glow-18": "rgba(0, 0, 0, 0.12)",
	"--glow-22": "rgba(0, 0, 0, 0.15)",
	"--glow-38": "rgba(0, 0, 0, 0.25)",
};

// 「白色」— pure white page, GitHub-blue accents (vs. violet in LIGHT).
const WHITE = {
	"color-scheme": "light",
	"--bg": "#ffffff",
	"--bg-elev": "#ffffff",
	"--bg-elev2": "#f6f8fa",
	"--border": "#d0d7de",
	"--border-soft": "#d8dee4",
	"--text": "#1f2328",
	"--text-dim": "#59636e",
	"--text-faint": "#818b98",
	"--accent": "#0969da",
	"--accent-soft": "rgba(9, 105, 218, 0.1)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#dc2626",
	"--red-soft": "rgba(220, 38, 38, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#ffffff",
	"--term-fg": "#1f2328",
	"--term-cursor": "#0969da",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(9, 105, 218, 0.32)",
	"--term-black": "#e8eaf0",
	"--term-red": "#dc2626",
	"--term-green": "#059669",
	"--term-yellow": "#d97706",
	"--term-blue": "#2563eb",
	"--term-magenta": "#9333ea",
	"--term-cyan": "#0e7490",
	"--term-white": "#1f2328",
	"--term-bright-black": "#8a91a3",
	"--term-bright-red": "#dc2626",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#2563eb",
	"--term-bright-magenta": "#9333ea",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#000000",
	...LIGHT_DERIVED,
	// 品牌渐变保持紫色系（原 colorMap 不改它）
};

// 「暖纸」— warm paper page, 赭石 accents (vs. GitHub-blue in WHITE).
const PAPER = {
	"color-scheme": "light",
	"--bg": "#f7f1e3",
	"--bg-elev": "#fffdf6",
	"--bg-elev2": "#efe7d3",
	"--border": "#ddcfae",
	"--border-soft": "#e7dcc2",
	"--text": "#3f372c",
	"--text-dim": "#6f6250",
	"--text-faint": "#a2937a",
	"--accent": "#b45309",
	"--accent-soft": "rgba(180, 83, 9, 0.12)",
	"--green": "#15803d",
	"--green-soft": "rgba(21, 128, 61, 0.12)",
	"--red": "#b91c1c",
	"--red-soft": "rgba(185, 28, 28, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#f7f1e3",
	"--term-fg": "#3f372c",
	"--term-cursor": "#b45309",
	"--term-cursor-accent": "#fffdf6",
	"--term-selection": "rgba(180, 83, 9, 0.28)",
	"--term-black": "#e2d5b8",
	"--term-red": "#b91c1c",
	"--term-green": "#15803d",
	"--term-yellow": "#a16207",
	"--term-blue": "#1d4ed8",
	"--term-magenta": "#9333ea",
	"--term-cyan": "#0e7490",
	"--term-white": "#3f372c",
	"--term-bright-black": "#a2937a",
	"--term-bright-red": "#b91c1c",
	"--term-bright-green": "#15803d",
	"--term-bright-yellow": "#a16207",
	"--term-bright-blue": "#1d4ed8",
	"--term-bright-magenta": "#9333ea",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#1c1917",
	"--brand-grad-a": "#d97706",
	"--brand-grad-b": "#b45309",
	"--send-blue": "#b45309",
	"--send-blue-hover": "#92400e",
	"--link": "#9a3412",
	"--link-hover": "#7c2d12",
	"--link-soft": "#9a3412",
	"--md-strong": "#292019",
	"--skill-blue": "#b45309",
	"--info-blue": "#1d4ed8",
	"--auth-green": "#15803d",
	"--err-text": "#b91c1c",
	"--red-text": "#b91c1c",
	"--amber-text": "#92400e",
	"--code-bg": "#efe7d3",
	"--code-text": "#43382c",
	"--tooltip-bg": "#fffdf6",
	"--scroll-thumb": "#d3c4a3",
	"--scroll-thumb-hover": "#b8a67f",
	"--notice-err-bg": "#f5dcd2",
	"--notice-warn-bg": "#f0e5c8",
	"--notice-info-bg": "#e6dfc9",
	"--notice-err-border": "#b91c1c",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#57534e",
	/* 收起/展开按钮的常驻对照色（issue #100）：暖纸下用纸深灰底 */
	"--control-fg": "#6f6250",
	"--control-bg": "#efe7d3",
	"--control-border": "#ddcfae",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(120, 90, 30, 0.06)",
	/* 凹陷内容面：暖棕调与纸面对味（同 --bg-elev3 的调子，只低一点点） */
	"--sunken-bg": "rgba(120, 90, 30, 0.05)",
	"--glow-015": "rgba(120, 90, 30, 0.02)",
	"--glow-025": "rgba(120, 90, 30, 0.02)",
	"--glow-03": "rgba(120, 90, 30, 0.02)",
	"--glow-04": "rgba(120, 90, 30, 0.03)",
	"--glow-05": "rgba(120, 90, 30, 0.03)",
	"--glow-12": "rgba(120, 90, 30, 0.08)",
	"--glow-18": "rgba(120, 90, 30, 0.12)",
	"--glow-22": "rgba(120, 90, 30, 0.15)",
	"--glow-38": "rgba(120, 90, 30, 0.25)",
};

// 浅色主题的 hljs 覆盖（github-dark 静态打包，浅色下必须整块覆盖）——
// 属于「配色」而非布局，保留在主题文件里。
const hljsLight = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #1f2328;
	background: #f6f8fa;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #6e7781;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #24292f;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #24292f;
	font-style: italic;
}
.hljs-strong {
	color: #24292f;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #dafbe1;
}
.hljs-deletion {
	color: #82071e;
	background: #ffebe9;
}
`;

// 「雾蓝灰」— misty blue-gray page, 天青蓝 accents (vs. GitHub-blue in WHITE,
// warm 赭石 in PAPER).
const MIST = {
	"color-scheme": "light",
	"--bg": "#e9eef4",
	"--bg-elev": "#f8fafc",
	"--bg-elev2": "#dde5ec",
	"--border": "#cbd5e1",
	"--border-soft": "#dde5ec",
	"--text": "#1e293b",
	"--text-dim": "#475569",
	"--text-faint": "#94a3b8",
	"--accent": "#0284c7",
	"--accent-soft": "rgba(2, 132, 199, 0.12)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#dc2626",
	"--red-soft": "rgba(220, 38, 38, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#f8fafc",
	"--term-fg": "#1e293b",
	"--term-cursor": "#0284c7",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(2, 132, 199, 0.28)",
	"--term-black": "#dbe3ec",
	"--term-red": "#dc2626",
	"--term-green": "#059669",
	"--term-yellow": "#d97706",
	"--term-blue": "#2563eb",
	"--term-magenta": "#9333ea",
	"--term-cyan": "#0e7490",
	"--term-white": "#1e293b",
	"--term-bright-black": "#94a3b8",
	"--term-bright-red": "#dc2626",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#2563eb",
	"--term-bright-magenta": "#9333ea",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#020617",
	"--brand-grad-a": "#38bdf8",
	"--brand-grad-b": "#0284c7",
	"--send-blue": "#0284c7",
	"--send-blue-hover": "#0369a1",
	"--link": "#0284c7",
	"--link-hover": "#0369a1",
	"--link-soft": "#0284c7",
	"--md-strong": "#0f172a",
	"--skill-blue": "#0284c7",
	"--info-blue": "#2563eb",
	"--auth-green": "#059669",
	"--err-text": "#dc2626",
	"--red-text": "#dc2626",
	"--amber-text": "#b45309",
	"--code-bg": "#dde5ec",
	"--code-text": "#1e293b",
	"--tooltip-bg": "#ffffff",
	"--scroll-thumb": "#b6c2d1",
	"--scroll-thumb-hover": "#94a3b8",
	"--notice-err-bg": "#f9dee0",
	"--notice-warn-bg": "#f0e6cb",
	"--notice-info-bg": "#d9e6f5",
	"--notice-err-border": "#dc2626",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#2563eb",
	/* 收起/展开按钮的常驻对照色（issue #100）：雾蓝灰下用 slate 底 */
	"--control-fg": "#475569",
	"--control-bg": "#dde5ec",
	"--control-border": "#cbd5e1",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(30, 58, 95, 0.05)",
	/* 凹陷内容面：冷蓝调与雾蓝灰对味 */
	"--sunken-bg": "rgba(30, 58, 95, 0.05)",
	"--glow-015": "rgba(30, 58, 95, 0.02)",
	"--glow-025": "rgba(30, 58, 95, 0.02)",
	"--glow-03": "rgba(30, 58, 95, 0.02)",
	"--glow-04": "rgba(30, 58, 95, 0.03)",
	"--glow-05": "rgba(30, 58, 95, 0.03)",
	"--glow-12": "rgba(30, 58, 95, 0.08)",
	"--glow-18": "rgba(30, 58, 95, 0.12)",
	"--glow-22": "rgba(30, 58, 95, 0.15)",
	"--glow-38": "rgba(30, 58, 95, 0.25)",
};

// 暖纸主题的 hljs 覆盖：纸色底，其余 token 沿用浅色 GitHub 色系。
const hljsPaper = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #3f372c;
	background: #efe7d3;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #8a7d64;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #3f372c;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #3f372c;
	font-style: italic;
}
.hljs-strong {
	color: #3f372c;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #dfe8cf;
}
.hljs-deletion {
	color: #82071e;
	background: #f0d4c4;
}
`;

// 「樱粉」— 粉白底 + 樱粉强调（vs. GitHub 蓝 in WHITE / 赭石 in PAPER /
// 天青蓝 in MIST）。
const SAKURA = {
	"color-scheme": "light",
	"--bg": "#fdf2f5",
	"--bg-elev": "#fffbfc",
	"--bg-elev2": "#f8e2e8",
	"--border": "#eccdd6",
	"--border-soft": "#f4dde3",
	"--text": "#4a2b35",
	"--text-dim": "#7d5561",
	"--text-faint": "#b08e98",
	"--accent": "#db2777",
	"--accent-soft": "rgba(219, 39, 119, 0.12)",
	"--green": "#059669",
	"--green-soft": "rgba(5, 150, 105, 0.12)",
	"--red": "#e11d48",
	"--red-soft": "rgba(225, 29, 72, 0.1)",
	"--amber": "#d97706",
	"--term-bg": "#fffbfc",
	"--term-fg": "#4a2b35",
	"--term-cursor": "#db2777",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(219, 39, 119, 0.28)",
	"--term-black": "#eed3dc",
	"--term-red": "#e11d48",
	"--term-green": "#059669",
	"--term-yellow": "#d97706",
	"--term-blue": "#2563eb",
	"--term-magenta": "#c026d3",
	"--term-cyan": "#0e7490",
	"--term-white": "#4a2b35",
	"--term-bright-black": "#b08e98",
	"--term-bright-red": "#e11d48",
	"--term-bright-green": "#059669",
	"--term-bright-yellow": "#d97706",
	"--term-bright-blue": "#2563eb",
	"--term-bright-magenta": "#c026d3",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#2a1219",
	"--brand-grad-a": "#f472b6",
	"--brand-grad-b": "#db2777",
	"--send-blue": "#db2777",
	"--send-blue-hover": "#be185d",
	"--link": "#be185d",
	"--link-hover": "#9d174d",
	"--link-soft": "#be185d",
	"--md-strong": "#3a1c25",
	"--skill-blue": "#db2777",
	"--info-blue": "#2563eb",
	"--auth-green": "#059669",
	"--err-text": "#e11d48",
	"--red-text": "#e11d48",
	"--amber-text": "#b45309",
	"--code-bg": "#f8e2e8",
	"--code-text": "#4a2b35",
	"--tooltip-bg": "#fffbfc",
	"--scroll-thumb": "#dfb9c4",
	"--scroll-thumb-hover": "#c795a3",
	"--notice-err-bg": "#f9dfe4",
	"--notice-warn-bg": "#f3e7cf",
	"--notice-info-bg": "#eadff0",
	"--notice-err-border": "#e11d48",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#a855f7",
	/* 收起/展开按钮的常驻对照色（issue #100）：樱粉下用粉灰底 */
	"--control-fg": "#7d5561",
	"--control-bg": "#f8e2e8",
	"--control-border": "#eccdd6",
	/* 壁纸默认关闭（纯色背景），用户/主题按需打开 */
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(150, 50, 90, 0.05)",
	/* 凹陷内容面：粉调与樱粉对味 */
	"--sunken-bg": "rgba(150, 50, 90, 0.05)",
	"--glow-015": "rgba(150, 50, 90, 0.02)",
	"--glow-025": "rgba(150, 50, 90, 0.02)",
	"--glow-03": "rgba(150, 50, 90, 0.02)",
	"--glow-04": "rgba(150, 50, 90, 0.03)",
	"--glow-05": "rgba(150, 50, 90, 0.03)",
	"--glow-12": "rgba(150, 50, 90, 0.08)",
	"--glow-18": "rgba(150, 50, 90, 0.12)",
	"--glow-22": "rgba(150, 50, 90, 0.15)",
	"--glow-38": "rgba(150, 50, 90, 0.25)",
};

// 雾蓝灰主题的 hljs 覆盖：冷灰蓝底，其余 token 沿用浅色 GitHub 色系。
const hljsMist = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #1e293b;
	background: #dde5ec;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #7c8da0;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #1e293b;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #1e293b;
	font-style: italic;
}
.hljs-strong {
	color: #1e293b;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #d7e9db;
}
.hljs-deletion {
	color: #82071e;
	background: #f2d3d6;
}
`;

// 樱粉主题的 hljs 覆盖：粉底，其余 token 沿用浅色 GitHub 色系。
const hljsSakura = `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: #4a2b35;
	background: #f8e2e8;
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: #cf222e;
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: #8250df;
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: #0550ae;
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: #0a3069;
}
.hljs-built_in,
.hljs-symbol {
	color: #953800;
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: #a78b93;
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: #116329;
}
.hljs-subst {
	color: #4a2b35;
}
.hljs-section {
	color: #0550ae;
	font-weight: 700;
}
.hljs-bullet {
	color: #0550ae;
}
.hljs-emphasis {
	color: #4a2b35;
	font-style: italic;
}
.hljs-strong {
	color: #4a2b35;
	font-weight: 700;
}
.hljs-addition {
	color: #116329;
	background: #ddefdc;
}
.hljs-deletion {
	color: #82071e;
	background: #f4cdd6;
}
`;

// 「紫晕」— dark theme mirroring the in-app markdown FILE preview surface.
// Opaque chrome surfaces go translucent so the ambient gradient shows through.
const MD_PREVIEW_TAIL = `
/* ---- ambient gradient（镜像 .fp-markdown 预览底色，覆盖整个窗口）---- */
:root {
	--bg: #0a0b10;
}
body {
	background:
		radial-gradient(circle at 10% 0%, rgba(139, 92, 246, 0.14), transparent 38%),
		radial-gradient(circle at 88% 100%, rgba(139, 92, 246, 0.07), transparent 44%),
		#0a0b10;
}
/* 让渐变直接成为整个窗口的底色：铬件全部透明，只留边框定结构 */
.topbar,
.panel,
.statusbar {
	background: transparent;
}
`;

// 「赛博朋克」— neon cyan/magenta on near-black.
const CYBERPUNK = {
	"color-scheme": "dark",
	"--bg": "#0a0a0f",
	"--bg-elev": "#12121e",
	"--bg-elev2": "#1a1a2e",
	"--border": "#2b2b4a",
	"--border-soft": "#20203a",
	"--text": "#e6e6ff",
	"--text-dim": "#9a9ac4",
	"--text-faint": "#6a6a8e",
	"--accent": "#00d4ff",
	"--accent-soft": "rgba(0, 212, 255, 0.14)",
	"--green": "#00ff41",
	"--green-soft": "rgba(0, 255, 65, 0.12)",
	"--red": "#ff006e",
	"--red-soft": "rgba(255, 0, 110, 0.12)",
	"--amber": "#ffd700",
	"--term-bg": "#0a0a0f",
	"--term-fg": "#e6e6ff",
	"--term-cursor": "#00d4ff",
	"--term-cursor-accent": "#0a0a0f",
	"--term-selection": "rgba(0, 212, 255, 0.35)",
	"--term-black": "#1a1a2e",
	"--term-red": "#ff006e",
	"--term-green": "#00ff41",
	"--term-yellow": "#ffd700",
	"--term-blue": "#00d4ff",
	"--term-magenta": "#ff00ff",
	"--term-cyan": "#00f5ff",
	"--term-white": "#e6e6ff",
	"--term-bright-black": "#6a6a8e",
	"--term-bright-red": "#ff006e",
	"--term-bright-green": "#00ff41",
	"--term-bright-yellow": "#ffd700",
	"--term-bright-blue": "#00d4ff",
	"--term-bright-magenta": "#ff00ff",
	"--term-bright-cyan": "#00f5ff",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#00d4ff",
	"--brand-grad-b": "#ff006e",
	"--send-blue": "#00d4ff",
	"--send-blue-hover": "#00b8d4",
	"--plugin-purple": "#ff00ff",
	"--info-blue": "#00d4ff",
};

// 「炫彩」— high-contrast, colorful.
const DAZZLE = {
	"color-scheme": "dark",
	"--bg": "#0b0b14",
	"--bg-elev": "#13131e",
	"--bg-elev2": "#1b1b2e",
	"--border": "#2a2a48",
	"--border-soft": "#1f1f38",
	"--text": "#e8e8f0",
	"--text-dim": "#a0a0c0",
	"--text-faint": "#707090",
	"--accent": "#818cf8",
	"--accent-soft": "rgba(129, 140, 248, 0.14)",
	"--green": "#34d399",
	"--green-soft": "rgba(52, 211, 153, 0.12)",
	"--red": "#f43f5e",
	"--red-soft": "rgba(244, 63, 94, 0.12)",
	"--amber": "#f59e0b",
	"--term-bg": "#0b0b14",
	"--term-fg": "#e8e8f0",
	"--term-cursor": "#818cf8",
	"--term-cursor-accent": "#0b0b14",
	"--term-selection": "rgba(129, 140, 248, 0.35)",
	"--term-black": "#1b1b2e",
	"--term-red": "#f43f5e",
	"--term-green": "#34d399",
	"--term-yellow": "#f59e0b",
	"--term-blue": "#60a5fa",
	"--term-magenta": "#c084fc",
	"--term-cyan": "#22d3ee",
	"--term-white": "#e8e8f0",
	"--term-bright-black": "#707090",
	"--term-bright-red": "#f43f5e",
	"--term-bright-green": "#34d399",
	"--term-bright-yellow": "#f59e0b",
	"--term-bright-blue": "#60a5fa",
	"--term-bright-magenta": "#c084fc",
	"--term-bright-cyan": "#22d3ee",
	"--term-bright-white": "#ffffff",
	"--brand-grad-a": "#818cf8",
	"--brand-grad-b": "#c084fc",
	"--send-blue": "#818cf8",
	"--send-blue-hover": "#6366f1",
};

// ═══════════════════════════════════════════════════════════════════════════
//  Fresh theme pack — 5 palettes designed to sit apart from each other and
//  from the originals:
//
//    glaciar  冰川     dark   polar midnight + aurora teal (cool, calm)
//    brasa    炉火     dark   dark wood + ember amber (warm, cosy)
//    fosforo  磷光     dark   modern CRT phosphor green (focused)
//    salvia   鼠尾草   light  botanical sage green (airy)
//    cianotipo 蓝图    light  ink navy on a drafting grid (technical)
//
//  glaciar/brasa/fosforo/cianotipo carry an "atmosphere" tail: a body-level
//  gradient (or drafting grid) + transparent chrome, so the ground stops being
//  one flat tone. salvia stays flat on purpose (crisp, airy).
//
//  ACCENT RULE: --accent is used BOTH as text on the theme background AND as a
//  filled button background with hardcoded #fff text (.template-btn.send,
//  .file-attach.inline:hover, .cmd-run:hover). Dark-theme accents therefore sit
//  in the L≈0.23-0.28 band (>=4.5:1 as text on --bg, >=3:1 under white text);
//  light-theme accents in L≈0.10-0.15 (both >=4.5:1). The bright signature
//  hues live in --link/--term-cursor/--brand-grad-*, which are never used
//  under white text.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Emit the full `.hljs` override block from a compact token palette. The static
 * bundle imports github-dark, so a palette-only theme can never "inherit" a
 * matching syntax theme — every theme re-declares the block. Selector groups
 * are identical everywhere, so they live here once; only the colors differ.
 */
const hljsBlock = ({ fg, bg, keyword, title, attr, string, builtin, comment, addition, deletion }) => `
/* ---- syntax highlighting (overrides static github-dark import) ---- */
.hljs {
	color: ${fg};
	background: ${bg};
}
.hljs-doctag,
.hljs-keyword,
.hljs-meta .hljs-keyword,
.hljs-template-tag,
.hljs-template-variable,
.hljs-type,
.hljs-variable.language_ {
	color: ${keyword};
}
.hljs-title,
.hljs-title.class_,
.hljs-title.class_.inherited__,
.hljs-title.function_ {
	color: ${title};
}
.hljs-attr,
.hljs-attribute,
.hljs-literal,
.hljs-meta,
.hljs-number,
.hljs-operator,
.hljs-variable,
.hljs-selector-attr,
.hljs-selector-class,
.hljs-selector-id {
	color: ${attr};
}
.hljs-regexp,
.hljs-string,
.hljs-meta .hljs-string {
	color: ${string};
}
.hljs-built_in,
.hljs-symbol {
	color: ${builtin};
}
.hljs-comment,
.hljs-code,
.hljs-formula {
	color: ${comment};
}
.hljs-name,
.hljs-quote,
.hljs-selector-tag,
.hljs-selector-pseudo {
	color: ${addition.color};
}
.hljs-subst {
	color: ${fg};
}
.hljs-section {
	color: ${attr};
	font-weight: 700;
}
.hljs-bullet {
	color: ${attr};
}
.hljs-emphasis {
	color: ${fg};
	font-style: italic;
}
.hljs-strong {
	color: ${fg};
	font-weight: 700;
}
.hljs-addition {
	color: ${addition.color};
	background: ${addition.bg};
}
.hljs-deletion {
	color: ${deletion.color};
	background: ${deletion.bg};
}
`;

// ── 「冰川」 glaciar — polar midnight + aurora teal ─────────────────────────
const GLACIAR = {
	"color-scheme": "dark",
	"--bg": "#0b1215",
	"--bg-elev": "#111b1f",
	"--bg-elev2": "#172529",
	"--border": "#25383e",
	"--border-soft": "#1b2b31",
	"--text": "#dfeaec",
	"--text-dim": "#9cb3b7",
	"--text-faint": "#6d858b",
	"--accent": "#0d9488",
	"--accent-soft": "rgba(13, 148, 136, 0.16)",
	"--green": "#34d399",
	"--green-soft": "rgba(52, 211, 153, 0.12)",
	"--red": "#f87171",
	"--red-soft": "rgba(248, 113, 113, 0.12)",
	"--amber": "#fbbf24",
	"--term-bg": "#0b1215",
	"--term-fg": "#dfeaec",
	"--term-cursor": "#2dd4bf",
	"--term-cursor-accent": "#0b1215",
	"--term-selection": "rgba(45, 212, 191, 0.32)",
	"--term-black": "#172529",
	"--term-red": "#f87171",
	"--term-green": "#34d399",
	"--term-yellow": "#fbbf24",
	"--term-blue": "#5eb8f0",
	"--term-magenta": "#b79cff",
	"--term-cyan": "#2dd4bf",
	"--term-white": "#dfeaec",
	"--term-bright-black": "#6d858b",
	"--term-bright-red": "#fca5a5",
	"--term-bright-green": "#86efac",
	"--term-bright-yellow": "#fde68a",
	"--term-bright-blue": "#93c5fd",
	"--term-bright-magenta": "#d8c7ff",
	"--term-bright-cyan": "#7ff0e0",
	"--term-bright-white": "#ffffff",
	"--tooltip-bg": "#1b272c",
	"--code-bg": "#081013",
	"--code-text": "#c9dee0",
	"--err-text": "#f0a5a5",
	"--red-text": "#fca5a5",
	"--amber-text": "#fcd34d",
	"--info-blue": "#5eb8f0",
	"--link": "#5eead4",
	"--link-hover": "#8ff4e4",
	"--link-soft": "#bdf6ec",
	"--md-strong": "#f0f7f8",
	"--skill-blue": "#5eb8f0",
	"--plugin-purple": "#b79cff",
	"--auth-green": "#6ee7a0",
	"--scroll-thumb": "#24393f",
	"--scroll-thumb-hover": "#33515a",
	"--notice-err-bg": "#3a1f22",
	"--notice-warn-bg": "#362a1b",
	"--notice-info-bg": "#10333a",
	"--notice-err-border": "#ef4444",
	"--notice-warn-border": "#f59e0b",
	"--notice-info-border": "#2dd4bf",
	"--send-blue": "#0d9488",
	"--send-blue-hover": "#0f766e",
	"--brand-grad-a": "#2dd4bf",
	"--brand-grad-b": "#38bdf8",
	"--control-fg": "#9cb3b7",
	"--control-bg": "#172529",
	"--control-border": "#25383e",
};

const GLACIAR_TAIL = `
/* ---- aurora atmosphere ----
 * Aurora glow on body + transparent chrome: the ground itself becomes the
 * picture, the topbar/panels/statusbar only keep their border to hold the
 * structure. Same technique as md-preview, but polar cold (midnight + aurora)
 * instead of violet. */
body {
	background:
		radial-gradient(circle at 6% -8%, rgba(45, 212, 191, 0.13), transparent 44%),
		radial-gradient(circle at 98% 104%, rgba(56, 189, 248, 0.1), transparent 46%),
		#0b1215;
}
.topbar,
.panel,
.statusbar {
	background: transparent;
}
`;

const hljsGlaciar = hljsBlock({
	fg: "#c9dee0",
	bg: "#081013",
	keyword: "#ff8ea3",
	title: "#b8a6ff",
	attr: "#6fc7ff",
	string: "#9fdcff",
	builtin: "#ffb27a",
	comment: "#7d9aa1",
	addition: { color: "#7ee2b8", bg: "#0e2f26" },
	deletion: { color: "#ff9aa8", bg: "#3a1620" },
});

// ── 「炉火」 brasa — dark wood + ember amber ───────────────────────────────
const BRASA = {
	"color-scheme": "dark",
	"--bg": "#120f0c",
	"--bg-elev": "#1a1512",
	"--bg-elev2": "#241d18",
	"--border": "#3a2e26",
	"--border-soft": "#2a211b",
	"--text": "#ece0d4",
	"--text-dim": "#b09a88",
	"--text-faint": "#83705f",
	"--accent": "#d97706",
	"--accent-soft": "rgba(217, 119, 6, 0.16)",
	"--green": "#34d399",
	"--green-soft": "rgba(52, 211, 153, 0.12)",
	"--red": "#f87171",
	"--red-soft": "rgba(248, 113, 113, 0.12)",
	"--amber": "#fbbf24",
	"--term-bg": "#120f0c",
	"--term-fg": "#ece0d4",
	"--term-cursor": "#f59e0b",
	"--term-cursor-accent": "#120f0c",
	"--term-selection": "rgba(245, 158, 11, 0.3)",
	"--term-black": "#241d18",
	"--term-red": "#f87171",
	"--term-green": "#34d399",
	"--term-yellow": "#fbbf24",
	"--term-blue": "#7db8e8",
	"--term-magenta": "#d9a0d8",
	"--term-cyan": "#7fd4c8",
	"--term-white": "#ece0d4",
	"--term-bright-black": "#83705f",
	"--term-bright-red": "#fca5a5",
	"--term-bright-green": "#86efac",
	"--term-bright-yellow": "#fde68a",
	"--term-bright-blue": "#a8d0f5",
	"--term-bright-magenta": "#ecc4ea",
	"--term-bright-cyan": "#a8e8dd",
	"--term-bright-white": "#ffffff",
	"--tooltip-bg": "#291f19",
	"--code-bg": "#0d0a07",
	"--code-text": "#e2d3c2",
	"--err-text": "#f0a5a5",
	"--red-text": "#fca5a5",
	"--amber-text": "#fcd34d",
	"--info-blue": "#7db8e8",
	"--link": "#fbbf24",
	"--link-hover": "#fcd34d",
	"--link-soft": "#fde68a",
	"--md-strong": "#f7efe6",
	"--skill-blue": "#7db8e8",
	"--plugin-purple": "#d9a0d8",
	"--auth-green": "#6ee7a0",
	"--scroll-thumb": "#3d3027",
	"--scroll-thumb-hover": "#55432f",
	"--notice-err-bg": "#3a1c1c",
	"--notice-warn-bg": "#3a2a12",
	"--notice-info-bg": "#1a2634",
	"--notice-err-border": "#ef4444",
	"--notice-warn-border": "#f59e0b",
	"--notice-info-border": "#7db8e8",
	"--send-blue": "#b45309",
	"--send-blue-hover": "#92400e",
	"--brand-grad-a": "#fbbf24",
	"--brand-grad-b": "#f97316",
	"--control-fg": "#b09a88",
	"--control-bg": "#241d18",
	"--control-border": "#3a2e26",
};

const BRASA_TAIL = `
/* ---- ember atmosphere ----
 * Warm glow from the bottom edge (hearth) + a faint residual warmth on top +
 * transparent chrome: a dark room lit by a single warm lamp. */
body {
	background:
		radial-gradient(circle at 50% 116%, rgba(245, 158, 11, 0.15), transparent 54%),
		radial-gradient(circle at 4% -10%, rgba(180, 83, 9, 0.11), transparent 40%),
		#120f0c;
}
.topbar,
.panel,
.statusbar {
	background: transparent;
}
`;

const hljsBrasa = hljsBlock({
	fg: "#e2d3c2",
	bg: "#0d0a07",
	keyword: "#ff7b72",
	title: "#d2a8ff",
	attr: "#79c0ff",
	string: "#a5d6ff",
	builtin: "#ffa657",
	comment: "#9c8b7a",
	addition: { color: "#7ee787", bg: "#12301f" },
	deletion: { color: "#ffa198", bg: "#3d1a20" },
});

// ── 「磷光」 fosforo — modern CRT phosphor green ───────────────────────────
const FOSFORO = {
	"color-scheme": "dark",
	"--bg": "#070d0a",
	"--bg-elev": "#0c1511",
	"--bg-elev2": "#121e18",
	"--border": "#1f3428",
	"--border-soft": "#16261d",
	"--text": "#d6ecdc",
	"--text-dim": "#93b39c",
	"--text-faint": "#618068",
	"--accent": "#16a34a",
	"--accent-soft": "rgba(22, 163, 74, 0.16)",
	"--green": "#4ade80",
	"--green-soft": "rgba(74, 222, 128, 0.12)",
	"--red": "#ff7b72",
	"--red-soft": "rgba(255, 123, 114, 0.12)",
	"--amber": "#ffb454",
	"--term-bg": "#070d0a",
	"--term-fg": "#d6ecdc",
	"--term-cursor": "#3ddc84",
	"--term-cursor-accent": "#070d0a",
	"--term-selection": "rgba(61, 220, 132, 0.28)",
	"--term-black": "#121e18",
	"--term-red": "#ff7b72",
	"--term-green": "#3ddc84",
	"--term-yellow": "#ffb454",
	"--term-blue": "#79c0ff",
	"--term-magenta": "#d2a8ff",
	"--term-cyan": "#56d4dd",
	"--term-white": "#d6ecdc",
	"--term-bright-black": "#618068",
	"--term-bright-red": "#ffa198",
	"--term-bright-green": "#8cf0b0",
	"--term-bright-yellow": "#ffd9a0",
	"--term-bright-blue": "#a8d8ff",
	"--term-bright-magenta": "#e6ccff",
	"--term-bright-cyan": "#8ce8ea",
	"--term-bright-white": "#ffffff",
	"--tooltip-bg": "#14211a",
	"--code-bg": "#050a07",
	"--code-text": "#c6e0cd",
	"--err-text": "#f0a5a5",
	"--red-text": "#ffa198",
	"--amber-text": "#ffd9a0",
	"--info-blue": "#79c0ff",
	"--link": "#56d4dd",
	"--link-hover": "#8be6ec",
	"--link-soft": "#b6f0f4",
	"--md-strong": "#ecf9f0",
	"--skill-blue": "#79c0ff",
	"--plugin-purple": "#d2a8ff",
	"--auth-green": "#7ee787",
	"--scroll-thumb": "#21362b",
	"--scroll-thumb-hover": "#2f4d3c",
	"--notice-err-bg": "#33191a",
	"--notice-warn-bg": "#33270f",
	"--notice-info-bg": "#0f2c2c",
	"--notice-err-border": "#ef4444",
	"--notice-warn-border": "#f59e0b",
	"--notice-info-border": "#56d4dd",
	"--send-blue": "#15803d",
	"--send-blue-hover": "#166534",
	"--brand-grad-a": "#3ddc84",
	"--brand-grad-b": "#56d4dd",
	"--control-fg": "#93b39c",
	"--control-bg": "#121e18",
	"--control-border": "#1f3428",
	/* CRT scanlines + vignette need the body to stay legible: raise the panel
	   translucency from the 62% default to 78%. */
	"--wallpaper-panel-alpha": "78%",
};

const FOSFORO_TAIL = `
/* ---- CRT atmosphere ----
 * Very faint scanlines + corner vignette to mimic a phosphor screen; panels go
 * 78% opaque (vs 62% default) so body text stays readable. */
body {
	background:
		repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.13) 0 1px, transparent 1px 3px),
		radial-gradient(ellipse at 50% 50%, transparent 34%, rgba(0, 0, 0, 0.5) 100%),
		#070d0a;
}
`;

const hljsFosforo = hljsBlock({
	fg: "#c6e0cd",
	bg: "#050a07",
	keyword: "#7ee787",
	title: "#d2a8ff",
	attr: "#79c0ff",
	string: "#a5d6ff",
	builtin: "#ffb454",
	comment: "#6d8b78",
	addition: { color: "#7ee787", bg: "#0e2a18" },
	deletion: { color: "#ff9aa8", bg: "#351519" },
});

// ── 「鼠尾草」 salvia — botanical sage light ───────────────────────────────
const SALVIA = {
	"color-scheme": "light",
	"--bg": "#edf1e8",
	"--bg-elev": "#fafbf6",
	"--bg-elev2": "#dfe7d6",
	"--border": "#c8d4b8",
	"--border-soft": "#dbe4cd",
	"--text": "#26301f",
	"--text-dim": "#556047",
	"--text-faint": "#7f8b6a",
	"--accent": "#1f7a4d",
	"--accent-soft": "rgba(31, 122, 77, 0.12)",
	"--green": "#15803d",
	"--green-soft": "rgba(21, 128, 61, 0.12)",
	"--red": "#b91c1c",
	"--red-soft": "rgba(185, 28, 28, 0.1)",
	"--amber": "#b45309",
	"--term-bg": "#fafbf6",
	"--term-fg": "#26301f",
	"--term-cursor": "#1f7a4d",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(31, 122, 77, 0.24)",
	"--term-black": "#dde5d1",
	"--term-red": "#b91c1c",
	"--term-green": "#15803d",
	"--term-yellow": "#a16207",
	"--term-blue": "#1d4ed8",
	"--term-magenta": "#7c3aed",
	"--term-cyan": "#0e7490",
	"--term-white": "#26301f",
	"--term-bright-black": "#6f7d5c",
	"--term-bright-red": "#b91c1c",
	"--term-bright-green": "#15803d",
	"--term-bright-yellow": "#a16207",
	"--term-bright-blue": "#1d4ed8",
	"--term-bright-magenta": "#7c3aed",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#111a0c",
	"--brand-grad-a": "#4ade80",
	"--brand-grad-b": "#1f7a4d",
	"--send-blue": "#1f7a4d",
	"--send-blue-hover": "#166534",
	"--link": "#1a6b45",
	"--link-hover": "#14532d",
	"--link-soft": "#1a6b45",
	"--md-strong": "#161d12",
	"--skill-blue": "#1f7a4d",
	"--info-blue": "#1d4ed8",
	"--auth-green": "#15803d",
	"--err-text": "#b91c1c",
	"--red-text": "#b91c1c",
	"--amber-text": "#92400e",
	"--code-bg": "#dfe7d6",
	"--code-text": "#26301f",
	"--tooltip-bg": "#fafbf6",
	"--scroll-thumb": "#c2cfb2",
	"--scroll-thumb-hover": "#a8b896",
	"--notice-err-bg": "#f3dbd8",
	"--notice-warn-bg": "#f0e6c8",
	"--notice-info-bg": "#dde6e0",
	"--notice-err-border": "#b91c1c",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#1d4ed8",
	"--control-fg": "#556047",
	"--control-bg": "#dfe7d6",
	"--control-border": "#c8d4b8",
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(60, 90, 40, 0.05)",
	"--sunken-bg": "rgba(60, 90, 40, 0.05)",
	"--glow-015": "rgba(60, 90, 40, 0.02)",
	"--glow-025": "rgba(60, 90, 40, 0.02)",
	"--glow-03": "rgba(60, 90, 40, 0.02)",
	"--glow-04": "rgba(60, 90, 40, 0.03)",
	"--glow-05": "rgba(60, 90, 40, 0.03)",
	"--glow-12": "rgba(60, 90, 40, 0.08)",
	"--glow-18": "rgba(60, 90, 40, 0.12)",
	"--glow-22": "rgba(60, 90, 40, 0.15)",
	"--glow-38": "rgba(60, 90, 40, 0.25)",
};

const hljsSalvia = hljsBlock({
	fg: "#26301f",
	bg: "#dfe7d6",
	keyword: "#cf222e",
	title: "#8250df",
	attr: "#0550ae",
	string: "#0a3069",
	builtin: "#953800",
	comment: "#6f7f5c",
	addition: { color: "#116329", bg: "#dbe9cd" },
	deletion: { color: "#82071e", bg: "#f2d3d6" },
});

// ── 「蓝图」 cianotipo — ink navy on a drafting grid ──────────────────────
const CIANOTIPO = {
	"color-scheme": "light",
	"--bg": "#eef2f9",
	"--bg-elev": "#fbfcfe",
	"--bg-elev2": "#e1e8f4",
	"--border": "#c2cee4",
	"--border-soft": "#d5deef",
	"--text": "#16233a",
	"--text-dim": "#46587a",
	"--text-faint": "#7d8ca8",
	"--accent": "#1d4ed8",
	"--accent-soft": "rgba(29, 78, 216, 0.12)",
	"--green": "#047857",
	"--green-soft": "rgba(4, 120, 87, 0.12)",
	"--red": "#dc2626",
	"--red-soft": "rgba(220, 38, 38, 0.1)",
	"--amber": "#b45309",
	"--term-bg": "#fbfcfe",
	"--term-fg": "#16233a",
	"--term-cursor": "#1d4ed8",
	"--term-cursor-accent": "#ffffff",
	"--term-selection": "rgba(29, 78, 216, 0.22)",
	"--term-black": "#dde4f0",
	"--term-red": "#dc2626",
	"--term-green": "#047857",
	"--term-yellow": "#a16207",
	"--term-blue": "#1d4ed8",
	"--term-magenta": "#7c3aed",
	"--term-cyan": "#0e7490",
	"--term-white": "#16233a",
	"--term-bright-black": "#7d8ca8",
	"--term-bright-red": "#dc2626",
	"--term-bright-green": "#047857",
	"--term-bright-yellow": "#a16207",
	"--term-bright-blue": "#1d4ed8",
	"--term-bright-magenta": "#7c3aed",
	"--term-bright-cyan": "#0e7490",
	"--term-bright-white": "#0b1220",
	"--brand-grad-a": "#60a5fa",
	"--brand-grad-b": "#1d4ed8",
	"--send-blue": "#1d4ed8",
	"--send-blue-hover": "#1e40af",
	"--link": "#1d4ed8",
	"--link-hover": "#1e40af",
	"--link-soft": "#1d4ed8",
	"--md-strong": "#0b1220",
	"--skill-blue": "#1d4ed8",
	"--info-blue": "#1d4ed8",
	"--auth-green": "#047857",
	"--err-text": "#dc2626",
	"--red-text": "#dc2626",
	"--amber-text": "#92400e",
	"--code-bg": "#e1e8f4",
	"--code-text": "#16233a",
	"--tooltip-bg": "#fbfcfe",
	"--scroll-thumb": "#b8c6e0",
	"--scroll-thumb-hover": "#9aabd0",
	"--notice-err-bg": "#f5dadc",
	"--notice-warn-bg": "#f0e6cb",
	"--notice-info-bg": "#d9e3f7",
	"--notice-err-border": "#dc2626",
	"--notice-warn-border": "#b45309",
	"--notice-info-border": "#1d4ed8",
	"--control-fg": "#46587a",
	"--control-bg": "#e1e8f4",
	"--control-border": "#c2cee4",
	"--bg-image": "none",
	"--bg-image-dim": "0.78",
	"--bg-image-blur": "0px",
	"--bg-elev3": "rgba(20, 40, 90, 0.05)",
	"--sunken-bg": "rgba(20, 40, 90, 0.05)",
	"--glow-015": "rgba(20, 40, 90, 0.02)",
	"--glow-025": "rgba(20, 40, 90, 0.02)",
	"--glow-03": "rgba(20, 40, 90, 0.02)",
	"--glow-04": "rgba(20, 40, 90, 0.03)",
	"--glow-05": "rgba(20, 40, 90, 0.03)",
	"--glow-12": "rgba(20, 40, 90, 0.08)",
	"--glow-18": "rgba(20, 40, 90, 0.12)",
	"--glow-22": "rgba(20, 40, 90, 0.15)",
	"--glow-38": "rgba(20, 40, 90, 0.25)",
	/* The drafting grid sits behind the body text: keep panels a bit more
	   opaque than the 62% default (72%) for reading comfort. */
	"--wallpaper-panel-alpha": "72%",
};

const CIANOTIPO_TAIL = `
/* ---- drafting grid ----
 * 24px cold-blue graph paper + transparent chrome: the whole page reads as a
 * drafting table. The grid alpha is only 0.04, so the body text (--text on
 * --bg ≈ 14:1) is unaffected. */
body {
	background-image:
		linear-gradient(rgba(29, 78, 216, 0.04) 1px, transparent 1px),
		linear-gradient(90deg, rgba(29, 78, 216, 0.04) 1px, transparent 1px);
	background-size: 24px 24px;
	background-position: -1px -1px;
}
.topbar,
.panel,
.statusbar {
	background: transparent;
}
`;

const hljsCianotipo = hljsBlock({
	fg: "#16233a",
	bg: "#e1e8f4",
	keyword: "#cf222e",
	title: "#6d28d9",
	attr: "#1d4ed8",
	string: "#0a3069",
	builtin: "#953800",
	comment: "#6b7a94",
	addition: { color: "#116329", bg: "#d7e9db" },
	deletion: { color: "#82071e", bg: "#f2d3d6" },
});

// --- 3) emit ----------------------------------------------------------------
writeTheme("白色", "white.css", emitTheme("白色", WHITE, hljsLight, "White"));
writeTheme("暖纸", "paper.css", emitTheme("暖纸", PAPER, hljsPaper, "Warm Paper"));
writeTheme("雾蓝灰", "mist.css", emitTheme("雾蓝灰", MIST, hljsMist, "Misty Blue Gray"));
writeTheme("樱粉", "sakura.css", emitTheme("樱粉", SAKURA, hljsSakura, "Sakura Pink"));
writeTheme("紫晕", "md-preview.css", emitTheme("紫晕", { "color-scheme": "dark" }, MD_PREVIEW_TAIL, "Purple Haze"));
writeTheme("赛博朋克", "cyberpunk.css", emitTheme("赛博朋克", CYBERPUNK, "", "Cyberpunk"));
writeTheme("炫彩", "dazzle.css", emitTheme("炫彩", DAZZLE, "", "Dazzle"));
// Fresh theme pack (palette + .hljs + optional atmosphere tail).
writeTheme("冰川", "glaciar.css", emitTheme("冰川", GLACIAR, hljsGlaciar + GLACIAR_TAIL, "Glacier"));
writeTheme("炉火", "brasa.css", emitTheme("炉火", BRASA, hljsBrasa + BRASA_TAIL, "Ember"));
writeTheme("磷光", "fosforo.css", emitTheme("磷光", FOSFORO, hljsFosforo + FOSFORO_TAIL, "Phosphor"));
writeTheme("鼠尾草", "salvia.css", emitTheme("鼠尾草", SALVIA, hljsSalvia, "Sage"));
writeTheme("蓝图", "cianotipo.css", emitTheme("蓝图", CIANOTIPO, hljsCianotipo + CIANOTIPO_TAIL, "Blueprint"));

console.log(
	"themes regenerated: white / paper / mist / sakura / md-preview / cyberpunk / dazzle / " +
		"glaciar / brasa / fosforo / salvia / cianotipo",
);
