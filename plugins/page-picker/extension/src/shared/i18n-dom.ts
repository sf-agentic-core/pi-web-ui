/// <reference lib="dom" />
/**
 * 静态 HTML（选项页）的文案替换。
 *
 * 选项页的文字写在 options.html 里（**中文原文当兜底**：JS 没跑起来也是完整可读的中文页），
 * 需要翻译的节点自己声明要哪条文案：
 *   - `data-i18n="中文原文"`       → 替换 `textContent`；
 *   - `data-i18n-html="中文原文"`  → 替换 `innerHTML`（原文里带 `<code>` / `<b>` 这类行内标记）；
 *   - `data-i18n-placeholder="…"`  → 替换 `placeholder`；`data-i18n-title` 同理替换 `title`。
 *
 * 属性值就是键（也就是中文原文），所以「页面上看到的中文」和「字典里的键」是同一串字 ——
 * 不存在第二份需要同步的 id 表。
 */

import { t } from "./i18n.js";

type AttrSpec = { attr: string; prop: string };

const ATTRS: AttrSpec[] = [
	{ attr: "data-i18n", prop: "textContent" },
	{ attr: "data-i18n-html", prop: "innerHTML" },
	{ attr: "data-i18n-placeholder", prop: "placeholder" },
	{ attr: "data-i18n-title", prop: "title" },
	{ attr: "data-i18n-aria-label", prop: "ariaLabel" },
];

/** 把 `root` 子树里所有声明了 `data-i18n*` 的节点翻成当前语言（中文时是幂等的）。 */
export function applyDomI18n(root: ParentNode): number {
	let done = 0;
	for (const { attr, prop } of ATTRS) {
		for (const node of root.querySelectorAll(`[${attr}]`)) {
			const key = node.getAttribute(attr);
			if (!key) continue;
			const text = t(key);
			if (prop === "ariaLabel") node.setAttribute("aria-label", text);
			else if (prop === "textContent") node.textContent = text;
			else if (prop === "innerHTML") node.innerHTML = text;
			else node.setAttribute(prop, text);
			done += 1;
		}
	}
	return done;
}