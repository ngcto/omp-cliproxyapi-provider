import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { fetchCatalog, loadConfig, resolveEndpoints, resolveSettings, saveConfig, toModelConfig } from "../src/catalog.ts";
import { createExtension } from "../src/index.ts";

describe("resolveEndpoints", () => {
	it.each([
		["http://127.0.0.1:8317", "http://127.0.0.1:8317/backend-api/"],
		["http://127.0.0.1:8317/backend-api", "http://127.0.0.1:8317/backend-api/"],
		["http://127.0.0.1:8317/v1", "http://127.0.0.1:8317/backend-api/"],
		["127.0.0.1:8317", "http://127.0.0.1:8317/backend-api/"],
		["https://h.example/proxy/v1", "https://h.example/proxy/backend-api/"],
	])("%s -> inference %s", (input, inference) => {
		const endpoints = resolveEndpoints(input);
		expect(endpoints.inferenceBaseUrl).toBe(inference);
		expect(endpoints.modelsUrl).toEndWith("/v1/models?client_version=pi");
	});

	it("rejects empty input", () => {
		expect(() => resolveEndpoints("  ")).toThrow();
	});
});

describe("toModelConfig", () => {
	it("maps reasoning efforts, modalities and limits", () => {
		const model = toModelConfig({
			slug: "gpt-x",
			display_name: "GPT X",
			context_window: 272000,
			input_modalities: ["text", "image"],
			supported_reasoning_levels: [{ effort: "none" }, { effort: "low" }, { effort: "xhigh" }],
		});
		expect(model).toMatchObject({
			id: "gpt-x",
			name: "GPT X",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 272000,
			thinking: { mode: "effort", efforts: ["low", "xhigh"] },
		});
	});

	it("does not advertise reasoning when no catalog effort maps to an omp effort", () => {
		for (const levels of [[{ effort: "none" }], [{ effort: "ultra" }], [{ effort: "none" }, { effort: "ultra" }]]) {
			const model = toModelConfig({ slug: "m", supported_reasoning_levels: levels });
			expect(model?.reasoning).toBe(false);
			expect(model).not.toHaveProperty("thinking");
		}
	});

	it("skips hidden and id-less entries; non-reasoning models carry no thinking config", () => {
		expect(toModelConfig({ slug: "a", visibility: "hide" })).toBeNull();
		expect(toModelConfig({})).toBeNull();
		const plain = toModelConfig({ slug: "plain", supported_reasoning_levels: [{ effort: "none" }] });
		expect(plain?.reasoning).toBe(false);
		expect(plain).not.toHaveProperty("thinking");
	});
});

describe("config", () => {
	it("env overrides file, file overrides defaults, saveConfig merges", () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			saveConfig(dir, { baseUrl: "file:1", apiKey: "k" });
			saveConfig(dir, { baseUrl: "file:2" });
			expect(JSON.parse(readFileSync(join(dir, "cliproxyapi.json"), "utf8"))).toEqual({ baseUrl: "file:2", apiKey: "k" });
			expect(resolveSettings(dir, {})).toMatchObject({ baseUrl: "file:2", apiKey: "k", providerId: "cliproxyapi" });
			expect(resolveSettings(dir, { CLIPROXYAPI_BASE_URL: "env:3" }).baseUrl).toBe("env:3");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("config robustness", () => {
	it("a corrupt cliproxyapi.json reads as empty and is repaired by saveConfig (0600, no temp file left)", () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			writeFileSync(join(dir, "cliproxyapi.json"), '{"baseUrl": "ht');
			expect(loadConfig(dir)).toEqual({});
			saveConfig(dir, { baseUrl: "h:1" });
			expect(loadConfig(dir)).toEqual({ baseUrl: "h:1" });
			expect(statSync(join(dir, "cliproxyapi.json")).mode & 0o777).toBe(0o600);
			expect(readdirSync(dir)).toEqual(["cliproxyapi.json"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saveConfig tightens an existing world-readable file to 0600", () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			writeFileSync(join(dir, "cliproxyapi.json"), "{}", { mode: 0o644 });
			saveConfig(dir, { baseUrl: "h:1" });
			expect(statSync(join(dir, "cliproxyapi.json")).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("against a mock CLIProxyAPI", () => {
	let server: ReturnType<typeof Bun.serve>;
	let origin: string;
	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				const auth = req.headers.get("authorization");
				if (auth === "Bearer portal" || new URL(req.url).pathname === "/portal") return new Response("<html>login</html>");
				if (auth !== "Bearer good") return new Response("no", { status: 401 });
				return Response.json({ models: [{ slug: "m1" }] });
			},
		});
		origin = `http://127.0.0.1:${server.port}`;
	});
	afterAll(() => server.stop(true));

	it("fetchCatalog accepts a catalog and rejects 401", async () => {
		expect(await fetchCatalog(`${origin}/v1/models`, "good")).toHaveLength(1);
		await expect(fetchCatalog(`${origin}/v1/models`, "bad")).rejects.toThrow("401");
	});

	it("a 2xx non-catalog body throws for discovery (so omp keeps its cache) but passes login validation", async () => {
		await expect(fetchCatalog(`${origin}/portal`, "good")).rejects.toThrow("not a recognizable catalog");
		expect(await fetchCatalog(`${origin}/portal`, "good", { lenient: true })).toEqual([]);
	});

	function load(dir: string, env: NodeJS.ProcessEnv = {}) {
		const registrations: ProviderConfig[] = [];
		const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
		createExtension(
			{
				registerProvider: (_name: string, config: ProviderConfig) => registrations.push(config),
				registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
					commands[name] = def.handler;
				},
			} as unknown as ExtensionAPI,
			dir,
			env,
		);
		return { registrations, commands };
	}
	const prompts = (answers: string[], progress: string[] = []) =>
		({
			onAuth: () => {},
			onProgress: (message: string) => progress.push(message),
			onPrompt: async () => answers.shift() ?? "",
		}) as never;

	it("/login re-prompts after a failed validation, persists only baseUrl, and re-registers the provider at the new host", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			const { registrations } = load(dir);
			expect(registrations[0]?.baseUrl).toBe("http://127.0.0.1:8317/backend-api/");
			const progress: string[] = [];
			const credentials = await registrations[0]!.oauth!.login(prompts([origin, "bad", origin, "good"], progress));
			expect(progress.some((message) => message.includes("Login validation failed"))).toBe(true);
			// Constant identity: omp replaces the stored credential instead of adding a row per login.
			expect(credentials).toMatchObject({ access: "good", refresh: origin, accountId: "cliproxyapi" });
			const saved = readFileSync(join(dir, "cliproxyapi.json"), "utf8");
			expect(saved).toContain(origin);
			expect(saved).not.toContain("good");
			// omp pins the provider-level baseUrl, so inference moves only if the provider is re-registered.
			expect(registrations).toHaveLength(2);
			expect(registrations[1]?.baseUrl).toBe(`${origin}/backend-api/`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a garbage baseUrl or corrupt config still registers the provider so /login can repair it", () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			writeFileSync(join(dir, "cliproxyapi.json"), "{broken");
			const { registrations } = load(dir, { CLIPROXYAPI_BASE_URL: "http://[bad" });
			expect(registrations).toHaveLength(1);
			expect(registrations[0]?.baseUrl).toBe("http://127.0.0.1:8317/backend-api/");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fetchDynamicModels maps the catalog and fails (not empties) on an unrecognizable response", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			const { registrations } = load(dir, { CLIPROXYAPI_BASE_URL: origin });
			const discover = registrations[0]!.fetchDynamicModels!;
			expect((await discover("good")).map((m) => m.id)).toEqual(["m1"]);
			expect(await discover(undefined)).toEqual([]);
			await expect(discover("portal")).rejects.toThrow("not a recognizable catalog");
			await expect(discover("bad")).rejects.toThrow("401");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("/cliproxyapi-refresh reports when omp fell back to the cached catalog", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cpa-"));
		try {
			const { commands } = load(dir);
			const notes: Array<[string, string]> = [];
			const ctx = (state: unknown) => ({
				ui: { notify: (message: string, level: string) => notes.push([level, message]) },
				modelRegistry: {
					refreshProvider: async () => {},
					getProviderDiscoveryState: () => state,
					getAll: () => [{ provider: "cliproxyapi" }, { provider: "cliproxyapi" }, { provider: "other" }],
				},
			});
			await commands["cliproxyapi-refresh"]!("", ctx({ stale: true, status: "cached", error: "401", models: ["a", "b"] }));
			await commands["cliproxyapi-refresh"]!("", ctx({ stale: false, status: "ok", models: ["a", "b"] }));
			expect(notes[0]?.[0]).toBe("warning");
			expect(notes[0]?.[1]).toContain("keeping 2 cached");
			expect(notes[1]).toEqual(["info", "Refreshed 2 CLIProxyAPI models."]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
