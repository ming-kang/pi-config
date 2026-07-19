/**
 * Focused offline verification for models extension optimizations.
 * Run: bun extensions/models/opt-verify.mts
 * (Requires @earendil-works/pi-coding-agent and pi-tui resolvable via NODE_PATH or install.)
 */
import { mkdir, writeFile, utimes } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	getModelsJsonParseCountForTests,
	getProvider,
	listProviderIds,
	listProviders,
	readModelsJson,
	resetModelsJsonCacheForTests,
	resetModelsJsonParseCountForTests,
	saveProvider,
	setModelsJsonPathForTests,
	writeModelsJson,
} from "./store.ts";
import { findBestModelsDevReference, parseModelsDevCatalog } from "./models-dev.ts";
import { createDirtyFlag, editProvider } from "./editor.ts";
import { parseModelIds } from "./constants.ts";
import { readBodyBounded } from "./http.ts";

const here = dirname(fileURLToPath(import.meta.url));

async function verifyStoreCache(): Promise<void> {
	const fixtureDir = join(tmpdir(), `pi-models-opt-verify-${process.pid}-${Date.now()}`);
	const fixturePath = join(fixtureDir, "models.json");
	await mkdir(fixtureDir, { recursive: true });
	await writeFile(
		fixturePath,
		`${JSON.stringify(
			{
				providers: {
					alpha: { baseUrl: "http://localhost:1", models: [{ id: "a1" }] },
					beta: { baseUrl: "http://localhost:2", models: [{ id: "b1" }] },
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	setModelsJsonPathForTests(fixturePath);
	resetModelsJsonCacheForTests();
	resetModelsJsonParseCountForTests();

	await listProviders();
	if (getModelsJsonParseCountForTests() !== 1) throw new Error("first list should parse once");
	await listProviderIds();
	await getProvider("alpha");
	await readModelsJson();
	if (getModelsJsonParseCountForTests() !== 1) throw new Error("stable mtime must cache parse");

	const listed = (await listProviders()).map((p) => p.id);
	const ids = await listProviderIds();
	if (listed.join(",") !== ids.join(",")) throw new Error("ID list diverged from providers");

	const cloneCheck = await listProviders();
	cloneCheck[0]!.entry.baseUrl = "poison";
	if ((await getProvider("alpha"))?.baseUrl !== "http://localhost:1") {
		throw new Error("listProviders must clone entries");
	}

	await saveProvider(undefined, "gamma", { baseUrl: "http://localhost:3", models: [{ id: "g1" }] });
	if (!(await listProviderIds()).includes("gamma")) throw new Error("write not visible");
	const afterWrite = getModelsJsonParseCountForTests();
	await listProviders();
	if (getModelsJsonParseCountForTests() !== afterWrite) throw new Error("post-write cache miss");

	const external = await readModelsJson();
	external.providers.delta = { baseUrl: "http://localhost:4", models: [{ id: "d1" }] };
	await writeFile(fixturePath, `${JSON.stringify(external, null, 2)}\n`, "utf8");
	const later = new Date(Date.now() + 2_000);
	await utimes(fixturePath, later, later);
	if (!(await listProviderIds()).includes("delta")) throw new Error("mtime invalidation failed");

	await writeModelsJson({ providers: { solo: { models: [{ id: "s" }] } } });
	if ((await listProviderIds()).join(",") !== "solo") throw new Error("writeModelsJson cache");

	setModelsJsonPathForTests(undefined);
	resetModelsJsonCacheForTests();
}

async function verifyDirty(): Promise<void> {
	const flag = createDirtyFlag();
	if (flag.isDirty()) throw new Error("dirty starts clean");
	flag.mark();
	if (!flag.isDirty()) throw new Error("mark failed");
	flag.clear();
	if (flag.isDirty()) throw new Error("clear failed");

	const source = readFileSync(join(here, "editor.ts"), "utf8");
	const start = source.indexOf("export async function editProvider(");
	const end = source.indexOf("\nasync function editProviderAuthentication(");
	const body = source.slice(start, end);
	if (body.includes("jsonEqual(baseline") || !body.includes("createDirtyFlag")) {
		throw new Error("editProvider dirty path regression");
	}

	const scripted = (script: {
		select: (title: string, options: string[]) => string | undefined;
		input?: (title: string) => string | undefined;
		confirm?: () => boolean;
	}) =>
		({
			mode: "rpc",
			hasUI: true,
			ui: {
				select: async (title: string, options: string[]) => script.select(title, options),
				input: async (title: string) => script.input?.(title),
				confirm: async () => script.confirm?.() ?? true,
				notify() {},
			},
		}) as any;

	const clean = await editProvider(
		scripted({
			select: (title) => {
				if (title.startsWith("Provider · demo")) return "Back";
				throw new Error(title);
			},
			confirm: () => {
				throw new Error("clean leave must not confirm");
			},
		}),
		{
			initialId: "demo",
			initialEntry: { baseUrl: "http://localhost", api: "openai-completions" },
			existingIds: ["demo"],
			onSave: async () => {
				throw new Error("clean must not save");
			},
		},
	);
	if (clean.kind !== "closed") throw new Error("clean leave");

	let leavePrompt = 0;
	let saves = 0;
	let sawBase = false;
	const dirty = await editProvider(
		scripted({
			select: (title, options) => {
				if (title.startsWith("Provider · demo")) {
					if (!sawBase) {
						sawBase = true;
						return options.find((o) => o.includes("Base URL"));
					}
					return "Back";
				}
				if (title === "Unsaved provider changes") {
					leavePrompt++;
					return options.find((o) => o.startsWith("Save and leave"));
				}
				throw new Error(title);
			},
			input: (title) => {
				if (title.toLowerCase().includes("base url")) return "http://localhost:9999";
				throw new Error(title);
			},
		}),
		{
			initialId: "demo",
			initialEntry: { baseUrl: "http://localhost", api: "openai-completions" },
			existingIds: ["demo"],
			onSave: async (_o, _i, entry) => {
				saves++;
				if (entry.baseUrl !== "http://localhost:9999") throw new Error("bad save");
				return { ok: true };
			},
		},
	);
	if (dirty.kind !== "closed" || leavePrompt !== 1 || saves !== 1) {
		throw new Error(`dirty leave: ${JSON.stringify({ dirty, leavePrompt, saves })}`);
	}
}

function verifyModelsDev(): void {
	const catalog = parseModelsDevCatalog({
		openai: {
			id: "openai",
			name: "OpenAI",
			models: {
				"gpt-5.6-codex": {
					id: "gpt-5.6-codex",
					name: "GPT-5.6 Codex",
					limit: { context: 1_050_000, output: 128_000 },
				},
			},
		},
		onetoken: {
			id: "onetoken",
			name: "OneToken",
			api: "https://onetoken.sh/v1",
			models: {
				"gpt-5.6-codex": {
					id: "gpt-5.6-codex",
					name: "relay",
					limit: { context: 272_000, output: 128_000 },
				},
			},
		},
		noise: {
			id: "noise",
			name: "Noise",
			models: Object.fromEntries(
				Array.from({ length: 100 }, (_, i) => [
					`n-${i}`,
					{ id: `n-${i}`, limit: { context: 1000 + i, output: 100 } },
				]),
			),
		},
	});
	const exact = findBestModelsDevReference(catalog, { modelId: "gpt-5.6-codex" });
	if (exact?.match !== "exact" || exact.providerId !== "openai" || exact.contextWindow !== 1_050_000) {
		throw new Error(`exact: ${JSON.stringify(exact)}`);
	}
	const similar = findBestModelsDevReference(catalog, {
		modelId: "gateway/gpt-5.6-codex",
		providerId: "onetoken",
		baseUrl: "https://onetoken.sh/v1",
	});
	if (similar?.match !== "similar" || similar.providerId !== "onetoken") {
		throw new Error(`similar: ${JSON.stringify(similar)}`);
	}
	if (findBestModelsDevReference(catalog, { modelId: "completely-unrelated-local-model" })) {
		throw new Error("false positive match");
	}
}

async function verifyHelpers(): Promise<void> {
	if (parseModelIds("a, b\nc").join("|") !== "a|b|c") throw new Error("parseModelIds");
	const body = await readBodyBounded(new Response("hi"), 100);
	if (body !== "hi") throw new Error("readBodyBounded");

	const indexSrc = readFileSync(join(here, "index.ts"), "utf8");
	const editorSrc = readFileSync(join(here, "editor.ts"), "utf8");
	if (indexSrc.includes("function parseManualModelIds") || editorSrc.includes("function parseModelIds(")) {
		throw new Error("duplicate parsers");
	}
	if (!indexSrc.includes("commitModelsChange") || !indexSrc.includes("restoreModelsJsonSnapshot")) {
		throw new Error("rollback path missing");
	}
	if (editorSrc.includes("function formatUrlLabel") || editorSrc.includes("function selectSearchableKey")) {
		throw new Error("dead helpers remain");
	}
}

await verifyStoreCache();
await verifyDirty();
verifyModelsDev();
await verifyHelpers();
console.log("models opt-verify: ok");
