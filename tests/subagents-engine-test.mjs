// subagents-engine — the Settings → Subagents engine switch (zero tokens, mock provider).
//
// Verifies that switching engines changes BOTH surfaces at once:
//   1. the reported engine + the read-only pi-subagents agent listing, and
//   2. which delegation tools the AI can actually see (snapshot.tools).
//
// The point of the switch is that the model never has two subagent systems to
// choose between, so the tool assertions are the real contract here.
//
// Requires pi-subagents to be installed in the agent dir; it SKIPs otherwise.
//
// Usage: npm run build:server && node tests/subagents-engine-test.mjs
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { freePort } from "./lib/port-utils.mjs";

const PORT = Number(process.argv[2] || 8951);
const MOCK_PORT = PORT + 2;
const CLIENT_ID = "subagents-engine-client";
const MODEL_ID = "mock-text";

// The first-party tools that must disappear in pi-subagents mode.
const FIRST_PARTY = [
	"subagent_spawn",
	"subagent_get_result",
	"subagent_steer",
	"subagent_list",
	"subagent_stop",
	"subagent_wait_all",
	"subagent_templates",
	"delegate_task",
];

// --- locate a real pi-subagents install; skip if absent -----------------------
const REAL_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_SUBAGENTS_ENTRY = join(REAL_AGENT_DIR, "npm", "node_modules", "pi-subagents", "index.ts");
if (!existsSync(PI_SUBAGENTS_ENTRY)) {
	console.log(`subagents-engine-test: SKIP — pi-subagents not found at ${PI_SUBAGENTS_ENTRY}`);
	process.exit(0);
}
const REAL_AGENTS_DIR = join(REAL_AGENT_DIR, "agents");

freePort(PORT);
freePort(MOCK_PORT);

const base = mkdtempSync(join(tmpdir(), "pi-web-engine-"));
const projDir = join(base, "proj");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
mkdirSync(projDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// Agents are read through a symlink on purpose: ~/.pi/agent/agents is a symlink
// in the real deployment, so the scanner must follow it.
if (existsSync(REAL_AGENTS_DIR)) symlinkSync(REAL_AGENTS_DIR, join(agentDir, "agents"));
// Load the real pi-subagents extension by path (its identity still resolves to
// npm:pi-subagents because it lives under node_modules).
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [PI_SUBAGENTS_ENTRY] }, null, 2));
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

// --- mock model ---------------------------------------------------------------
const sse = (res, chunks) => {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const delta = (model, d, finish = null) => ({
	id: "engine-mock",
	object: "chat.completion.chunk",
	created: Date.now(),
	model,
	choices: [{ index: 0, delta: d, finish_reason: finish }],
});
const mock = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
	if (url.pathname.endsWith("/models")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model", name: "Mock", input: ["text"] }] }));
		return;
	}
	if (!url.pathname.endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	for await (const chunk of req) body += chunk;
	const payload = JSON.parse(body || "{}");
	sse(res, [delta(payload.model, { content: "ENGINE_DONE" }), delta(payload.model, {}, "stop")]);
});
await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));

// --- server -------------------------------------------------------------------
const repoRoot = join(import.meta.dirname, "..");
const server = spawn(process.execPath, ["dist/server/index.js"], {
	cwd: repoRoot,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: projDir,
		PI_CODING_AGENT_DIR: agentDir,
	},
	stdio: ["ignore", "pipe", "pipe"],
});
const serverLog = [];
server.stdout?.on("data", (d) => {
	serverLog.push(d.toString());
	if (process.env.TEST_DEBUG) process.stdout.write("[srv-out] " + d.toString());
});
server.stderr?.on("data", (d) => {
	serverLog.push("[err] " + d.toString());
	if (process.env.TEST_DEBUG) process.stderr.write("[srv-err] " + d.toString());
});
server.on("exit", (code) => serverLog.push(`[exit] server exited with ${code}`));

let failures = 0;

/** Collapse line breaks and control characters so a server- or file-provided
 *  value cannot forge extra log lines (CodeQL js/log-injection). */
const safe = (value) => String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 300);

const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${safe(name)}${extra ? " — " + safe(extra) : ""}`);
	if (!ok) failures++;
};

const waitForPort = async (port, timeout = 60000) => {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < timeout) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
		} catch (error) {
			lastError = error;
		}
		await sleep(100);
	}
	throw new Error(
		`server did not start on ${port}` +
			(lastError
				? ` (last fetch error: ${safe(lastError.message)} / cause: ${safe(lastError.cause?.message ?? "-")})`
				: " (fetch never rejected, status was never ok)"),
	);
};

class Client {
	constructor(ws) {
		this.ws = ws;
		this.settings = null;
		this.tools = [];
		ws.on("message", (data) => {
			const m = JSON.parse(data.toString());
			if (m.type === "settings_state") this.settings = m.settings;
			else if (m.type === "snapshot") this.tools = m.state?.tools ?? [];
			else if (m.type === "snapshot_delta" && m.state?.tools) this.tools = m.state.tools;
		});
	}
	send(msg) {
		this.ws.send(JSON.stringify(msg));
	}
	async waitFor(predicate, label, timeout = 40000) {
		const started = Date.now();
		while (Date.now() - started < timeout) {
			if (predicate(this)) return true;
			await sleep(120);
		}
		throw new Error(`timeout waiting for ${label}`);
	}
}

let ws;
try {
	await waitForPort(PORT);
	const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	ws = socket;
	const client = new Client(socket);
	client.send({ type: "hello", clientId: CLIENT_ID, locale: "en" });
	await client.waitFor((c) => c.settings && c.tools.length > 0, "initial state");
	client.send({ type: "set_model", modelId: `mock/${MODEL_ID}` });
	await sleep(800);

	// --- default: first-party engine -----------------------------------------
	check("default engine is pi-web-ui", client.settings.subagentEngine === "pi-web-ui", String(client.settings.subagentEngine));

	const listed = client.settings.piSubagentsAgents ?? [];
	check("pi-subagents agents are listed (read-only)", listed.length > 0, `${listed.length} found`);
	check(
		"listing carries workspace/global + path",
		listed.every((a) => (a.source === "workspace" || a.source === "global") && a.path && a.name),
		`first: ${listed[0]?.name} [${listed[0]?.source}]`,
	);
	check(
		"pi-subagents' built-in agents are NOT listed",
		!listed.some((a) => ["worker", "reviewer", "evidence-auditor"].includes(a.name)),
		"",
	);

	check("pi-web-ui mode exposes the first-party subagent tools", relevantPresent(client.tools, FIRST_PARTY));
	check("pi-web-ui mode hides pi-subagents' `subagent` tool", !client.tools.includes("subagent"));

	// --- switch to pi-subagents ----------------------------------------------
	client.send({ type: "set_subagent_engine", engine: "pi-subagents" });
	await client.waitFor((c) => c.settings.subagentEngine === "pi-subagents", "engine switch");
	await client.waitFor((c) => !relevantPresent(c.tools, FIRST_PARTY), "first-party tools hidden");

	check("engine switched to pi-subagents", client.settings.subagentEngine === "pi-subagents");
	check(
		"first-party subagent tools are hidden",
		!relevantPresent(client.tools, FIRST_PARTY),
		client.tools.filter((t) => t.startsWith("subagent") || t === "delegate_task").join(", ") || "none",
	);
	check("pi-subagents' `subagent` tool is exposed", client.tools.includes("subagent"), client.tools.filter((t) => t.includes("subagent")).join(", "));

	const persisted = JSON.parse(readFileSync(join(dataDir, "subagents-engine.json"), "utf8"));
	check("engine persisted to <dataDir>/subagents-engine.json", persisted.engine === "pi-subagents", JSON.stringify(persisted));

	// --- switch back ---------------------------------------------------------
	client.send({ type: "set_subagent_engine", engine: "pi-web-ui" });
	await client.waitFor((c) => c.settings.subagentEngine === "pi-web-ui", "engine switch back");
	await client.waitFor((c) => relevantPresent(c.tools, FIRST_PARTY), "first-party tools restored");

	check("switching back restores the first-party tools", relevantPresent(client.tools, FIRST_PARTY));
	check("switching back hides `subagent` again", !client.tools.includes("subagent"));
} catch (error) {
	console.error("✗ 异常:", error instanceof Error ? error.message : error);
	console.error("--- server log ---");
	console.error(serverLog.join("").slice(-3000));
	failures++;
} finally {
	try {
		ws?.close();
	} catch {
		/* ignore */
	}
	server.kill();
	mock.close();
	await sleep(300);
	freePort(PORT);
	freePort(MOCK_PORT);
}

/** True when every first-party subagent tool is currently visible. */
function relevantPresent(tools, names) {
	return names.every((n) => tools.includes(n));
}

if (failures > 0) {
	console.error(`\nsubagents-engine-test: ${failures} 项失败`);
	process.exit(1);
}
console.log("\nsubagents-engine-test: all ok");
