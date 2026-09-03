/**
 * Regression test (bug found in production, Sept 2026 saulfernandez/tachikoma
 * deployment): `/cwd <relative-path>` (client message `set_cwd`) must resolve
 * relative paths against the configured workspace root (`PI_WEB_CWD`), not
 * against the Node process's real `process.cwd()`.
 *
 * Docker deployments run with `WORKDIR /app` while `PI_WEB_CWD=/workspace`
 * mounts the real project tree — spawning the server with a process cwd that
 * differs from PI_WEB_CWD reproduces that exact split. Before the fix,
 * `set_cwd("child")` resolved to `<process-cwd>/child` (ENOENT) instead of
 * `<PI_WEB_CWD>/child`.
 */
import { portUp, freePort } from "./lib/port-utils.mjs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const REPO_ROOT = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8899;

// Workspace root (PI_WEB_CWD) — has a child dir we'll switch into by RELATIVE name.
const WORKSPACE = mkdtempSync(join(tmpdir(), "pi-workspace-"));
const CHILD_NAME = "child-project";
mkdirSync(join(WORKSPACE, CHILD_NAME));
writeFileSync(join(WORKSPACE, CHILD_NAME, "marker.txt"), "child\n");

// Process cwd DELIBERATELY different from WORKSPACE (mirrors Docker's /app vs
// /workspace split) — a same-named sibling dir here must NOT be picked.
const PROCESS_CWD = mkdtempSync(join(tmpdir(), "pi-process-cwd-"));
mkdirSync(join(PROCESS_CWD, CHILD_NAME));
writeFileSync(join(PROCESS_CWD, CHILD_NAME, "marker.txt"), "WRONG-process-cwd\n");

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

try {
	execSync("npm run build", { cwd: REPO_ROOT, stdio: "ignore" });
} catch {
	console.error("build failed");
	process.exit(1);
}

const server = spawn("node", [join(REPO_ROOT, "dist/server/index.js")], {
	cwd: PROCESS_CWD, // <- real process.cwd(), intentionally != PI_WEB_CWD
	env: { ...process.env, PI_WEB_PORT: String(PORT), PI_WEB_CWD: WORKSPACE },
	stdio: "ignore",
});
for (let i = 0; i < 40 && !(await portUp(PORT)); i++) await sleep(250);

const clientId = randomUUID();
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
let seq = 0;
const send = (msg) => ws.send(JSON.stringify({ ...msg, seq: ++seq }));

let snapshot = null;
const notices = [];

ws.on("message", (d) => {
	let m;
	try {
		m = JSON.parse(d.toString());
	} catch {
		return;
	}
	if (m.type === "snapshot") snapshot = m.state;
	else if (m.type === "snapshot_delta") {
		if (snapshot && snapshot.rev === m.baseRev) {
			snapshot = { ...snapshot, ...m.state };
		}
	} else if (m.type === "notice") notices.push(m);
});

ws.on("open", () => send({ type: "hello", clientId, protocolVersion: 3 }));
for (let i = 0; i < 40 && !snapshot; i++) await sleep(100);
check("initial snapshot received", !!snapshot);

notices.length = 0;
send({ type: "set_cwd", path: CHILD_NAME }); // RELATIVE path — the regression case
for (
	let i = 0;
	i < 40 && !notices.some((n) => /path.*(不是|is not a)|ENOENT|no such file/i.test(n.text ?? n.textEn ?? ""));
	i++
) {
	await sleep(100);
	if (snapshot?.cwd === join(WORKSPACE, CHILD_NAME)) break;
}

check(
	"set_cwd(relative) resolves against PI_WEB_CWD, not process.cwd()",
	snapshot?.cwd === join(WORKSPACE, CHILD_NAME),
	`got cwd=${snapshot?.cwd}`,
);
check(
	"no ENOENT/error notice was emitted",
	!notices.some((n) => /ENOENT|no such file|失败|error/i.test(n.text ?? n.textEn ?? "")),
);

ws.close();
server.kill();
await freePort(PORT);

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nAll checks passed ✓");
