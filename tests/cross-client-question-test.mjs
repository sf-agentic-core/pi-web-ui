/**
 * 回归：**clientId 变了（另一标签页 / 换设备 / PWA 重开）后，待答问卷不会再丢**。
 *
 * 这是 issue #217 类问题在手机上的真实形态：clientId 存 sessionStorage（每标签页
 * 独立），移动端浏览器一关/一换容器就变新 id。0.84.0 行为（改前红）：
 *   问卷只活在持有它的那个 ClientSession 内存里 —— 新 id 的快照 pendingQuestion
 *   是 null、也收不到 question_pending、question_answer 静默无效，模型那支 run
 *   永远挂起。修好后（backport upstream f1707f6）：无其他在线浏览器时新 id
 *   自动认领残留会话，问卷随快照一起回来，能直接回答。
 *
 * 零 token：本地假模型（openai-completions SSE）第一回合固定调 ask_user_question，
 * 第二回合把工具结果回显成 assistant 文本。
 *
 * 用法: npm run build && node tests/cross-client-question-test.mjs
 */
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8976);
const MOCK_PORT = PORT + 1;
freePort(PORT);
freePort(MOCK_PORT);
const base = mkdtempSync(join(tmpdir(), "pi-web-xclient-q-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const d of [projDir, dataDir, agentDir]) mkdirSync(d, { recursive: true });

const MODEL_ID = "mock-model";
/** 模拟「关掉浏览器的那个标签页」——新连接用全新 clientId（sessionStorage 另开）。 */
const CLIENT_GONE = "mobile-before";
const CLIENT_NEW = "mobile-after";

const QUESTIONS = [
	{
		id: "scope",
		header: "范围",
		question: "要做到什么程度？",
		options: [{ label: "最小可用" }, { label: "完整实现" }],
	},
];

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

// ---------------------------------------------------------------- 假模型
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "xmock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});

const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }] }),
		);
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) return void res.writeHead(404).end();
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	// 只看最后一条：工具结果回来了 = 第二回合（回显答案）；否则第一回合（提问）。
	const last = messages[messages.length - 1];
	if (last?.role === "tool") {
		sse(res, [
			delta(payload.model, { content: `ANSWERED:${String(last.content ?? "")}` }),
			delta(payload.model, {}, "stop"),
		]);
		return;
	}
	if (!Array.isArray(payload.tools) || payload.tools.length === 0) {
		sse(res, [delta(payload.model, { content: "ok" }), delta(payload.model, {}, "stop")]);
		return;
	}
	sse(res, [
		delta(payload.model, {
			tool_calls: [
				{
					index: 0,
					id: `call_ask_${Date.now()}`,
					type: "function",
					function: { name: "ask_user_question", arguments: JSON.stringify({ questions: QUESTIONS }) },
				},
			],
		}),
		delta(payload.model, {}, "tool_calls"),
	]);
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ mock: { type: "api_key", key: "mock-key" } }));
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
				apiKey: "mock-key",
				models: [{ id: MODEL_ID, name: "Mock", input: ["text"], contextWindow: 32000, maxTokens: 4096 }],
			},
		},
	}),
);

const repoRoot = realpathSync(new URL("../", import.meta.url));
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "ignore", "pipe"],
});
server.stderr?.on("data", (d) => process.stderr.write("[srv] " + d));

const waitForPort = async (port, timeout = 25000) => {
	const started = Date.now();
	while (Date.now() - started < timeout) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch {
			/* starting */
		}
		await sleep(100);
	}
	throw new Error(`server did not start on ${port}`);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.received = [];
		this.state = null;
		ws.on("message", (raw) => {
			const m = JSON.parse(raw.toString());
			this.received.push(m);
			if (m.type === "snapshot") this.state = m.state;
			else if (m.type === "snapshot_delta" && this.state && this.state.rev === m.baseRev) {
				this.state = { ...this.state, ...m.state, messages: [...this.state.messages, ...(m.appended ?? [])] };
			}
		});
	}
	send(m) {
		this.ws.send(JSON.stringify(m));
	}
	seen(type, pred = () => true) {
		return this.received.filter((m) => m.type === type && pred(m));
	}
	async waitForType(type, pred = () => true, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			for (let i = 0; i < this.received.length; i++) {
				if (this.received[i].type !== type || !pred(this.received[i])) continue;
				return this.received.splice(i, 1)[0];
			}
			await sleep(50);
		}
		throw new Error(`timeout waiting for ${type}`);
	}
	async waitForState(pred, timeout = 30000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (this.state && pred(this.state)) return this.state;
			await sleep(50);
		}
		throw new Error("timeout waiting for state");
	}
}

const connect = async (clientId) => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		ws.once("open", resolve);
		ws.once("error", reject);
	});
	const c = new Client(ws);
	c.send({ type: "hello", clientId, locale: "zh" });
	await c.waitForType("ready");
	return c;
};

/** assistant 文本（判模型是否真的收到了答案并继续）。 */
const textOf = (messages) =>
	messages
		.filter((m) => m.role === "assistant")
		.flatMap((m) => m.content ?? [])
		.map((b) => b.text ?? "")
		.join("\n");

let wsA;
let wsB;
let dbg;
try {
	await waitForPort(PORT);

	// ---- 1) 手机：提问（本页拿到面板） -------------------------------------
	const a = await connect(CLIENT_GONE);
	dbg = a;
	wsA = a.ws;
	await a.waitForType("snapshot");
	a.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await a.waitForState((s) => s.model?.id === MODEL_ID);
	a.send({ type: "prompt", text: "先问我几个问题" });
	const pending = await a.waitForType("question_pending", () => true, 40000);
	const stateA = await a.waitForState((s) => s.pendingQuestion?.id === pending.id, 10000);
	check(
		"提问方拿到问卷（即时通道 + 快照）",
		stateA.isStreaming === true && stateA.pendingQuestion.questions.length === 1,
	);

	// ---- 2) 关掉那个浏览器（clientId 变了）: 换新 id 连上来 -----------------
	wsA.close();
	await sleep(1500);
	const b = await connect(CLIENT_NEW);
	wsB = b.ws;
	b.send({ type: "get_state" });
	const snapB = await b.waitForType("snapshot", () => true, 20000);

	check(
		"新 clientId 收到待答问卷（改前：pendingQuestion=null，问卷从眼前消失）",
		snapB.state.pendingQuestion?.id === pending.id,
		`pendingQuestion=${snapB.state.pendingQuestion?.id ?? "null"}`,
	);
	check(
		"问卷内容（题干 + 选项）完整带回",
		snapB.state.pendingQuestion?.questions?.[0]?.options?.length === 2,
		JSON.stringify(snapB.state.pendingQuestion?.questions?.[0]?.options ?? null),
	);
	const adoptNotice = b
		.seen("notice")
		.map((m) => m.text ?? m.textEn ?? "")
		.join(" | ");
	check(
		"新 id 收到「已恢复你关闭浏览器前的工作会话」提示",
		/恢复|restored/i.test(adoptNotice),
		adoptNotice || "无提示",
	);

	// ---- 3) 在新 id 上回答：模型必须继续 -----------------------------------
	b.send({ type: "question_answer", id: pending.id, answers: [{ id: "scope", selected: ["最小可用"] }] });
	const done = await b.waitForState(
		(s) => s.pendingQuestion == null && textOf(s.messages).includes("ANSWERED:"),
		30000,
	);
	check("新 clientId 的答案送达模型（run 收场、不再永久挂起）", true);
	check("模型回显了所选 label", textOf(done.messages).includes("最小可用"), textOf(done.messages).slice(-60));
	check("回答后快照不再挂待答问卷", done.pendingQuestion == null);

	console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
} catch (err) {
	console.error("ERR", err);
	if (dbg?.state) {
		console.error("[d] isStreaming:", dbg.state.isStreaming, "pendingQuestion:", dbg.state.pendingQuestion?.id ?? null);
		console.error("[d] notices:", JSON.stringify(dbg.seen("notice").map((m) => m.text ?? m.textEn)));
	}
	failures++;
} finally {
	try {
		wsA?.close();
		wsB?.close();
		server.kill("SIGTERM");
		mock.close();
	} catch {
		/* ignore */
	}
}
process.exit(failures === 0 ? 0 : 1);
