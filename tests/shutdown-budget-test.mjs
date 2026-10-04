/**
 * Presupuesto de apagado (SIGTERM) — contrato de cierre del proceso.
 *
 * POR QUÉ EXISTE: el deployment de producción usa `strategy: Recreate`, así que
 * el pod de reemplazo NO ARRANCA hasta que el viejo muere. Si el apagado se
 * queda colgado, el contenedor vive hasta el SIGKILL del kubelet
 * (`terminationGracePeriodSeconds: 900`) => 15 minutos de caída total, medidos
 * dos veces en producción (scale-down y scale-up separados por exactamente 900s).
 *
 * `shutdown()` espera a `service.disposeAll()`, que a su vez espera a las
 * sesiones de agente y bridges MCP vivos: cualquiera de ellos puede no resolver
 * nunca. Este test fija el contrato:
 *
 *   1. SIGTERM => salida LIMPIA (código 0) y rápida, con el servidor en marcha.
 *   2. La salida ocurre DENTRO del presupuesto declarado
 *      (`PI_WEB_SHUTDOWN_BUDGET_MS`), nunca en el orden de los 900s.
 *
 * Nota: el caso "disposeAll() colgado de verdad" no se puede forzar desde
 * fuera sin instrumentar el proceso; se verificó manualmente inyectando un
 * `await new Promise(() => {})` al principio de `disposeAll()` y comprobando
 * que el backstop fuerza la salida con el mensaje
 * "shutdown exceeded <budget>ms — forcing exit". Este test protege la ruta
 * normal y el cableado del presupuesto.
 *
 * Ejecutar: npm run build && node tests/shutdown-budget-test.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { portUp } from "./lib/port-utils.mjs";

const REPO = resolve(process.cwd());
const ENTRY = join(REPO, "dist", "server", "index.js");
const PORT = 8988;
const BUDGET_MS = 4000;
/** Margen para el arranque/cierre real del proceso; nunca cerca de 900s. */
const SLACK_MS = 6000;

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? " — " + extra : ""}`);
	if (!ok) failures++;
};

function startServer() {
	const dataDir = mkdtempSync(join(tmpdir(), "piweb-shutdown-data-"));
	const cwd = mkdtempSync(join(tmpdir(), "piweb-shutdown-cwd-"));
	const proc = spawn("node", [ENTRY], {
		cwd: REPO,
		env: {
			...process.env,
			PI_WEB_PORT: String(PORT),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_DATA_DIR: dataDir,
			PI_WEB_CWD: cwd,
			PI_WEB_SHUTDOWN_BUDGET_MS: String(BUDGET_MS),
			NODE_ENV: "production",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let log = "";
	proc.stdout.on("data", (d) => (log += d.toString()));
	proc.stderr.on("data", (d) => (log += d.toString()));
	return { proc, getLog: () => log };
}

async function main() {
	const { proc, getLog } = startServer();

	let up = false;
	for (let i = 0; i < 80; i++) {
		if (await portUp(PORT)) {
			up = true;
			break;
		}
		await sleep(250);
	}
	check("el servidor arranca y escucha", up, `puerto ${PORT}`);
	if (!up) {
		proc.kill("SIGKILL");
		console.log("\n--- log ---\n" + getLog());
		process.exit(1);
	}

	const startedAt = Date.now();
	proc.kill("SIGTERM");
	const { code, signal } = await new Promise((res) =>
		proc.once("exit", (c, s) => res({ code: c, signal: s })),
	);
	const elapsed = Date.now() - startedAt;

	check("SIGTERM produce salida limpia (código 0)", code === 0, `code=${code} signal=${signal}`);
	check(
		`la salida ocurre dentro del presupuesto (${elapsed}ms <= ${BUDGET_MS + SLACK_MS}ms)`,
		elapsed <= BUDGET_MS + SLACK_MS,
		`budget=${BUDGET_MS}ms`,
	);
	// El fallo de producción: 900s de espera al SIGKILL. Si alguien vuelve a
	// dejar el apagado sin cota, esto lo caza antes de que llegue a un pod.
	check("no se agota el grace period de 900s", elapsed < 60_000, `${elapsed}ms`);
	check("el apagado se anuncia en el log", getLog().includes("shutting down"), "");

	if (failures > 0) console.log("\n--- log ---\n" + getLog());
	console.log(failures === 0 ? "\nOK" : `\n${failures} fallo(s)`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
