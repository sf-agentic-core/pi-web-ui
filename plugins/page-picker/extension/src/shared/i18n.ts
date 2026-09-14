/// <reference lib="dom" />
/**
 * 界面语言（i18n）：中文是**源语言**，英文/西班牙文是叠加在上面的字典。
 *
 * 为什么用「中文原文当键」（gettext 式）而不是另造一套 `pick.button.send` 这样的 id：
 * - 中文就是这个项目的源语言，代码里本来写的就是中文句子 —— 原文当键，改造的 diff 只剩
 *   「把字面量包进 t()」这一种形状，评审时一眼能看出到底改了什么；
 * - 漏译**不会**变成界面上一片空白或一串 id，而是回落成中文原文（可见、可复用）；
 * - 上游继续用中文写新文案时，这里只是少一条翻译 —— 不会因为「忘了加 id」而抛错。
 * 代价：改中文原文 = 改键，得同步字典。这一条由单测钉住
 * （tests/unit/page-picker-i18n.test.ts：源码里每个 `t("…")` 都必须在 en/es 里有对应项，
 * 且占位符集合一致）—— 所以「漏译」会在 CI 里红，而不是等到用户看见中文。
 *
 * 语言怎么定：
 *   ① 用户在选项页选了具体语言 → 用它（存在 settings.lang，随 `setLangPref` 生效）；
 *   ② 否则跟随浏览器界面语言（扩展上下文 `chrome.i18n.getUILanguage()`，MAIN world 只有
 *      `navigator.language`）；
 *   ③ `zh*` → 中文，`es*` → 西班牙文，其它任何语言 → 英文；
 *   ④ 完全探测不到（老环境 / 纯 Node）→ 回到源语言中文（最不意外的兜底）。
 *
 * 纯逻辑、零依赖：content script / service worker / MAIN world / 单测都能直接用它。
 */

export type Lang = "zh" | "en" | "es";
/** 用户可选的语言（`auto` = 跟随浏览器）。 */
export type LangPref = "auto" | Lang;

export const LANGS: readonly Lang[] = ["zh", "en", "es"];
export const LANG_PREFS: readonly LangPref[] = ["auto", "en", "es", "zh"];

import { EN } from "./locales/en.js";
import { ES } from "./locales/es.js";

/** 语言 → 字典。中文那本是空的：**原文即译文**（查不到就原样返回）。 */
const DICTS: Record<Lang, Readonly<Record<string, string>>> = {
	zh: {},
	en: EN,
	es: ES,
};

let pref: LangPref = "auto";

/** 浏览器/扩展界面的语言（扩展上下文优先 `chrome.i18n`，MAIN world 只有 `navigator`）。 */
export function rawUiLanguage(): string {
	const api = (globalThis as { chrome?: { i18n?: { getUILanguage?: () => string } } }).chrome?.i18n;
	try {
		const ui = api?.getUILanguage?.();
		if (typeof ui === "string" && ui) return ui;
	} catch {
		// 老环境 / 该 API 被裁掉：继续往下探 navigator，不因为探测失败而抛错
	}
	const nav = (globalThis as { navigator?: { language?: string } }).navigator;
	return typeof nav?.language === "string" ? nav.language : "";
}

/** 按浏览器语言判定用哪本字典（探测不到就回到源语言）。 */
export function detectLang(): Lang {
	const raw = rawUiLanguage().toLowerCase();
	if (raw.startsWith("zh")) return "zh";
	if (raw.startsWith("es")) return "es";
	if (raw) {
		// 纯 Node 单测环境（vitest）没有真实的浏览器 UI 语言，navigator.language 在 Node 22 是 en-US；
		// 只有在扩展上下文（有 chrome.i18n）或非 Node 环境下才认定为英文界面，避免单测被 Node 默认值带跑
		const isNode = typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node !== "undefined";
		const hasChromeI18n = Boolean((globalThis as { chrome?: { i18n?: unknown } }).chrome?.i18n);
		if (isNode && !hasChromeI18n) return "zh";
		return "en";
	}
	return "zh";
}

/** 设置任意来源的 `lang` 值 → 合法的偏好（不认识的一律回 `auto`）。 */
export function isLangPref(v: unknown): v is LangPref {
	return typeof v === "string" && (LANG_PREFS as readonly string[]).includes(v);
}

/** 写入语言偏好（来源是用户设置或注入参数，一律过校验）。 */
export function setLangPref(next: unknown): LangPref {
	pref = isLangPref(next) ? next : "auto";
	return pref;
}

export function currentLangPref(): LangPref {
	return pref;
}

/** 当前实际语言（`auto` 时是探测结果）。 */
export function currentLang(): Lang {
	return pref === "auto" ? detectLang() : pref;
}

/** `{name}` 占位符替换（缺参时原样留着 —— 看得见的问题比 `undefined` 好）。 */
export function interpolate(text: string, params: Record<string, unknown>): string {
	return text.replace(/\{(\w+)\}/g, (whole, key: string) => {
		const value = params[key];
		return value === undefined || value === null ? whole : String(value);
	});
}

/**
 * 取一条文案。`zh` 是源码里的中文原文（也就是字典的键），`params` 填 `{name}` 占位符。
 *
 * 回落顺序：当前语言字典 → 英文字典 → 中文原文。所以缺一条西班牙文最多显示英文，
 * 缺一条英文最多显示中文 —— 永远不会显示空白或键名。
 */
export function t(zh: string, params?: Record<string, unknown>): string {
	const lang = currentLang();
	const text =
		lang === "zh" ? zh : ((DICTS[lang] as Record<string, string>)[zh] ?? (EN as Record<string, string>)[zh] ?? zh);
	return params ? interpolate(text, params) : text;
}

/** 该语言的字典（单测/工具用；中文返回空本，代表「原文即译文」）。 */
export function dictFor(lang: Lang): Readonly<Record<string, string>> {
	return DICTS[lang];
}