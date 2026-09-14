// Web Push endpoints — protocol smoke test (zero token, no outbound network).
//
// What this covers that the unit tests cannot: the Express wiring itself.
// server/push/store|sender|announce are unit-tested in depth (including the
// RFC 8291 test vector and a receiver that opens what the sender produced), but
// "is the route registered, does it sit behind PI_WEB_TOKEN, does it answer 400
// for a hostile endpoint" is only observable against a running server.
//
// Deliberately offline: the endpoints are exercised with a real subscription
// shape, but nothing is ever sent. Delivery cannot be verified here anyway (it
// needs a real push service and a real device) — that is what the settings
// panel's "send a test notification" button is for.
//
// Also asserts the invariant the whole feature rests on: the VAPID public key
// is stable across a restart. If it changed, every subscription a browser ever
// made would silently stop working.
//
// Usage: npm run build && node tests/push-endpoints-test.mjs [port]
import { mkdtempSync, mkdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { realpathSync as realpath } from "node:fs";
const PORT = Number(process.argv[2] || 8991);
const TOKEN = "push-smoke-token-1";
const base = mkdtempSync(join(tmpdir(), "pi-web-push-"));
const workdir = join(base, "work");
const dataDir = join(base, "data");
const agentDir = join(base, "agent");
for (const dir of [workdir, dataDir, agentDir]) mkdirSync(dir, { recursive: true });

const NODE = realpath(process.execPath);
const root = join(import.meta.dirname, "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok - ${name}`);
	} else {
		failed++;
		console.error(`  FAIL - ${name} ${extra}`);
	}
}

function startServer() {
	const server = spawn(NODE, ["dist/server/index.js"], {
		cwd: root,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: workdir,
			PI_CODING_AGENT_DIR: agentDir,
			PI_WEB_TOKEN: TOKEN,
			PI_WEB_PUSH_ANNOUNCE: "0", // 断言里不需要任何出网行为
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	server.stdout.on("data", (d) => {
		if (process.env.PI_WEB_SMOKE_VERBOSE) process.stdout.write(d);
	});
	server.stderr.on("data", (d) => process.stderr.write(d));
	return server;
}

async function waitForHealth(timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
			if (res.ok) return true;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	return false;
}

/** Stop the server and wait for the port to be free before reusing it. */
async function stopServer(server) {
	const exited = new Promise((resolve) => server.once("exit", resolve));
	server.kill("SIGTERM");
	await exited;
	for (let i = 0; i < 50; i++) {
		try {
			await fetch(`http://127.0.0.1:${PORT}/api/health`);
		} catch {
			return; // refused → free
		}
		await sleep(200);
	}
}

const auth = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const url = (path) => `http://127.0.0.1:${PORT}${path}`;

/** A subscription as a browser builds one (real P-256 point + 16-byte secret). */
function fakeSubscription(seed) {
	const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" });
	const p256dh = Buffer.concat([
		Buffer.from([0x04]),
		Buffer.from(jwk.x ?? "", "base64url"),
		Buffer.from(jwk.y ?? "", "base64url"),
	]).toString("base64url");
	return {
		endpoint: `https://fcm.googleapis.com/wp/smoke-${seed}`,
		keys: { p256dh, auth: Buffer.alloc(16, seed).toString("base64url") },
	};
}

const subscribe = (clientId, subscription) =>
	fetch(url("/api/push/subscribe"), {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ clientId, subscription }),
	});

const server = startServer();
try {
	if (!(await waitForHealth())) {
		console.error("server did not come up");
		process.exit(1);
	}

	// --- auth: the new routes must sit behind PI_WEB_TOKEN -------------------
	const noToken = await fetch(url("/api/push/config"));
	check("config sin token → 401", noToken.status === 401, `got ${noToken.status}`);

	// --- config -------------------------------------------------------------
	const config = await fetch(url("/api/push/config"), { headers: auth });
	const configBody = await config.json();
	check("config con token → 200", config.status === 200, `got ${config.status}`);
	check("config.available", configBody.available === true);
	check("config.instanceName por defecto", configBody.instanceName === "pi-web-ui", configBody.instanceName);
	check("config.subscriptions = 0", configBody.subscriptions === 0, String(configBody.subscriptions));
	const publicKey = Buffer.from(configBody.publicKey ?? "", "base64url");
	check("publicKey es un punto P-256 sin comprimir", publicKey.length === 65 && publicKey[0] === 0x04);
	check("vapid.json creado en el data-dir", existsSync(join(dataDir, "vapid.json")));
	check("vapid.json es 0600", (statSync(join(dataDir, "vapid.json")).mode & 0o777) === 0o600);

	// --- subscribe ----------------------------------------------------------
	const first = await subscribe("client-a", fakeSubscription(1));
	const firstBody = await first.json();
	check("subscribe válido → ok", first.status === 200 && firstBody.ok === true, JSON.stringify(firstBody));
	check("subscribe cuenta 1 dispositivo", firstBody.subscriptions === 1, JSON.stringify(firstBody));

	const again = await subscribe("client-a", fakeSubscription(1));
	const againBody = await again.json();
	check("re-suscribir el mismo endpoint es idempotente", againBody.subscriptions === 1, JSON.stringify(againBody));

	const second = await subscribe("client-b", fakeSubscription(2));
	check("segundo dispositivo cuenta 2", (await second.json()).subscriptions === 2);

	// --- SSRF / validation table -------------------------------------------
	const hostile = [
		["http (no https)", { ...fakeSubscription(3), endpoint: "http://fcm.googleapis.com/wp/x" }],
		["loopback literal", { ...fakeSubscription(3), endpoint: "https://127.0.0.1/wp/x" }],
		["metadata de cloud", { ...fakeSubscription(3), endpoint: "https://169.254.169.254/latest" }],
		["hostname interno", { ...fakeSubscription(3), endpoint: "https://metadata.google.internal/x" }],
		["credenciales en la URL", { ...fakeSubscription(3), endpoint: "https://u:p@fcm.googleapis.com/wp/x" }],
	];
	for (const [label, subscription] of hostile) {
		const res = await subscribe("client-c", subscription);
		const body = await res.json();
		check(
			`rechaza endpoint: ${label}`,
			res.status === 400 && body.error === "invalid-subscription",
			`got ${res.status}`,
		);
	}
	const badKeys = await subscribe("client-c", { ...fakeSubscription(4), keys: { p256dh: "AAAA", auth: "AAAA" } });
	check("rechaza claves con longitud incorrecta", badKeys.status === 400, `got ${badKeys.status}`);
	const noClient = await fetch(url("/api/push/subscribe"), {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ subscription: fakeSubscription(5) }),
	});
	check("rechaza suscripción sin clientId", noClient.status === 400, `got ${noClient.status}`);

	// --- test endpoint without any target -----------------------------------
	const subA = fakeSubscription(1).endpoint;
	await fetch(url("/api/push/unsubscribe"), {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ endpoint: subA }),
	});
	await fetch(url("/api/push/unsubscribe"), {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ endpoint: fakeSubscription(2).endpoint }),
	});
	const emptyTest = await fetch(url("/api/push/test"), { method: "POST", headers: auth, body: "{}" });
	const emptyTestBody = await emptyTest.json();
	check(
		"test sin suscripciones → 404",
		emptyTest.status === 404 && emptyTestBody.error === "no-subscription",
		`got ${emptyTest.status}`,
	);

	const badUnsub = await fetch(url("/api/push/unsubscribe"), {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ endpoint: 42 }),
	});
	check("unsubscribe sin endpoint válido → 400", badUnsub.status === 400, `got ${badUnsub.status}`);

	// --- the invariant everything else depends on: stable VAPID key ---------
	await subscribe("client-a", fakeSubscription(1));
	await stopServer(server);
	const restarted = startServer();
	try {
		if (!(await waitForHealth())) {
			console.error("server did not come back up");
			process.exit(1);
		}
		const after = await (await fetch(url("/api/push/config"), { headers: auth })).json();
		check(
			"la clave VAPID sobrevive al reinicio (si cambiara, todas las suscripciones morirían)",
			after.publicKey === configBody.publicKey,
		);
		check("las suscripciones sobreviven al reinicio", after.subscriptions === 1, String(after.subscriptions));
	} finally {
		await stopServer(restarted);
	}
} finally {
	server.kill("SIGKILL");
}

console.log(`\n${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
