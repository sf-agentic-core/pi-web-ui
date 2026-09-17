/**
 * pi-subagents-agents.ts — read-only discovery of `pi-subagents` agent files.
 *
 * pi-subagents resolves its agent roster from several roots. This module scans
 * the *file-backed* ones so the settings panel can list them; the package's own
 * built-in agents are deliberately excluded (they are not user-editable and the
 * panel would misrepresent them as workspace/global entries).
 *
 * Roots, highest precedence first (first match on a name wins):
 *   1. <projectRoot>/.pi/agents        → source "workspace"  (preferred)
 *   2. <projectRoot>/.agents           → source "workspace"  (legacy)
 *   3. <agentDir>/agents               → source "global"
 *   4. $HOME/.agents                   → source "global"     (legacy)
 *   5. $PI_SUBAGENT_EXTRA_AGENT_DIRS   → source "global"     (PATH-style, lowest)
 *
 * Mirrors pi-subagents/src/agents/agents.ts (resolveNearestProjectAgentDirs,
 * userDirOld/userDirNew, extraUserAgentDirs). Kept as a small local scanner
 * rather than importing the package: its public `./agents` subpath exports only
 * runtime-agent registration, and it ships raw TypeScript that this server (a
 * plain compiled-Node process) cannot import directly.
 *
 * Frontmatter parsing is intentionally minimal — name/description/model — and
 * every failure path degrades to "skip this file" so listing can never throw.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, extname, join, resolve } from "node:path";

export interface PiSubagentsAgent {
	/** Agent name (frontmatter `name`, else the file basename). */
	name: string;
	/** Short description from frontmatter (`""` when absent). */
	description: string;
	/** Model reference as written in frontmatter (`provider/id`, or `""`). */
	model: string;
	/** Which root the agent was found in. */
	source: "workspace" | "global";
	/** Absolute path of the definition file. */
	path: string;
}

/** Guard against pathological trees (symlink farms, huge checkouts). */
const MAX_DEPTH = 8;
const MAX_FILES = 2000;

/**
 * Nearest ancestor of `cwd` that carries project config — a `.pi` or `.agents`
 * directory. Mirrors pi-subagents' default `projectRootResolution: "nearest"`.
 */
function findProjectRoot(cwd: string): string | null {
	let dir = resolve(cwd);
	for (let i = 0; i < 64; i++) {
		if (isDir(join(dir, ".pi")) || isDir(join(dir, ".agents"))) return dir;
		const parent = resolve(dir, "..");
		if (parent === dir) return null;
		dir = parent;
	}
	return null;
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory(); // follows symlinks on purpose
	} catch {
		return false;
	}
}

/** Directory entries by name. `statSync` below decides file vs dir (so symlinks
 *  resolve), which makes `withFileTypes` redundant — and avoids its
 *  Buffer-vs-string overload ambiguity under `strict` typing. */
function readNames(dir: string): string[] {
	try {
		return readdirSync(dir).map(String);
	} catch {
		return [];
	}
}

/** Split `PI_SUBAGENT_EXTRA_AGENT_DIRS` the way pi-subagents does (PATH-style). */
function extraAgentDirs(): string[] {
	const raw = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	if (!raw) return [];
	return raw
		.split(delimiter)
		.map((d) => d.trim())
		.filter((d) => d.length > 0);
}

/** Ordered scan roots with their source label. */
function scanRoots(cwd: string, agentDir: string): { dir: string; source: "workspace" | "global" }[] {
	const roots: { dir: string; source: "workspace" | "global" }[] = [];
	const projectRoot = findProjectRoot(cwd);
	if (projectRoot) {
		roots.push({ dir: join(projectRoot, ".pi", "agents"), source: "workspace" });
		roots.push({ dir: join(projectRoot, ".agents"), source: "workspace" });
	}
	roots.push({ dir: join(agentDir, "agents"), source: "global" });
	roots.push({ dir: join(homedir(), ".agents"), source: "global" });
	for (const dir of extraAgentDirs()) roots.push({ dir: resolve(dir), source: "global" });
	return roots;
}

/** Recursively collect `*.md` files, following symlinks but never revisiting a
 *  real directory (symlink loops) and never throwing. */
function collectMarkdown(dir: string): string[] {
	const out: string[] = [];
	const seenDirs = new Set<string>();

	const walk = (current: string, depth: number): void => {
		if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
		let real: string;
		try {
			real = realpathSync(current);
		} catch {
			return;
		}
		if (seenDirs.has(real)) return;
		seenDirs.add(real);

		const entries = readNames(current);
		for (const entry of entries) {
			if (out.length >= MAX_FILES) return;
			if (entry.startsWith(".")) continue;
			const full = join(current, entry);
			// statSync (not a Dirent type) so symlinked dirs and files resolve.
			let isDirectory = false;
			let isFile = false;
			try {
				const st = statSync(full);
				isDirectory = st.isDirectory();
				isFile = st.isFile();
			} catch {
				continue;
			}
			if (isDirectory) walk(full, depth + 1);
			else if (isFile && extname(entry).toLowerCase() === ".md") out.push(full);
		}
	};

	walk(dir, 0);
	return out;
}

/**
 * Minimal YAML frontmatter reader: returns the scalar keys of a leading
 * `---`-delimited block. Values keep everything after the first `:` with
 * surrounding quotes stripped. Multi-line/structured YAML is ignored by design.
 */
function parseFrontmatter(source: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!source.startsWith("---")) return out;
	const end = source.indexOf("\n---", 3);
	if (end === -1) return out;
	const block = source.slice(source.indexOf("\n", 3) + 1, end);

	for (const rawLine of block.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		if (/^\s/.test(line)) continue; // nested/continuation line — out of scope
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
			(value.startsWith("'") && value.endsWith("'") && value.length >= 2)
		) {
			value = value.slice(1, -1);
		}
		if (key) out[key] = value;
	}
	return out;
}

/**
 * List `pi-subagents` agent definitions for the given workspace + agent dir.
 * Read-only; never throws. Deduplicated by name, first root wins.
 */
export function discoverPiSubagentsAgents(cwd: string, agentDir: string): PiSubagentsAgent[] {
	const byName = new Map<string, PiSubagentsAgent>();

	for (const { dir, source } of scanRoots(cwd, agentDir)) {
		if (!isDir(dir)) continue;
		for (const file of collectMarkdown(dir)) {
			if (basename(file).toLowerCase() === "readme.md") continue;
			let source_text: string;
			try {
				source_text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			const fm = parseFrontmatter(source_text);
			const name = (fm.name || basename(file, extname(file))).trim();
			if (!name || byName.has(name)) continue;
			byName.set(name, {
				name,
				description: (fm.description ?? "").trim(),
				model: (fm.model ?? "").trim(),
				source,
				path: file,
			});
		}
	}

	return [...byName.values()].sort((a, b) =>
		a.source === b.source ? a.name.localeCompare(b.name) : a.source === "workspace" ? -1 : 1,
	);
}
