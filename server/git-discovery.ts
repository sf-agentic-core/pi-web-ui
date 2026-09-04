import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Scan the workspace root to discover sub-directories that are Git repositories.
 *
 * Looks at:
 * 1. The workspace root itself ("").
 * 2. Immediate children (Depth 1 folders, e.g. "core/pi-web-ui").
 * 3. Grandchildren (Depth 2 folders, e.g. "saulfernandez/foundational-bootstrap").
 *
 * Returns an array of paths relative to the workspace root.
 */
export async function discoverGitRepos(workspaceRoot: string): Promise<string[]> {
	const repos: string[] = [];
	const resolvedRoot = resolve(workspaceRoot);

	// 1. Check workspace root itself
	try {
		const st = await stat(join(resolvedRoot, ".git"));
		if (st.isDirectory()) {
			repos.push("");
		}
	} catch {
		// Not a repo at root
	}

	// 2. Scan Depth 1 & 2
	try {
		const level1 = await readdir(resolvedRoot, { withFileTypes: true });
		for (const d1 of level1) {
			if (!d1.isDirectory() || d1.name.startsWith(".") || d1.name === "node_modules") {
				continue;
			}
			const p1 = join(resolvedRoot, d1.name);

			// Is Level 1 a git repo?
			let level1IsRepo = false;
			try {
				const st = await stat(join(p1, ".git"));
				if (st.isDirectory()) {
					repos.push(d1.name);
					level1IsRepo = true;
				}
			} catch {
				// Not a repo
			}

			// If level 1 is already a repository, we don't scan its children for nesting,
			// keeping the discovery shallow and fast.
			if (level1IsRepo) {
				continue;
			}

			// Check Level 2 grandchildren
			try {
				const level2 = await readdir(p1, { withFileTypes: true });
				for (const d2 of level2) {
					if (!d2.isDirectory() || d2.name.startsWith(".") || d2.name === "node_modules") {
						continue;
					}
					const p2 = join(p1, d2.name);
					try {
						const st = await stat(join(p2, ".git"));
						if (st.isDirectory()) {
							repos.push(`${d1.name}/${d2.name}`);
						}
					} catch {
						// Not a repo
					}
				}
			} catch {
				// Best-effort
			}
		}
	} catch {
		// Best-effort
	}

	return repos;
}
