/**
 * Self-test for directory-scorer.ts — tokenization + hotspot ranking.
 *
 *   node extensions/fast-context/directory-scorer.selftest.ts
 *
 * Pure: builds a throwaway directory tree under the OS temp dir, no Pi / network.
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreDirectories, splitByCase, stem, tokenize, tokenizePath } from "./directory-scorer.ts";

// ─── splitByCase ─────────────────────────────────────────────────────────────
assert.deepEqual(splitByCase("fooBar"), ["foo", "Bar"], "camelCase");
assert.deepEqual(splitByCase("FooBar"), ["Foo", "Bar"], "PascalCase");
assert.deepEqual(splitByCase("foo_bar"), ["foo", "bar"], "snake_case");
assert.deepEqual(splitByCase("foo-bar"), ["foo", "bar"], "kebab-case");
assert.deepEqual(splitByCase("getHTTPResponse"), ["get", "HTTP", "Response"], "acronym run");
assert.deepEqual(splitByCase("v2Test"), ["v", "2", "Test"], "letter/digit boundary");
assert.deepEqual(splitByCase(""), [], "empty");

// ─── stem ────────────────────────────────────────────────────────────────────
assert.equal(stem("cities"), "city", "ies → y");
assert.equal(stem("classes"), "class", "es → ''");
assert.equal(stem("ab"), "ab", "too short untouched");

// ─── tokenize / tokenizePath ─────────────────────────────────────────────────
assert.deepEqual(tokenize("the Quick brownFox"), ["quick", "brown", "fox"], "stopword drop + case split");
{
	const toks = tokenizePath("src/authHandler.ts");
	assert.ok(toks.includes("src") && toks.includes("auth") && toks.includes("handler"), "path tokens split");
}

// ─── scoreDirectories: end-to-end ranking ────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "fc-scorer-"));
const tree: Record<string, Record<string, string>> = {
	auth: {
		"handler.ts": "// authentication request handler\nexport function authenticate(req) {}\n",
		"jwt.ts": "// jwt token verification and session login\nexport function verifyJwt(t) {}\n",
		"session.ts": "// user login session management\n",
	},
	models: { "user.ts": "// user data model\nexport interface User {}\n" },
	ui: { "button.tsx": "// presentational button component\n" },
	utils: { "format.ts": "// string formatting helpers\n" },
	config: { "settings.ts": "// app configuration values\n" },
	docs: { "readme.md": "# Project docs\nGeneral overview.\n" },
};
for (const [dir, files] of Object.entries(tree)) {
	mkdirSync(join(root, dir), { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(root, dir, name), content);
}
const topDirs = Object.keys(tree);

// No probe — BM25F + file-agg + path spines only.
{
	const { hotDirs, pathSpines, signals } = await scoreDirectories(
		"where is user authentication, jwt verification and login session handled",
		root,
		topDirs,
		[],
		{ topK: 4 },
	);
	assert.ok(hotDirs.includes("auth"), "auth surfaces as a hotspot");
	assert.equal((signals.bm25f as string[])[0], "auth", "auth ranks first in BM25F");
	assert.ok(hotDirs.length >= 2 && hotDirs.length <= topDirs.length, "hotDirs within bounds");
	assert.ok(pathSpines.some((p) => p.includes("auth")), "path spines include an auth file");
	assert.ok(!("probe" in signals), "no probe signal without probeFn");
}

// With an injected probe (fake Pi grep) — probe signal participates, no crash.
{
	let probeCalls = 0;
	const probeFn = async (pattern: string): Promise<string[]> => {
		probeCalls++;
		assert.ok(pattern.length > 0, "probe receives a non-empty alternation pattern");
		return ["auth/handler.ts", "auth/jwt.ts"]; // root-relative hits
	};
	const { hotDirs, signals } = await scoreDirectories(
		"authentication jwt login",
		root,
		topDirs,
		[],
		{ topK: 4, probeFn },
	);
	assert.equal(probeCalls, 1, "probe invoked exactly once");
	assert.ok(hotDirs.includes("auth"), "auth still hot with probe");
	assert.ok(Array.isArray(signals.probe), "probe signal recorded");
}

console.log("OK directory-scorer self-test passed");
