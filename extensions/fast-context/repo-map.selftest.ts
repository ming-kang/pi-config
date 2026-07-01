/**
 * Self-test for repo-map.ts — classic fallback + hotspot assembly.
 *
 *   node extensions/fast-context/repo-map.selftest.ts
 *
 * Pure: throwaway tree under the OS temp dir, no Pi / network (probe omitted).
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepoMap, type HotspotConfig } from "./repo-map.ts";

const root = mkdtempSync(join(tmpdir(), "fc-repomap-"));
const tree: Record<string, Record<string, string>> = {
	auth: {
		"handler.ts": "// authentication request handler\nexport function authenticate(req) {}\n",
		"jwt.ts": "// jwt token verification, login session\n",
	},
	generated: { "client.ts": "// generated API client\n" },
	models: { "user.ts": "// user data model\n" },
	ui: { "button.tsx": "// button component\n" },
	"work-cache": { "tmp.ts": "// local cache\n" },
	node_modules: { "junk.js": "module.exports = 1;\n" },
};
for (const [dir, files] of Object.entries(tree)) {
	mkdirSync(join(root, dir), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(root, dir, name), content);
}
writeFileSync(join(root, "README.md"), "# demo\n");
writeFileSync(join(root, ".gitignore"), "generated/\n");
mkdirSync(join(root, ".git", "info"), { recursive: true });
writeFileSync(join(root, ".git", "info", "exclude"), "work-cache/\n");

const HOTSPOT: HotspotConfig = { baseDepth: 1, topK: 2, hotspotDepth: 2, maxBytes: 120 * 1024 };

// ─── classic ─────────────────────────────────────────────────────────────────
{
	const map = await buildRepoMap(root, "/codebase", {
		mode: "classic",
		query: "anything",
		treeDepth: 3,
		excludePaths: [],
		hotspot: HOTSPOT,
	});
	assert.equal(map.strategy, "classic", "classic strategy");
	assert.equal(map.depth, 3, "classic depth honored");
	assert.deepEqual(map.hotDirs, [], "classic has no hotDirs");
	assert.ok(map.tree.includes("auth") && map.tree.includes("models"), "classic shows dirs");
	assert.ok(map.tree.includes("handler.ts"), "classic depth 3 shows nested files");
	assert.ok(!map.tree.includes("node_modules"), "classic hides node_modules");
	assert.ok(!map.tree.includes("generated"), "classic hides simple .gitignore dirs");
	assert.ok(!map.tree.includes("work-cache"), "classic hides simple .git/info/exclude dirs");
}

// ─── hotspot ─────────────────────────────────────────────────────────────────
{
	const map = await buildRepoMap(root, "/codebase", {
		mode: "hotspot",
		query: "where is authentication, jwt verification and login session handled",
		treeDepth: 0,
		excludePaths: [],
		hotspot: HOTSPOT,
	});
	assert.equal(map.strategy, "hotspot", "hotspot strategy");
	assert.equal(map.depth, 1, "hotspot base tree is shallow");
	assert.ok(map.hotDirs.includes("auth"), "auth selected as hotspot");
	assert.ok(map.tree.includes("# Hotspot Subtrees"), "hotspot section present");
	assert.ok(map.tree.includes("handler.ts"), "hotspot subtree drills into auth files");
	assert.ok(!map.tree.includes("node_modules"), "hotspot hides node_modules");
	assert.ok(!map.tree.includes("generated"), "hotspot hides simple .gitignore dirs");
	assert.ok(!map.tree.includes("work-cache"), "hotspot hides simple .git/info/exclude dirs");
}

// ─── hotspot under a tiny byte budget collapses to the base tree ─────────────
{
	const map = await buildRepoMap(root, "/codebase", {
		mode: "hotspot",
		query: "authentication jwt",
		treeDepth: 0,
		excludePaths: [],
		hotspot: { ...HOTSPOT, maxBytes: 40 },
	});
	assert.ok(!map.tree.includes("# Hotspot Subtrees"), "tiny budget drops hotspot subtrees");
}

console.log("OK repo-map self-test passed");
