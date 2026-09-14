/**
 * 契约 → Markdown（**纯函数**，是整个扩展最该被单测覆盖的一块）。
 *
 * 为什么要单独一层：采集器只管填数据、投递层只管送数据，**只有这里决定 AI 看到什么**。
 * 纯函数（无 DOM / 无 chrome API）才能把「上下文预算」这类规则用单测钉住。
 *
 * 输出纪律：
 * - 只输出**采集时真的拿到了的东西**（拿不到的行整条不出现，不留 `- 源码：undefined`）；
 * - 体积最小的排前面（选择器/源码/尺寸），体积大的（骨架、规则）能省则省；
 * - 一切路径/选择器走行内代码，长文本走截断。
 */

import type { DetailLevel, ElementSnapshot, PickPayload, PickSection, PickedElement } from "./contract.js";
import { sectionsForDepth } from "./contract.js";
import { collapse, code, truncate } from "./text.js";

import { t } from "./i18n.js";
/** 本次要渲染哪几类信息（新载荷看 `sections`；老载荷按 `detail` 推）。 */
function sectionsOf(payload: PickPayload): Set<PickSection> {
	const list = payload.sections ?? sectionsForDepth(payload.detail ?? "standard");
	return new Set(list);
}

const FRAMEWORK_LABEL: Record<string, string> = {
	react: "React",
	vue: "Vue",
	svelte: "Svelte",
	angular: "Angular",
	unknown: "",
};

export interface ToPromptOptions {
	/** 最多完整渲染几个元素（默认 8）—— 超出的只留一行清单，避免一条消息撑爆上下文。 */
	maxElements?: number;
	/** 单个元素的文本最多几个字符（默认 400；精简档默认 160）。 */
	maxText?: number;
}

/** 把一次拾取渲染成 Markdown；没有可用元素时返回空串（调用方据此拒收）。 */
export function toPrompt(payload: PickPayload, opts: ToPromptOptions = {}): string {
	const elements = (payload.elements ?? []).filter((e) => e?.snapshot);
	if (elements.length === 0) return "";
	const level: DetailLevel = payload.detail ?? "standard";
	const sections = sectionsOf(payload);
	const max = Math.max(1, opts.maxElements ?? 8);
	const shown = elements.slice(0, max);

	const lines: string[] = [];
	lines.push(t(`### 网页元素拾取（{count} 个元素）`, { count: elements.length }));
	lines.push("");
	if (sections.has("page")) lines.push(...renderPage(payload));
	if (payload.note?.trim()) lines.push(t(`- 整体说明：{note}`, { note: collapse(payload.note) }));
	lines.push("");
	shown.forEach((el, i) => {
		lines.push(...renderElement(el, level, i + 1, sections, opts));
	});
	if (elements.length > shown.length) {
		lines.push(t(`（另有 {count} 个已拾取元素未展开）`, { count: elements.length - shown.length }));
	}
	return lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

function renderPage(payload: PickPayload): string[] {
	const page = payload.page;
	const out: string[] = [];
	const title = page?.title?.trim();
	out.push(t(`- 页面：{url}{title}`, { url: code(page?.url ?? ""), title: title ? ` — ${collapse(title)}` : "" }));
	const vp = page?.viewport;
	if (vp) {
		const scheme = page.colorScheme === "dark" ? t("，深色") : page.colorScheme === "light" ? t("，浅色") : "";
		out.push(t(`- 视口：{w}×{h} @{dpr}x{scheme}`, { w: round(vp.w), h: round(vp.h), dpr: vp.dpr, scheme: scheme }));
	}
	const fw = page?.framework ? FRAMEWORK_LABEL[page.framework] : "";
	if (fw) out.push(t(`- 疑似框架：{fw}`, { fw: fw }));
	return out;
}

function renderElement(
	el: PickedElement,
	level: DetailLevel,
	index: number,
	sections: Set<PickSection>,
	opts: ToPromptOptions,
): string[] {
	const snap = el.snapshot;
	const maxText = Math.max(0, opts.maxText ?? (level === "compact" ? 160 : 400));
	const out: string[] = [];
	out.push(t(`#### 元素 {index} · {tag}`, { index: index, tag: code(snap.tagSummary || `<${snap.tag}>`) }));
	out.push("");
	if (sections.has("selector")) {
		out.push(t(`- 选择器：{selector}`, { selector: code(snap.selector) }));
		const source = sections.has("source") ? renderSource(snap) : "";
		if (source) out.push(t(`- 源码：{source}`, { source: source }));
		out.push(t(`- 尺寸：{snap}`, { snap: renderRect(snap) }));
	} else if (sections.has("source")) {
		const source = renderSource(snap);
		if (source) out.push(t(`- 源码：{source}`, { source: source }));
	}
	const text = sections.has("text") && snap.text ? collapse(snap.text) : "";
	if (text) out.push(t(`- 文本：{maxText}`, { maxText: code(truncate(text, maxText)) }));
	if (el.shot) out.push(t("- 截图：见本轮附图"));
	if (sections.has("locator")) {
		if (snap.xpath) out.push(t(`- XPath：{xpath}`, { xpath: code(snap.xpath) }));
		if (snap.domPath) out.push(t(`- DOM：{domPath}`, { domPath: code(snap.domPath) }));
	}
	if (el.note?.trim()) out.push(t(`- 备注：{note}`, { note: collapse(el.note) }));

	const rules = sections.has("rules") ? renderRules(snap) : [];
	if (rules.length > 0) {
		out.push("", t("命中的 CSS："), "", "```css", ...rules, "```");
	}
	const styles = sections.has("styles") ? renderStyles(snap) : "";
	if (styles) out.push("", t(`计算样式（仅与默认/继承值不同的）：{styles}`, { styles: styles }));
	const skeleton = sections.has("skeleton") ? snap.htmlSkeleton?.trim() : "";
	if (skeleton) out.push("", t("HTML 骨架："), "", "```html", skeleton, "```");

	out.push("");
	return out;
}

function renderSource(snap: ElementSnapshot): string {
	const src = snap.source;
	if (!src) return "";
	const parts: string[] = [];
	const file = src.file?.trim();
	if (file) {
		const at = src.line ? `:${src.line}${src.column ? `:${src.column}` : ""}` : "";
		parts.push(code(`${file}${at}`));
	}
	const who: string[] = [];
	if (src.component) who.push(code(src.component));
	for (const up of src.chain ?? []) {
		if (up && up !== src.component) who.push(code(up));
	}
	if (who.length > 0) parts.push(t(`（{join}）`, { join: who.join(" ← ") }));
	if (src.kind === "css") parts.push(t("（样式命中位置）"));
	if (parts.length === 0) return "";
	return parts.join(" ");
}

function renderRect(snap: ElementSnapshot): string {
	const r = snap.rect;
	const px = `${round(r.w)}×${round(r.h)} px`;
	const pct = r.vwPct || r.vhPct ? t(`（视口 {vwPct}% × {vhPct}%）`, { vwPct: round(r.vwPct, 1), vhPct: round(r.vhPct, 1) }) : "";
	return `${px}${pct}`;
}

function renderRules(snap: ElementSnapshot): string[] {
	const rules = snap.matchedRules ?? [];
	const out: string[] = [];
	for (const rule of rules) {
		if (!rule?.selector) continue;
		const where = rule.file ? `/* ${rule.file}${rule.line ? `:${rule.line}` : ""} */` : "";
		if (where) out.push(where);
		const decls = rule.declarations ? ` { ${rule.declarations} }` : " { … }";
		out.push(`${collapse(rule.selector)}${decls}`);
	}
	return out;
}

function renderStyles(snap: ElementSnapshot): string {
	const styles = snap.styles;
	if (!styles) return "";
	const entries = Object.entries(styles).filter(([, v]) => v !== "" && v != null);
	if (entries.length === 0) return "";
	return code(entries.map(([k, v]) => `${k}: ${v}`).join("; "));
}

/** 数字取整（pct 保留 1 位）—— 小数点后一长串对 AI 没有任何意义。 */
function round(n: number, digits = 0): number {
	if (!Number.isFinite(n)) return 0;
	const f = 10 ** digits;
	return Math.round(n * f) / f;
}
