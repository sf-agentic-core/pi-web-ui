/**
 * subagents-engine.ts — global switch between the two subagent systems.
 *
 * File: <dataDir>/subagents-engine.json  →  { "engine": "pi-web-ui" | "pi-subagents" }
 *
 * Why global and not per-client
 * -----------------------------
 * This is an engine choice, not a personal preference. Two clients running
 * different engines would recreate exactly the ambiguity this removes: the AI
 * would still see both tool surfaces and have to guess. `subagent-templates.json`
 * is global for the same reason (config, not preference) while `client-state.json`
 * stays per client (UI preferences).
 *
 * Why mtime revalidation
 * ----------------------
 * `SubagentTemplatesStore` caches its parse forever, so a template written by a
 * different ClientSession is invisible to an already-open one until restart.
 * This store re-stats the file on every read, so an out-of-band change (another
 * process, a hand edit, a git checkout) is picked up immediately.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const SUBAGENT_ENGINES = ["pi-web-ui", "pi-subagents"] as const;
export type SubagentEngine = (typeof SUBAGENT_ENGINES)[number];

/** Default = today's behaviour: first-party pi-web-ui subagents. */
export const DEFAULT_SUBAGENT_ENGINE: SubagentEngine = "pi-web-ui";

/** Normalize an arbitrary value to a known engine, or null when unrecognized. */
export function normalizeSubagentEngine(value: unknown): SubagentEngine | null {
	if (typeof value !== "string") return null;
	const v = value.trim();
	return (SUBAGENT_ENGINES as readonly string[]).includes(v) ? (v as SubagentEngine) : null;
}

/** The pi extension that must be hidden when the pi-web-ui engine is active. */
export const PI_SUBAGENTS_EXTENSION_KEY = "npm:pi-subagents";

export class SubagentsEngineStore {
	private cached: SubagentEngine | null = null;
	private cachedMtimeMs = -1;

	constructor(private readonly filePath: string) {}

	/** Current engine. Revalidated against the file mtime on every call. */
	get(): SubagentEngine {
		let mtimeMs = -1;
		try {
			mtimeMs = statSync(this.filePath).mtimeMs;
		} catch {
			mtimeMs = -1; // missing or unreadable → defaults
		}
		if (this.cached !== null && mtimeMs === this.cachedMtimeMs) return this.cached;

		let engine = DEFAULT_SUBAGENT_ENGINE;
		try {
			const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as { engine?: unknown };
			engine = normalizeSubagentEngine(parsed?.engine) ?? DEFAULT_SUBAGENT_ENGINE;
		} catch {
			// Missing/corrupt file: keep the default. Not written back — the file
			// only materializes once someone actually chooses an engine.
			engine = DEFAULT_SUBAGENT_ENGINE;
		}

		this.cached = engine;
		this.cachedMtimeMs = mtimeMs;
		return engine;
	}

	/** Persist a new engine (atomic tmp + rename). Throws on failure so the
	 *  caller can surface a notice instead of silently keeping the old mode. */
	set(engine: SubagentEngine): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ engine }, null, 2) + "\n");
		renameSync(tmp, this.filePath);
		this.cached = engine;
		try {
			this.cachedMtimeMs = statSync(this.filePath).mtimeMs;
		} catch {
			this.cachedMtimeMs = -1;
		}
	}
}
