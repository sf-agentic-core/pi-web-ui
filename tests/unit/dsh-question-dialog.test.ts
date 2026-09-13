// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { DshQuestionDialog } from "../../web/src/components/DshQuestionDialog.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { LanguageProvider } from "../../web/src/i18n.js";

/**
 * DshQuestionDialog 测试（jsdom）：验证
 *   1. 富渲染：question/detail 按 markdown（rawHtml），选项描述/预览富文本
 *   2. 向导式：一次只显示一题；单选点选项自动切下一题；末题点选项自动提交
 *   3. 上一步可回头修改；底部取消发送 cancelled 回答
 * 全部确定性、零 token、零模型 —— 不依赖 DSH 引擎是否真发 preview。
 */

type Question = Parameters<typeof DshQuestionDialog>[0]["question"];

const baseQuestion: Question = {
	id: "q1",
	questions: [
		{
			id: "c1",
			question: "Which **one**?",
			detail: "Pick an <em>option</em> below.",
			options: [
				{ label: "A", description: "Opt **A**", preview: "**preview A**\n\n- a1\n- a2" },
				{ label: "B", description: "Opt B" },
			],
		},
	],
};

const wizardQuestion: Question = {
	id: "q2",
	questions: [
		{ id: "c1", question: "Q1", options: [{ label: "A" }, { label: "B" }] },
		{ id: "c2", question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
	],
};

let root: Root | null = null;

function mount(question: Question = baseQuestion, send: (msg: unknown) => boolean = () => true) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	const sent: unknown[] = [];
	// 组件不再接 send prop——发消息走全局发送器（web/src/app-globals.ts 的 appSend），
	// 测试在这里注入实现并记录（这也是全局化后组件可测的方式）。
	setAppSend((msg) => {
		sent.push(msg);
		return send(msg);
	});
	act(() => {
		root!.render(
			createElement(
				LanguageProvider,
				null,
				createElement(DshQuestionDialog, {
					question,
				}),
			),
		);
	});
	return { container, sent };
}

function click(container: HTMLElement, sel: string | HTMLElement) {
	const el = typeof sel === "string" ? (container.querySelector(sel) as HTMLElement) : sel;
	if (!el) throw new Error(`cannot find ${sel}`);
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

afterEach(() => {
	setAppSend(null); // 断开全局发送器，避免串到下一个用例
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

describe("DshQuestionDialog rich rendering", () => {
	it("question 按 markdown 渲染（**粗体** → <strong>）", () => {
		const { container } = mount();
		const strong = container.querySelector(".question-head strong");
		expect(strong?.textContent).toBe("one");
	});

	it("detail 里的内嵌 HTML 按 rawHtml 渲染成 <em>", () => {
		const c = mount();
		expect(c.container.querySelector(".set-hint em")?.textContent).toBe("option");
	});

	it("选项描述按 markdown 渲染", () => {
		const c = mount();
		expect(c.container.querySelector(".question-option .set-row-desc strong")?.textContent).toBe("A");
	});

	it("未选中带 preview 选项时无预览框，选中后出现富文本预览", () => {
		const c = mount();
		expect(c.container.querySelector(".question-preview")).toBeNull();

		// 点击带 preview 的选项 A（单选 → 自动提交；组件不被卸载，预览仍在）
		click(c.container, ".question-option");

		const preview = c.container.querySelector(".question-preview");
		expect(preview).not.toBeNull();
		expect(preview?.querySelector(".question-preview-label")?.textContent?.length).toBeGreaterThan(0);
		// preview markdown 渲染：**preview A** → <strong>，列表 → <li>
		expect(preview?.querySelector("strong")?.textContent).toBe("preview A");
		expect(preview?.querySelectorAll("li").length).toBe(2);
	});
});

describe("DshQuestionDialog wizard", () => {
	it("多题时每次只显示一题，点选项直接进入下一题", () => {
		const c = mount(wizardQuestion);
		expect(c.container.textContent).toContain("Q1");
		expect(c.container.textContent).not.toContain("Q2");

		click(c.container, ".question-option"); // 选第一题 A

		expect(c.container.textContent).toContain("Q2");
		expect(c.container.textContent).not.toContain("Q1");
		// 进度指示可见
		expect(c.container.querySelector(".question-progress")?.textContent).toContain("2");
		expect(c.container.textContent).toContain("2 /");
	});

	it("单选点选项即选中（标记 ●），上一步可返回并已记住选择", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".question-option"); // 第一题选 A → 切到第二题

		// 回退后第一题仍在，且 A 已选中
		click(c.container, ".dialog-prev");
		expect(c.container.textContent).toContain("Q1");
		const activeRows = c.container.querySelectorAll(".question-option.active").length;
		expect(activeRows).toBe(1);
	});

	it("第一题禁用「上一步」", () => {
		const c = mount(wizardQuestion);
		const prev = c.container.querySelector(".dialog-prev") as HTMLButtonElement;
		expect(prev.disabled).toBe(true);
	});

	it("最后一题点选项自动提交全部答案（含前几题的选择）", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".question-option"); // Q1 → A
		click(c.container, ".question-option"); // Q2 → X（最后一题 → 自动提交）

		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { type: string; answers: unknown[]; cancelled?: boolean };
		expect(msg.type).toBe("question_answer");
		expect(msg.cancelled ?? false).toBe(false);
		expect(msg.answers).toEqual([
			{ id: "c1", selected: ["A"] },
			{ id: "c2", selected: ["X"] },
		]);
	});

	it("单题问卷点选项即自动提交", () => {
		const c = mount(baseQuestion);
		click(c.container, ".question-option"); // 唯一题的选项 A
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: unknown[] };
		expect(msg.answers).toEqual([{ id: "c1", selected: ["A"] }]);
	});

	it("底部「取消」发送 cancelled 回答", () => {
		const c = mount(wizardQuestion);
		click(c.container, ".dialog-dismiss-inline");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { cancelled?: boolean; answers: unknown[] };
		expect(msg.cancelled).toBe(true);
		expect(msg.answers).toEqual([]);
	});

	it("多选题点选项只切换勾选、不前进；下一步/提交推进", () => {
		const q: Question = {
			id: "q3",
			questions: [
				{
					id: "c1",
					question: "M1",
					multiSelect: true,
					options: [{ label: "A" }, { label: "B" }],
				},
				{ id: "c2", question: "Q2", options: [{ label: "X" }] },
			],
		};
		const c = mount(q);
		const opts = () => Array.from(c.container.querySelectorAll(".question-option")) as HTMLElement[];
		click(c.container, ".question-option"); // 勾选 A
		click(c.container, opts()[1]); // 勾选 B（仍在第一题）
		expect(c.container.textContent).toContain("M1");
		expect(c.container.textContent).not.toContain("Q2");

		// 下一题按钮可用 → 推进
		const nextBtn = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(nextBtn.disabled).toBe(false);
		click(c.container, ".dialog-submit");
		expect(c.container.textContent).not.toContain("M1");
		expect(c.container.textContent).toContain("Q2");

		// 最后一题点选项 → 提交，选中含多选两项
		click(c.container, ".question-option");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: { id: string; selected: string[] }[] };
		expect(msg.answers[0]).toEqual({ id: "c1", selected: ["A", "B"] });
	});

	it("无选项的自定义题：未输入文字也可提交（空提交 = 跳过）", () => {
		const q: Question = {
			id: "q4",
			questions: [{ id: "fill", question: "补充说明（可选）", options: [] }],
		};
		const c = mount(q);
		const submit = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(false); // 无选项 → 空提交允许
		click(c.container, ".dialog-submit");
		expect(c.sent).toHaveLength(1);
		const msg = c.sent[0] as { answers: unknown[]; cancelled?: boolean };
		expect(msg.cancelled ?? false).toBe(false);
		expect(msg.answers).toEqual([{ id: "fill", selected: [] }]); // 无 custom 键
	});

	it("有选项但未选、也未填字：提交仍禁用（可选题≠可跳过）", () => {
		const c = mount(baseQuestion);
		const submit = c.container.querySelector(".dialog-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true); // 有选项仍须作答
	});
});

/**
 * 选项详情浮层回归：描述曾经是 `.question-option` 里的 absolute 层
 * （`bottom: calc(100% + 6px)`），被 `.dialog-inline{max-height:45vh; overflow-y:auto}`
 * 在上方裁掉、滚也滚不到。改用 HoverDetail（portal 到 body + fixed）后，
 * 浮层必须挂在对话框子树之外，才谈得上「不受任何祖先 overflow 裁剪」。
 */
describe("DshQuestionDialog 选项详情浮层", () => {
	const tip = () => document.body.querySelector(".question-desc-tip");

	it("hover 选项时以顶层浮层渲染：内容富文本，且不在对话框子树里", () => {
		const c = mount();
		expect(tip()).toBeNull();

		const row = c.container.querySelector(".question-option") as HTMLElement;
		act(() => {
			row.dispatchEvent(new MouseEvent("mouseenter"));
		});

		const el = tip();
		expect(el).not.toBeNull();
		expect(el?.getAttribute("role")).toBe("tooltip");
		// 关键：不在 .dialog-inline 内 —— 因此不受它的 max-height / overflow 裁剪
		expect(c.container.querySelector(".question-desc-tip")).toBeNull();
		expect(el?.querySelector("strong")?.textContent).toBe("A"); // "Opt **A**" 走 markdown
	});

	it("指针移开后留宽限期再收起（浮层可悬停/滚动）", () => {
		vi.useFakeTimers();
		try {
			const c = mount();
			const row = c.container.querySelector(".question-option") as HTMLElement;
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseenter"));
			});
			expect(tip()).not.toBeNull();

			act(() => {
				row.dispatchEvent(new MouseEvent("mouseleave"));
			});
			expect(tip()).not.toBeNull(); // 宽限期内仍在（指针可移入浮层继续读）

			act(() => {
				vi.advanceTimersByTime(500);
			});
			expect(tip()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("鼠标移进浮层时不收起：relatedTarget 在浮层内（真实浏览器里这条 leave 晚于浮层 enter）", () => {
		vi.useFakeTimers();
		try {
			const c = mount();
			const row = c.container.querySelector(".question-option") as HTMLElement;
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseenter"));
			});
			const inner = tip()?.querySelector("strong") as HTMLElement;
			expect(inner).toBeTruthy();

			// 浮层 portal 到 body，DOM 上不在选项行子树里 —— 指针移进浮层时锚点照样收到
			// mouseleave，且实测它派发在浮层的 onMouseEnter 之后。以 relatedTarget 判定，
			// 不能只看事件先后（否则宽限期定时器会把浮层关掉）。
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: inner }));
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			expect(tip()).not.toBeNull();

			// 真正离开（relatedTarget 落在浮层外）才收起。
			act(() => {
				row.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: row }));
			});
			act(() => {
				vi.advanceTimersByTime(500);
			});
			expect(tip()).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});
});
