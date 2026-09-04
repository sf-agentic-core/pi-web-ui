import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverGitRepos } from "../../server/git-discovery.js";

describe("Git Repo Discovery", () => {
	let tempDir: string;

	beforeAll(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "pi-web-ui-test-"));
	});

	afterAll(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("should find no repos when none exist", async () => {
		const repos = await discoverGitRepos(tempDir);
		expect(repos).toEqual([]);
	});

	it("should find a git repo at root", async () => {
		const rootGit = join(tempDir, ".git");
		await mkdir(rootGit, { recursive: true });

		const repos = await discoverGitRepos(tempDir);
		expect(repos).toEqual([""]);

		// Clean up root .git for next tests
		await rm(rootGit, { recursive: true, force: true });
	});

	it("should discover depth 1 and depth 2 repos but not recurse into depth 1 repos", async () => {
		// Structure:
		// tempDir/
		//   repo1/ (.git) -> depth 1 repo
		//     nested/ (.git) -> inside repo1, should NOT be scanned/returned
		//   folder1/ (not a repo)
		//     repo2/ (.git) -> depth 2 repo
		//     folder2/ (not a repo)
		//       repo3/ (.git) -> depth 3, should NOT be discovered

		const pRepo1 = join(tempDir, "repo1");
		const pNested = join(pRepo1, "nested");
		const pFolder1 = join(tempDir, "folder1");
		const pRepo2 = join(pFolder1, "repo2");
		const pFolder2 = join(pFolder1, "folder2");
		const pRepo3 = join(pFolder2, "repo3");

		await mkdir(join(pRepo1, ".git"), { recursive: true });
		await mkdir(join(pNested, ".git"), { recursive: true });
		await mkdir(join(pRepo2, ".git"), { recursive: true });
		await mkdir(join(pRepo3, ".git"), { recursive: true });

		const repos = await discoverGitRepos(tempDir);

		// Should find "repo1" (depth 1) and "folder1/repo2" (depth 2)
		// Should NOT find "repo1/nested" (because repo1 is a git repo, so we skipped nested)
		// Should NOT find "folder1/folder2/repo3" (because it is at depth 3)
		expect(repos).toContain("repo1");
		expect(repos).toContain("folder1/repo2");
		expect(repos).not.toContain("repo1/nested");
		expect(repos).not.toContain("folder1/folder2/repo3");
		expect(repos.length).toBe(2);
	});
});
