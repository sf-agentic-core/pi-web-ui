/**
 * i18n 改造工具：把源码里**用户可见的中文字面量**包进 `t("…")`。
 *
 * 为什么需要它（而不是手改一遍就完了）：上游（xing-shuyin）仍在用中文写新文案，
 * 我们这份 fork 每次同步上游后都要把新出现的字面量重新包一遍 —— 手工做会漏，而漏掉的
 * 表现是「界面里混着几行没翻译的中文」。所以把改造做成**幂等**的工具：
 *
 *   node i18n-wrap.mjs --check     # 只报告会改什么（含可疑点），不落盘
 *   node i18n-wrap.mjs             # 落盘
 *
 * 规则：
 * - 只处理「src 下的所有 .ts」（不含 i18n 自身与字典），只碰**含 CJK 的字符串/模板字面量**；
 * - 注释里的中文不动（注释不是给用户看的，而且是这个项目的文档语言）；
 * - 模板字面量里的 `${expr}` 变成 `t("…{name}…", { name: expr })`（名字从表达式推，见 paramName）；
 * - 已经包过 `t(` 的跳过 —— 幂等；
 * - `--check` 会把「疑似不是在渲染文案」的位置单独列出来（用作比较、当对象键、正则里），
 *   那些地方包进去会改变行为，必须人工看（现在只有一处：background 的 `/没回/`）。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "src");

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const SKIP_FILES = ["shared/i18n.ts", "shared/i18n-dom.ts"];
const SKIP_DIRS = ["shared/locales"];

/** `/` 出现在「值可能开始」的位置时才是正则字面量（否则是除号）。够用的版本。
 *
 * 注意**不要把换行符放进这个集合**：块注释的开头（行首的斜杠星号）前面恰好就是换行，
 * 一旦把换行当成「可以开始正则」，块注释就会被当成正则字面量，lexer 从此错位 ——
 * 曾经真踩过：整段注释被吞进后面的模板字面量，改完的文件语法都不成立。
 */
const REGEX_ALLOWED_BEFORE = new Set([
	"",
	"(",
	",",
	"=",
	":",
	"[",
	"!",
	"&",
	"|",
	"?",
	"{",
	"}",
	";",
	"+",
	"-",
	"*",
	"%",
	"<",
	">",
	"~",
	"^",
]);

/** 扫描出字符串 / 模板 / 正则 / 注释的区间（注释与正则不参与改造）。 */
function scan(src) {
	const n = src.length;
	const spans = [];
	let i = 0;
	let prev = "";
	const push = (type, start, end) => spans.push({ type, start, end });

	while (i < n) {
		const c = src[i];
		const nx = src[i + 1];
		if (c === "/" && nx === "/") {
			// `//` 永远是行注释：正则字面量不能是空的（`//` 不是合法正则，`/*` 也不是正则的开头），
			// 所以这两个分支**不需要**看前一个字符 —— 这正是之前出错的地方
			let j = i + 2;
			while (j < n && src[j] !== "\n") j++;
			push("comment", i, j);
			i = j;
			continue;
		}
		if (c === "/" && nx === "*") {
			let j = i + 2;
			while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
			push("comment", i, j + 2);
			i = j + 2;
			continue;
		}
		if (c === "/" && REGEX_ALLOWED_BEFORE.has(prev)) {
			// 正则字面量：跳到未转义的 /（字符类里的 / 不算结束）
			let j = i + 1;
			let inClass = false;
			while (j < n) {
				const d = src[j];
				if (d === "\\") {
					j += 2;
					continue;
				}
				if (d === "[") inClass = true;
				else if (d === "]") inClass = false;
				else if (d === "/" && !inClass) break;
				else if (d === "\n") break;
				j++;
			}
			push("regex", i, j + 1);
			i = j + 1;
			prev = "/";
			continue;
		}
		if (c === '"' || c === "'") {
			let j = i + 1;
			while (j < n) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === c || src[j] === "\n") break;
				j++;
			}
			push("string", i, j + 1);
			i = j + 1;
			prev = c;
			continue;
		}
		if (c === "`") {
			let j = i + 1;
			let depth = 0;
			while (j < n) {
				const d = src[j];
				if (d === "\\") {
					j += 2;
					continue;
				}
				if (d === "$" && src[j + 1] === "{") {
					depth++;
					j += 2;
					continue;
				}
				if (d === "}" && depth > 0) {
					depth--;
					j++;
					continue;
				}
				if (d === "`" && depth === 0) break;
				j++;
			}
			push("template", i, j + 1);
			i = j + 1;
			prev = "`";
			continue;
		}
		if (!/\s/.test(c)) prev = c;
		i++;
	}
	return spans;
}

/**
 * 顶级语句区间（行首非空白、且不是收尾括号的那一行起，到下一条同类行为止）。
 *
 * 为什么需要：**模块级**对象里的字面量不能直接包成 `t("…")` —— 那个对象在模块加载时求值一次，
 * 会把「那时的语言」冻进去（用户在选项页切了语言也不变）。所以模块级的属性值要包成
 * `get 属性() { return t("…"); }`，每次都重新问一遍当前语言。
 */
function topLevelStatements(src) {
	const lines = src.split("\n");
	const spans = [];
	let offset = 0;
	let current = null;
	for (const line of lines) {
		const isStart =
			line.length > 0 &&
			!/^\s/.test(line) &&
			!/^(\}|\)|\]|\/\*|\*|\/\/|import\s|export\s+(\{|type|interface|default))/.test(line);
		if (isStart) {
			if (current) spans.push({ start: current, end: offset });
			current = offset;
		}
		offset += line.length + 1;
	}
	if (current !== null) spans.push({ start: current, end: src.length });
	return spans;
}

/**
 * 这个字面量是不是「模块级对象里的属性值」？是的话返回要改成 getter 的位置与属性名
 * （也就是把 `属性名: t("…")` 变成 `get 属性名() { return t("…"); }`）。
 */
function moduleProperty(src, span, tops) {
	const top = tops.find((t) => span.start >= t.start && span.end <= t.end);
	if (!top) return null;
	const stmt = src.slice(top.start, top.end);
	if (!/^\s*(export\s+)?(const|let|var)\s/.test(stmt)) return null;
	const head = src.slice(Math.max(0, span.start - 80), span.start);
	const m = /([\w$]+)\s*:\s*$/.exec(head);
	if (!m) return null;
	const key = m[1];
	const keyStart = span.start - m[0].length;
	// `cond ? a : "中文"` 里的那个冒号不是属性（属性名不会是问号后面的标识符）
	const beforeKey = src.slice(Math.max(0, keyStart - 40), keyStart).trimEnd();
	if (/\?$/.test(beforeKey)) return null;
	return { start: keyStart, key };
}
function paramName(expr, used) {
	const e = expr.trim();
	const base = (() => {
		if (/err\b/.test(e) && /message|String\(err\)/.test(e)) return "error";
		if (/\.length\b|\.size\b|\.count\b/.test(e)) return "count";
		if (/^[A-Za-z_$][\w$]*$/.test(e)) return e;
		const ids = e.match(/[A-Za-z_$][\w$]*/g);
		const generic = new Set(["length", "size", "count", "String", "Error", "message", "value", "of", "in"]);
		const last = ids?.filter((x) => !generic.has(x)).pop();
		if (last) return last;
		return "value";
	})();
	const clean = base.replace(/[^\w$]/g, "") || "value";
	let name = clean;
	let n = 2;
	while (used.has(name)) name = `${clean}${n++}`;
	used.add(name);
	return name;
}

/** 模板字面量 → `t("…{name}…", { name: expr })`；无插值时退化成普通字符串。 */
function wrapTemplate(inner) {
	const used = new Set();
	const params = [];
	let text = "";
	let i = 0;
	while (i < inner.length) {
		if (inner[i] === "$" && inner[i + 1] === "{") {
			let j = i + 2;
			let depth = 1;
			while (j < inner.length && depth > 0) {
				if (inner[j] === "{") depth++;
				else if (inner[j] === "}") depth--;
				if (depth === 0) break;
				j++;
			}
			const expr = inner.slice(i + 2, j);
			const name = paramName(expr, used);
			params.push({ name, expr: expr.trim() });
			text += `{${name}}`;
			i = j + 1;
			continue;
		}
		if (inner[i] === "\\") {
			text += inner[i] + (inner[i + 1] ?? "");
			i += 2;
			continue;
		}
		text += inner[i];
		i++;
	}
	const msg = `\`${text.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${")}\``;
	if (params.length === 0) return `t(${msg})`;
	const obj = params.map((p) => `${p.name}: ${p.expr}`).join(", ");
	return `t(${msg}, { ${obj} })`;
}

/** 单/双引号字面量 → `t("…")`（转义回原样，尽量保持可读）。 */
function wrapString(raw, quote) {
	const inner = raw.slice(1, -1);
	const msg = `"${inner.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	void quote;
	return `t(${msg})`;
}

function importPathFor(file) {
	// 相对路径要按**目录到目录**算（src/shared/*.ts → ./i18n.js、src/content/*.ts → ../shared/i18n.js），
	// 不能靠「深度」拼 —— 那会把 src/shared 自己算成 ../shared/i18n.js
	const target = join(srcRoot, "shared", "i18n.ts");
	let spec = relative(dirname(file), target).split("\\").join("/").replace(/\.ts$/, ".js");
	if (!spec.startsWith(".")) spec = `./${spec}`;
	return spec;
}

function ensureImport(src, file, inserted) {
	if (/\bfrom\s+["'][^"']*shared\/i18n\.js["']/.test(src) || /from\s+["'][^"']*i18n\.js["']/.test(src)) return src;
	const spec = importPathFor(file);
	// 插到最后一个顶层 import 之后；没有 import 就插到文件头的 `/// <reference>` 之后
	const imports = [...src.matchAll(/^import\s[^\n]*;\s*$/gm)];
	if (imports.length > 0) {
		const last = imports[imports.length - 1];
		const at = last.index + last[0].length;
		return `${src.slice(0, at)}\nimport { t } from "${spec}";${src.slice(at)}`;
	}
	const ref = src.match(/^\/\/\/ <reference[^\n]*\n/);
	const at = ref ? ref[0].length : 0;
	return `${src.slice(0, at)}import { t } from "${spec}";\n${src.slice(at)}`;
}

function suspicious(src, span) {
	const before = src.slice(Math.max(0, span.start - 24), span.start).trimEnd();
	if (/(===|!==|==|!=)$/.test(before)) return "比较";
	if (/(\.test|\.includes|\.startsWith|\.endsWith|\.indexOf)\($/.test(before)) return "被用来判断";
	if (/\bcase$/.test(before)) return "case 分支";
	if (/try\s*\{?$/.test(before)) return "try 块";
	return null;
}

function processFile(file) {
	const src = readFileSync(file, "utf8");
	const spans = scan(src).filter((s) => s.type === "string" || s.type === "template");
	const tops = topLevelStatements(src);
	const edits = [];
	const warnings = [];
	for (const span of spans) {
		const raw = src.slice(span.start, span.end);
		if (!CJK.test(raw)) continue;
		const before = src.slice(Math.max(0, span.start - 2), span.start);
		if (/t\($/.test(before)) continue; // 已经包过（幂等）
		const warn = suspicious(src, span);
		if (warn) warnings.push({ file, line: src.slice(0, span.start).split("\n").length, warn, raw: raw.slice(0, 60) });
		const wrapped = span.type === "template" ? wrapTemplate(raw.slice(1, -1)) : wrapString(raw, raw[0]);
		const prop = moduleProperty(src, span, tops);
		edits.push(
			prop
				? { start: prop.start, end: span.end, next: `get ${prop.key}() { return ${wrapped}; }` }
				: { start: span.start, end: span.end, next: wrapped },
		);
	}
	if (edits.length === 0) return { changes: 0, warnings };
	let out = src;
	for (const e of edits.reverse()) out = out.slice(0, e.start) + e.next + out.slice(e.end);
	out = ensureImport(out, file);
	return { changes: edits.length, next: out, warnings };
}

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			const rel = relative(srcRoot, full).split("\\").join("/");
			if (SKIP_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) continue;
			yield* walk(full);
			continue;
		}
		if (!name.endsWith(".ts")) continue;
		const rel = relative(srcRoot, full).split("\\").join("/");
		if (SKIP_FILES.includes(rel)) continue;
		yield full;
	}
}

const check = process.argv.includes("--check") || process.argv.includes("--dry");
/** 被当脚本跑时才落盘/打印；被 import 时只暴露内部函数（供排障与测试用）。 */
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
export { scan, topLevelStatements, moduleProperty, processFile, wrapTemplate };
if (isMain) {
	let total = 0;
	const allWarnings = [];
	for (const file of walk(srcRoot)) {
		const res = processFile(file);
		const rel = relative(here, file).split("\\").join("/");
		if (res.changes > 0) {
			total += res.changes;
			console.log(`${String(res.changes).padStart(3)}  ${rel}`);
		}
		allWarnings.push(...res.warnings);
		if (!check && res.next) writeFileSync(file, res.next);
	}
	console.log(`${check ? "[check] 将要改动" : "已改动"} ${total} 处字面量`);
	if (allWarnings.length > 0) {
		console.log("\n⚠ 疑似「不是在渲染文案」的位置（需人工确认是否该包）：");
		for (const w of allWarnings) console.log(`  ${w.file}:${w.line}  [${w.warn}]  ${w.raw}`);
	}
}
