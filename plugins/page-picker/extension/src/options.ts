/// <reference path="./chrome.d.ts" />
/// <reference lib="dom" />
/**
 * 设置页（options）。
 *
 * 只有一件事值得注意：**访问非 localhost 的地址需要单独申请 host 权限**
 * （manifest 里只预置了 localhost/127.0.0.1，避免装扩展时就吓人的「读取所有网站数据」）。
 * 用户把 pi-web-ui 挂在局域网/反代域名上时，在这里点一下授权即可。
 */

import {
	DEFAULT_SETTINGS,
	normalizeServerUrl,
	normalizeSettings,
	originPattern,
	tabMatchesBase,
	type PickerSettings,
} from "./shared/settings.js";
import {
	SHOT_PERMISSION_ORIGINS,
	normalizeOrigin,
	removePair,
	upsertPair,
	type AiPage,
	type BridgePair,
} from "./shared/bridge.js";
import {
	AI_PAGES_KEY,
	PAIRS_KEY,
	grantAiPage,
	loadAiPages,
	loadPairs,
	loadRecent,
	revokeAiPage,
	savePairs,
} from "./shared/bridge-store.js";
import {
	PICK_SECTIONS,
	SECTION_INFO,
	SECTION_PRESETS,
	describeSections,
	normalizeSections,
	presetForSections,
	sectionsForDepth,
	type DetailLevel,
	type PickSection,
} from "./shared/contract.js";

const $ = <T extends HTMLElement>(id: string): T => {
	const node = document.getElementById(id);
	if (!node) throw new Error(`missing #${id}`);
	return node as T;
};

const fields = {
	serverUrl: $<HTMLInputElement>("serverUrl"),
	token: $<HTMLInputElement>("token"),
	preset: $<HTMLSelectElement>("preset"),
	copyToClipboard: $<HTMLInputElement>("copyToClipboard"),
	screenshots: $<HTMLInputElement>("screenshots"),
	focusTarget: $<HTMLInputElement>("focusTarget"),
	// AI 操作页面：总开关 + eval 开关（都是「一改就生效」的设置，走同一个 save）
	aiControl: $<HTMLInputElement>("aiControl"),
	allowEval: $<HTMLInputElement>("allowEval"),
	allowShot: $<HTMLInputElement>("allowShot"),
};

/**
 * 「发送什么」的多选控件。
 *
 * 设计：**预设 + 逐项勾选**。预设决定「采多深 + 默认勾哪些」，用户再自己增减；
 * 勾选只影响内容项，深度（文本长度/骨架深度）沿用最近一次预设 —— 这样「嫌多」时
 * 只需取消勾选，不必再关心档位。
 */
const sectionBoxes = new Map<PickSection, HTMLInputElement>();
/** 最近一次应用的预设深度（手动勾选不改它）。 */
let depth: DetailLevel = DEFAULT_SETTINGS.detail;

function buildSectionList(): void {
	const list = $("sectionList");
	fields.preset.replaceChildren(
		...SECTION_PRESETS.map((p) => {
			const opt = document.createElement("option");
			opt.value = p.id;
			opt.textContent = `${p.label} — ${p.hint}`;
			return opt;
		}),
	);
	const custom = document.createElement("option");
	custom.value = "custom";
	custom.textContent = "自定义（自己勾）";
	fields.preset.append(custom);

	list.replaceChildren(
		...PICK_SECTIONS.map((key) => {
			const info = SECTION_INFO[key];
			const box = document.createElement("input");
			box.type = "checkbox";
			box.id = `sec-${key}`;
			box.addEventListener("change", () => {
				const picked = checkedSections();
				renderPresetSelect(picked);
				void (async () => {
					await save();
					// 提示要在「已保存」之后落笔，否则会被它覆盖掉
					if (picked.length === 0) status("至少要勾一项；全不勾会回落成标准组合", "warn");
				})();
			});
			sectionBoxes.set(key, box);
			const label = document.createElement("label");
			label.className = "check";
			const span = document.createElement("span");
			const b = document.createElement("b");
			b.textContent = info.label;
			const i = document.createElement("i");
			i.textContent = info.hint;
			span.append(b, i);
			label.append(box, span);
			return label;
		}),
	);
}

function checkedSections(): PickSection[] {
	return PICK_SECTIONS.filter((key) => sectionBoxes.get(key)?.checked);
}

/** 预设下拉的选中项：与某个预设一致就选它，否则「自定义」。 */
function renderPresetSelect(sections: PickSection[]): void {
	const matched = presetForSections(sections);
	fields.preset.value = matched ? matched.id : "custom";
	// 摘要文案与拾取浮条共用一份实现（describeSections）—— 两处说的必须是同一件事
	$("sectionSummary").textContent = describeSections(sections);
}

function status(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("status");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function readForm(): PickerSettings {
	return normalizeSettings({
		serverUrl: fields.serverUrl.value,
		token: fields.token.value,
		detail: depth,
		sections: checkedSections(),
		copyToClipboard: fields.copyToClipboard.checked,
		screenshots: fields.screenshots.checked,
		focusTarget: fields.focusTarget.checked,
		aiControl: fields.aiControl.checked,
		allowEval: fields.allowEval.checked,
		allowShot: fields.allowShot.checked,
	});
}

function fillForm(s: PickerSettings): void {
	fields.serverUrl.value = s.serverUrl;
	fields.token.value = s.token;
	fields.copyToClipboard.checked = s.copyToClipboard;
	fields.screenshots.checked = s.screenshots;
	fields.focusTarget.checked = s.focusTarget;
	fields.aiControl.checked = s.aiControl;
	fields.allowEval.checked = s.allowEval;
	fields.allowShot.checked = s.allowShot;
	depth = s.detail;
	const effective = s.sections.length > 0 ? s.sections : sectionsForDepth(s.detail);
	for (const [key, box] of sectionBoxes) box.checked = effective.includes(key);
	renderPresetSelect(effective);
}

async function load(): Promise<void> {
	try {
		fillForm(normalizeSettings(await chrome.storage.sync.get(null)));
	} catch {
		fillForm(DEFAULT_SETTINGS);
	}
}

async function save(): Promise<void> {
	const settings = readForm();
	fields.serverUrl.value = settings.serverUrl; // 回显归一后的地址，让用户看到实际会用哪个
	await chrome.storage.sync.set({ ...settings });
	await refreshGrant();
	status("已保存", "ok");
}

/** 该地址的 host 权限有没有（没有就请求；默认 localhost 已内置）。 */
async function originGranted(): Promise<boolean> {
	try {
		return await chrome.permissions.contains({ origins: [originPattern(fields.serverUrl.value)] });
	} catch {
		return false;
	}
}

/** 刷新授权状态显示（远程部署全靠这一步：没授权连「找到 pi-web-ui 页面」都做不到）。 */
async function refreshGrant(): Promise<void> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await originGranted();
	const label = $("grantState");
	label.textContent = granted ? `已授权 ${pattern}` : `未授权 ${pattern}`;
	label.className = `grant-state ${granted ? "ok" : "warn"}`;
	const button = $<HTMLButtonElement>("grant");
	button.disabled = granted;
	button.textContent = granted ? "已授权" : "授权该地址";
}

async function ensureOrigin(): Promise<boolean> {
	const pattern = originPattern(fields.serverUrl.value);
	const granted = await chrome.permissions.request({ origins: [pattern] });
	await refreshGrant();
	status(granted ? `已授权 ${pattern}` : `未授权 ${pattern}（非本机地址必须授权才能注入）`, granted ? "ok" : "err");
	return granted;
}

async function testConnection(): Promise<void> {
	const base = normalizeServerUrl(fields.serverUrl.value);
	if (!(await originGranted())) {
		status(`未授权 ${originPattern(base)} —— 先点「授权该地址」`, "err");
		return;
	}
	status("正在探测服务端…");
	try {
		const res = await fetch(`${base}/api/health`, { cache: "no-store" });
		if (!res.ok) {
			status(`服务端返回 HTTP ${res.status}`, "err");
			return;
		}
		const info = (await res.json()) as { cwd?: string; piVersion?: string };
		const open = await countOpenTabs(base);
		status(
			open > 0
				? `服务端在线（cwd: ${info.cwd ?? "?"}），已打开 ${open} 个 pi-web-ui 页面`
				: `服务端在线（cwd: ${info.cwd ?? "?"}），但浏览器里还没打开这个页面 —— 投递需要它开着`,
			open > 0 ? "ok" : "warn",
		);
	} catch (err) {
		status(`连不上服务端：${err instanceof Error ? err.message : String(err)}（地址对吗？证书受信吗？）`, "err");
	}
}

/** 浏览器里当前开着几个这个地址的 pi-web-ui 页面（投递的目标）。 */
async function countOpenTabs(base: string): Promise<number> {
	try {
		// 同 findTargetTab：只能用 origin 级 match pattern（裸 origin 会让 tabs.query 抛异常），
		// 路径前缀自己复核（否则 `https://host/pi-other` 也会被算成我们的页面）
		const tabs = await chrome.tabs.query({ url: [originPattern(base)] });
		return tabs.filter((t) => tabMatchesBase(t.url, base)).length;
	} catch {
		return 0;
	}
}

buildSectionList();
for (const [key, node] of Object.entries(fields)) {
	if (key === "preset") continue; // 预设自己处理（要连带勾选项与深度）
	if (key === "allowShot") continue; // 截图要额外权限：勾选时先申请（见 toggleShot）
	node.addEventListener("change", () => void save());
}

/**
 * 「允许截图」：勾选时先申请 `captureVisibleTab` 要求的权限（http/https 任意主机）。
 *
 * 为什么截图要这么重的权限：那个 API 只认 `<all_urls>` 或 `activeTab`，普通 host 权限不够。
 * 拾取时的元素截图能用，是因为用户刚点过扩展图标（那一刻有 activeTab）；AI 操作是模型自己
 * 发起的，没有那个手势。用户拒绝授权就**保持关闭**并说明原因 —— 绝不「勾上了但其实用不了」。
 */
async function toggleShot(on: boolean): Promise<void> {
	if (!on) {
		await save();
		status("已关闭截图：模型只能靠 read 读 DOM 文本", "info");
		return;
	}
	let granted = false;
	try {
		granted = await chrome.permissions.contains({ origins: [...SHOT_PERMISSION_ORIGINS] });
		if (!granted) granted = await chrome.permissions.request({ origins: [...SHOT_PERMISSION_ORIGINS] });
	} catch {
		granted = false;
	}
	if (!granted) {
		fields.allowShot.checked = false;
		status("截图需要「读取您在所有网站上的数据」权限：浏览器没给，已保持关闭", "err");
		return;
	}
	await save();
	status("已允许截图（截图时会把目标标签页切到前台，截完立刻切回）", "ok");
}
fields.allowShot.addEventListener("change", () => void toggleShot(fields.allowShot.checked));
fields.preset.addEventListener("change", () => {
	const preset = SECTION_PRESETS.find((p) => p.id === fields.preset.value);
	if (!preset) return; // 「自定义」= 不动勾选（只是当前状态的名字）
	depth = preset.depth;
	for (const [key, box] of sectionBoxes) box.checked = preset.sections.includes(key);
	renderPresetSelect(preset.sections);
	void save();
});
$("grant").addEventListener("click", () => void ensureOrigin());
// 拾取浮条上也能改这两项（页面上直接切预设，不用回设置页）→ 两个写者必须互相看得见，
// 否则会出现「在页面上切了预设，回选项页随手改一下别的，预设又被旧值覆盖回去」。
chrome.storage.onChanged?.addListener((changes, area) => {
	if (area !== "sync") return;
	if (!changes.detail && !changes.sections) return;
	void load();
});
$("test").addEventListener("click", () => void testConnection());
$("reset").addEventListener("click", () => {
	fillForm({ ...DEFAULT_SETTINGS, sections: [...normalizeSections(DEFAULT_SETTINGS.sections)] });
	void save();
});

// --------------------------------------------------------------------- ?bind= 绑定面板

/**
 * `?bind=<url>`：从 pi-web-ui 页面上的绑定浮条跳过来（用户在那个页面上点了「设为服务地址」）。
 *
 * 为什么不能就地完成：`chrome.permissions.request` 必须在**用户手势**里发出，而浮条的按钮
 * 点在网页上（content script 的 UI），浏览器不认这个手势 —— 只能把用户送到扩展自己的页面，
 * 这里的点击一定带手势。所以这条路径不是多余的，是权限模型要求的。
 */
async function initBindPanel(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("bind");
	if (!raw) return;
	const base = normalizeServerUrl(raw);
	const already = normalizeServerUrl(fields.serverUrl.value) === base;
	fields.serverUrl.value = base;

	const title = $("bindTitle");
	const body = $("bindBody");
	const accept = $<HTMLButtonElement>("bindAccept");
	if (already) {
		title.textContent = `已经是当前服务地址：${base}`;
		body.textContent = "无需改动。要换地址就直接改上面的输入框（改完自动保存）。";
		accept.classList.add("hidden");
	} else {
		const granted = await originGranted();
		title.textContent = granted ? `把 ${base} 设为服务地址？` : `检测到 pi-web-ui 页面：${base}`;
		body.textContent = granted
			? "该地址已授权，点下面按钮就能绑定（之后在别的页面拾取的内容都注入到这里）。"
			: `浏览器要求在本页点一次才能授权 ${originPattern(base)}；点下面按钮即可授权并绑定。`;
		accept.textContent = granted ? "设为服务地址" : "授权并绑定";
		accept.addEventListener("click", () => void acceptBind(base));
	}
	$("bindPanel").classList.remove("hidden");
	$("bindDismiss").addEventListener("click", () => $("bindPanel").classList.add("hidden"));
}

/** 授权（如需要）+ 写入设置。失败时 ensureOrigin 已经写了原因，不要静默。 */
async function acceptBind(base: string): Promise<void> {
	if (!(await originGranted()) && !(await ensureOrigin())) return;
	await save(); // save 会回显归一后的地址，用户看得见实际会用哪个
	status(`已绑定 ${base} —— 以后拾取的内容都注入到这里`, "ok");
	$("bindPanel").classList.add("hidden");
}

void load().then(async () => {
	await refreshGrant();
	await initBindPanel();
});

// ------------------------------------------------------------------ 页面桥（配对管理）

/**
 * 配对管理。
 *
 * 为什么只能在这里做（不能像绑定浮条那样在网页上问一句）：**加一对配对要申请两个 origin
 * 的 host 权限**，而 `chrome.permissions.request` 必须在用户手势里发出 —— 网页上的按钮
 * 给不了这个手势。选项页的点击一定带手势，所以这里才是「授权 + 配对」能完成的地方。
 */
let pairs: BridgePair[] = [];
const pairFields = {
	a: $<HTMLInputElement>("pairA"),
	b: $<HTMLInputElement>("pairB"),
	note: $<HTMLInputElement>("pairNote"),
};

function pairStatus(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("pairStatus");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

function renderPairs(): void {
	const list = $("pairList");
	if (pairs.length === 0) {
		list.replaceChildren(el("div", "empty", "还没有配对。桥默认关闭——只有列在这里的配对之间才能互相调用。"));
		return;
	}
	list.replaceChildren(...pairs.map(renderPair));
}

function renderPair(pair: BridgePair): HTMLElement {
	const card = el("div", `pair${pair.enabled ? "" : " off"}`);
	card.append(el("div", "who", `${pair.a} ↔ ${pair.b}`));
	const meta = el("div", "meta", pair.note ? `${pair.note} · 权限检查中…` : "权限检查中…");
	card.append(meta);

	const toggle = el("input");
	toggle.type = "checkbox";
	toggle.checked = pair.enabled;
	toggle.addEventListener("change", () => void setPairEnabled(pair, toggle.checked));
	const toggleLabel = el("label", "check");
	toggleLabel.append(toggle, el("span", undefined, pair.enabled ? "启用" : "已停用"));

	const drop = el("button", undefined, "删除配对");
	drop.addEventListener("click", () => void dropPair(pair));

	const actions = el("div", "actions");
	actions.append(toggleLabel, drop);
	card.append(actions);

	void showPairPermission(meta, pair);
	return card;
}

/** 两端授权状态（缺哪端就说哪端 —— 「配对在、但调不过去」十有八九是这里）。 */
async function showPairPermission(meta: HTMLElement, pair: BridgePair): Promise<void> {
	const patterns = [originPattern(pair.a), originPattern(pair.b)];
	const missing: string[] = [];
	for (const pattern of patterns) {
		let granted = true;
		try {
			granted = await chrome.permissions.contains({ origins: [pattern] });
		} catch {
			granted = true; // 没有 permissions API 的环境不阻断
		}
		if (!granted) missing.push(pattern);
	}
	const head = pair.note ? `${pair.note} · ` : "";
	meta.textContent = missing.length === 0 ? `${head}两端已授权` : `${head}还缺授权：${missing.join("、")}`;
}

async function notifyPairsChanged(
	removedOrigins: string[] = [],
): Promise<{ installed?: number; uninstalled?: number } | undefined> {
	try {
		// 一个消息名同时服务「配对变更」与「AI 授权变更」：worker 那边本来就是全量重算
		return (await chrome.runtime.sendMessage({ type: "page-picker:bridges-changed", removedOrigins })) as
			{ installed?: number; uninstalled?: number } | undefined;
	} catch {
		return undefined; // worker 不在线：下次它启动时会自己 syncBridges 补齐
	}
}

async function addPair(): Promise<void> {
	const merged = upsertPair(pairs, pairFields.a.value, pairFields.b.value, {
		note: pairFields.note.value,
		now: new Date().toISOString(),
	});
	if (merged.error || !merged.pair) {
		pairStatus(merged.error ?? "配对不合法", "err");
		return;
	}
	const pair = merged.pair;
	const patterns = [originPattern(pair.a), originPattern(pair.b)];
	let granted = false;
	try {
		granted = await chrome.permissions.request({ origins: patterns });
	} catch {
		granted = false;
	}
	if (!granted) {
		pairStatus(`没授权 ${patterns.join("、")} —— 不授权就没法在对端页面里装桥，也执行不了调用`, "err");
		return;
	}
	pairs = merged.pairs;
	await savePairs(pairs);
	pairFields.note.value = "";
	renderPairs();
	const res = await notifyPairsChanged();
	pairStatus(
		res?.installed
			? `已配对 ${pair.a} ↔ ${pair.b}；${res.installed} 个已打开的页面装上了桥`
			: `已配对 ${pair.a} ↔ ${pair.b}（对端页面打开后会自动装桥）`,
		"ok",
	);
	await refreshOriginOptions();
}

async function setPairEnabled(pair: BridgePair, enabled: boolean): Promise<void> {
	pairs = pairs.map((p) => (p.id === pair.id ? { ...p, enabled } : p));
	await savePairs(pairs);
	renderPairs();
	const res = await notifyPairsChanged(enabled ? [] : [pair.a, pair.b]);
	pairStatus(
		enabled
			? res?.installed
				? `已启用；${res.installed} 个已打开的页面装上了桥`
				: "已启用（对端页面打开后自动装桥）"
			: "已停用：那一对页面上的桥已卸下",
		"ok",
	);
}

async function dropPair(pair: BridgePair): Promise<void> {
	pairs = removePair(pairs, pair.id);
	await savePairs(pairs);
	renderPairs();
	const res = await notifyPairsChanged([pair.a, pair.b]);
	pairStatus(res?.uninstalled ? `已删除；${res.uninstalled} 个页面卸下了桥` : "已删除配对", "ok");
}

/** 配对候选：最近点过扩展图标的页面（带标题）+ 已配对过的 origin（它们不一定在最近列表里）。 */
async function refreshOriginOptions(): Promise<void> {
	const known = new Map<string, string>();
	for (const item of await loadRecent()) known.set(item.origin, item.title ?? item.origin);
	for (const pair of pairs) {
		if (!known.has(pair.a)) known.set(pair.a, `${pair.a}（已配对）`);
		if (!known.has(pair.b)) known.set(pair.b, `${pair.b}（已配对）`);
	}
	const list = $("piOrigins");
	list.replaceChildren(
		...[...known.entries()].map(([origin, label]) => {
			const opt = document.createElement("option");
			opt.value = origin;
			// Chrome 的 datalist 显示 value + label（textContent 只参与搜索匹配），两个都放上
			opt.label = label;
			opt.textContent = label;
			return opt;
		}),
	);
}

/**
 * `?pair=<url>`：从开发页的拾取浮条「与另一页配对…」跳过来（本页已自动记成候选并预填）。
 *
 * 用户在这里只需选另一个端点 + 点一下「授权并添加配对」—— 对比手打两个 origin，少掉的是
 * 「去另一个标签页看一眼地址、再切回来小心拄写」这一段真正的麻烦。
 */
async function initPairDeepLink(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("pair");
	if (!raw) return;
	const origin = normalizeOrigin(raw);
	if (!origin) return;
	pairFields.a.value = origin;
	pairStatus(`已填入本页 ${origin} —— 在下面选另一个端点（两页都点过一次扩展图标就会出现在候选里）`, "info");
	pairFields.b.focus();
}

async function initBridgePanel(): Promise<void> {
	pairs = await loadPairs();
	renderPairs();
	$("pairAdd").addEventListener("click", () => void addPair());
	// 别的页面（或另一个选项页标签）改了配对表 → 这边跟着刷新
	chrome.storage.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !changes[PAIRS_KEY]) return;
		void (async () => {
			pairs = await loadPairs();
			renderPairs();
		})();
	});
	await refreshOriginOptions();
	await initPairDeepLink();
}

void initBridgePanel();

// -------------------------------------------------------------- AI 操作页面（授权管理）

/**
 * 「给模型一个能读写网页的工具」的授权管理。
 *
 * 与页面桥的区别：那个是两个网页互调、得配两端；这里**另一端固定是 pi-web-ui 页面**
 * （模型的动作从那个页面送进扩展），所以只需授权被操作的那个页面。
 * 授权动作必须在选项页完成 —— host 权限要用户手势，网页面上的按钮给不了。
 */
let aiPages: AiPage[] = [];

function aiStatus(text: string, kind: "ok" | "err" | "warn" | "info" = "info"): void {
	const box = $("aiStatus");
	box.textContent = text;
	box.className = `status ${kind}`;
}

function renderAiPages(): void {
	const list = $("aiList");
	if (aiPages.length === 0) {
		list.replaceChildren(el("div", "empty", "还没有授权任何页面 —— 模型现在没有可操作的页面。"));
		return;
	}
	list.replaceChildren(
		...aiPages.map((page) => {
			const named = Boolean(page.title) && page.title !== page.origin;
			const card = el("div", "pair");
			card.append(el("div", "who", named ? (page.title as string) : page.origin));
			if (named) card.append(el("div", "meta", page.origin));
			const actions = el("div", "actions");
			const drop = el("button", undefined, "收回授权");
			drop.addEventListener("click", () => void revokePage(page));
			actions.append(drop);
			card.append(actions);
			return card;
		}),
	);
}

async function grantPage(): Promise<void> {
	const origin = normalizeOrigin($<HTMLInputElement>("aiPageInput").value);
	if (!origin) {
		aiStatus("地址不合法：要 http/https 的 origin，例如 http://localhost:5173", "err");
		return;
	}
	const pattern = originPattern(origin);
	let granted = false;
	try {
		// 必须在这条点击链里（用户手势）——所以「授权页面」只能在这里完成
		granted = await chrome.permissions.request({ origins: [pattern] });
	} catch {
		granted = false;
	}
	if (!granted) {
		aiStatus(`没授权 ${pattern} —— 不授权就没法在那个页面里装控制桥`, "err");
		return;
	}
	// 标题从候选里带过来（用户认标题比认 origin 快）
	const recent = await loadRecent();
	aiPages = await grantAiPage(origin, recent.find((item) => item.origin === origin)?.title);
	$<HTMLInputElement>("aiPageInput").value = "";
	renderAiPages();
	const res = await notifyPairsChanged();
	aiStatus(
		res?.installed
			? `已授权 ${origin}；${res.installed} 个已打开的页面已就绪`
			: `已授权 ${origin}（打开那个页面后自动就绪）`,
		"ok",
	);
	await refreshOriginOptions();
}

async function revokePage(page: AiPage): Promise<void> {
	aiPages = await revokeAiPage(page.origin);
	renderAiPages();
	await notifyPairsChanged([page.origin]);
	aiStatus(`已收回 ${page.origin} 的授权`, "ok");
}

/** `?grant=<url>`：从开发页的拾取浮条「让 AI 操作本页…」跳过来（已预填本页）。 */
async function initGrantDeepLink(): Promise<void> {
	const raw = new URLSearchParams(location.search).get("grant");
	if (!raw) return;
	const origin = normalizeOrigin(raw);
	if (!origin) return;
	$<HTMLInputElement>("aiPageInput").value = origin;
	aiStatus(`已填入 ${origin} —— 点「授权该页面」，它就成为模型可操作的页面`, "info");
	$<HTMLButtonElement>("aiGrant").focus();
}

async function initAiPanel(): Promise<void> {
	aiPages = await loadAiPages();
	renderAiPages();
	$("aiGrant").addEventListener("click", () => void grantPage());
	// 别的选项页标签改了授权表 → 这边跟着刷新
	chrome.storage.onChanged?.addListener((changes, area) => {
		if (area !== "local" || !changes[AI_PAGES_KEY]) return;
		void (async () => {
			aiPages = await loadAiPages();
			renderAiPages();
		})();
	});
}

void initAiPanel().then(initGrantDeepLink);
