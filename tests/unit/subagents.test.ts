import { describe, expect, it, vi } from "vitest";
import { makeSubagentTools, subagentTitle, type SubagentToolHost } from "../../server/subagents.js";

/** 一个假的 host，工具调用不会真正执行会话（只验证走通与参数透传）。 */
function makeHostSpies() {
	const host: SubagentToolHost = {
		spawnSubagent: vi.fn(async (_prompt, type, _cwd) => `sa-${type}-abc`),
		getSubagent: vi.fn(() => undefined),
		listSubagents: vi.fn(() => []),
		steerSubagent: vi.fn(async () => {}),
		stopSubagent: vi.fn(async () => {}),
		listTemplates: vi.fn(() => [{ name: "reviewer", description: "只读审查" }]),
		isTemplateUsable: vi.fn((name: string) => name === "reviewer"),
	};
	return host;
}

describe("subagents tools", () => {
	it("注册 6 个 subagent_* 工具", () => {
		const host = makeHostSpies();
		const tools = makeSubagentTools(host);
		expect(tools.map((t) => t.name)).toEqual([
			"subagent_spawn",
			"subagent_get_result",
			"subagent_steer",
			"subagent_list",
			"subagent_stop",
			"subagent_templates",
		]);
		// 全部有 description + 参数 schema。
		for (const tool of tools) {
			expect(tool.description.length).toBeGreaterThan(10);
			expect(tool.parameters).toBeDefined();
		}
	});

	it("subagent_spawn 透传 prompt/type/cwd/template 给 host", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		const ctx = { cwd: "/root/proj" } as never;
		const result = await spawn.execute!(
			"t1",
			{ prompt: "调研", type: "explore", template: "reviewer", cwd: "/other" },
			undefined,
			undefined,
			ctx as never,
		);
		expect(host.spawnSubagent).toHaveBeenCalledWith("调研", "explore", "/other", "reviewer");
		// 结果文本含 convId（host 返回值）与类型。
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("sa-explore-abc");
		expect(text.text).toContain("模板：reviewer");
	});

	it("subagent_spawn 未传 cwd 时用 ctx.cwd；不传 template 时不带模板", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		await spawn.execute!("t1", { prompt: "p" } as never, undefined, undefined, { cwd: "/root/proj" } as never);
		expect(host.spawnSubagent).toHaveBeenCalledWith("p", "general", "/root/proj", undefined);
	});

	it("subagent_spawn 模板不存在/停用时不启动并提示", async () => {
		const host = makeHostSpies();
		const [spawn] = makeSubagentTools(host);
		const result = await spawn.execute!("t1", { prompt: "p", template: "ghost" } as never, undefined, undefined, {
			cwd: "/x",
		} as never);
		expect(host.spawnSubagent).not.toHaveBeenCalled();
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("不可用");
		expect(text.text).toContain("ghost");
	});

	it("subagent_get_result 对未知 runId 提示未找到", async () => {
		const host = makeHostSpies();
		const [, getResult] = makeSubagentTools(host);
		const result = await getResult.execute!("t1", { runId: "nope" } as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("未找到");
	});

	it("subagent_steer / subagent_stop 透传 runId", async () => {
		const host = makeHostSpies();
		const [, , steer, , stop] = makeSubagentTools(host);
		await steer.execute!("t1", { runId: "sa-1", message: "改方向" } as never, undefined, undefined, {} as never);
		await stop.execute!("t1", { runId: "sa-1" } as never, undefined, undefined, {} as never);
		expect(host.steerSubagent).toHaveBeenCalledWith("sa-1", "改方向");
		expect(host.stopSubagent).toHaveBeenCalledWith("sa-1");
	});

	it("subagent_list 汇总 host 返回", async () => {
		const host = makeHostSpies();
		(host.listSubagents as ReturnType<typeof vi.fn>).mockReturnValue([
			{
				convId: "sa-1",
				type: "explore",
				title: "调研",
				prompt: "",
				state: "running",
				streaming: true,
				messageCount: 3,
				output: "…",
			},
		]);
		const [, , , list] = makeSubagentTools(host);
		const result = await list.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("sa-1");
		expect(text.text).toContain("explore");
		expect(text.text).toContain("running");
	});

	it("subagent_templates 列出宿主返回的可用模板", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "reviewer", description: "只读审查" },
			{ name: "reporter", description: "报告整理" },
		]);
		const tools = makeSubagentTools(host);
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const result = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("reviewer");
		expect(text.text).toContain("reporter");
		expect(text.text).toContain("subagent_spawn");
	});

	it("subagent_templates 空清单给出引导文案", async () => {
		const host = makeHostSpies();
		(host.listTemplates as ReturnType<typeof vi.fn>).mockReturnValue([]);
		const tools = makeSubagentTools(host);
		const templatesTool = tools.find((t) => t.name === "subagent_templates")!;
		const result = await templatesTool.execute!("t1", {} as never, undefined, undefined, {} as never);
		const text = result.content?.[0] as { text: string };
		expect(text.text).toContain("当前没有");
	});
});

describe("subagentTitle", () => {
	it("取 prompt 首行并截断", () => {
		expect(subagentTitle("调研 RPC 路径")).toBe("调研 RPC 路径");
		expect(subagentTitle("第一行\n第二行")).toBe("第一行");
		expect(subagentTitle("x".repeat(80))).toHaveLength(41);
	});
});
