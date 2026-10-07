/** Pure helpers: baseUrl normalization, CLIProxyAPI catalog -> omp model mapping, config file I/O. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_PROVIDER_ID = "cliproxyapi";
export const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CONFIG_FILE_NAME = "cliproxyapi.json";
export const CLIENT_VERSION = "pi";
export const MODELS_REQUEST_TIMEOUT_MS = 60_000;
/** Login credentials are API keys and never expire; reconfigure via /login. */
export const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export interface CliproxyConfig {
	baseUrl?: string;
	apiKey?: string;
	providerId?: string;
	providerName?: string;
}

export interface CodexClientModel {
	slug?: string;
	id?: string;
	display_name?: string;
	name?: string;
	context_window?: number;
	max_context_window?: number;
	max_tokens?: number;
	max_output_tokens?: number;
	input_modalities?: string[];
	supported_reasoning_levels?: Array<{ effort?: string } | string>;
	prefer_websockets?: boolean;
	visibility?: string;
}

export function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

/**
 * Normalize a user-supplied base URL (preferred: host:port) into the inference
 * base (`{root}/backend-api/`) and the catalog URL (`{root}/v1/models?client_version=pi`).
 */
export function resolveEndpoints(baseUrlInput: string): { inferenceBaseUrl: string; modelsUrl: string } {
	let raw = baseUrlInput.trim();
	if (!raw) throw new Error("baseUrl is empty");
	if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`;

	const url = new URL(raw);
	let path = url.pathname.replace(/\/+$/, "");
	if (path.endsWith("/v1")) path = `${path.slice(0, -"/v1".length)}/backend-api`;
	else if (path === "") path = "/backend-api";
	else if (!path.endsWith("/backend-api")) path = `${path}/backend-api`;

	const rootPath = path.replace(/\/backend-api$/, "");
	const modelsPath = `${rootPath}/v1/models`.replace(/\/{2,}/g, "/");
	return {
		inferenceBaseUrl: `${url.origin}${path}/`,
		modelsUrl: `${url.origin}${modelsPath}?client_version=${encodeURIComponent(CLIENT_VERSION)}`,
	};
}

/**
 * Missing, unreadable or malformed config reads as empty: a corrupt file must
 * not stop the extension from loading, otherwise `/login` could not repair it.
 */
export function loadConfig(agentDir: string): CliproxyConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE_NAME), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CliproxyConfig) : {};
	} catch {
		return {};
	}
}

/** Merge `patch` into the config file (other keys preserved). */
export function saveConfig(agentDir: string, patch: CliproxyConfig): void {
	const path = join(agentDir, CONFIG_FILE_NAME);
	mkdirSync(dirname(path), { recursive: true });
	// Temp file + rename: atomic, and the 0600 mode applies even when replacing an existing file.
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ ...loadConfig(agentDir), ...patch }, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Env overrides config file; both override defaults. */
export function resolveSettings(agentDir: string, env: NodeJS.ProcessEnv = process.env) {
	const file = loadConfig(agentDir);
	return {
		providerId: firstNonEmpty(env.CLIPROXYAPI_PROVIDER_ID, file.providerId) ?? DEFAULT_PROVIDER_ID,
		providerName: firstNonEmpty(env.CLIPROXYAPI_PROVIDER_NAME, file.providerName) ?? DEFAULT_PROVIDER_NAME,
		baseUrl: firstNonEmpty(env.CLIPROXYAPI_BASE_URL, file.baseUrl) ?? DEFAULT_BASE_URL,
		apiKey: firstNonEmpty(env.CLIPROXYAPI_API_KEY, file.apiKey),
	};
}

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Catalog entry -> omp model config, or null for hidden/unidentifiable entries. Cost is left to omp's bundled catalog. */
export function toModelConfig(model: CodexClientModel): ProviderModelConfig | null {
	const id = (model.slug ?? model.id ?? "").trim();
	if (!id) return null;
	if (String(model.visibility ?? "").toLowerCase() === "hide") return null;

	const levels = new Set<string>();
	for (const entry of model.supported_reasoning_levels ?? []) {
		const level = (typeof entry === "string" ? entry : entry?.effort ?? "").trim().toLowerCase();
		if (level) levels.add(level);
	}
	const efforts = THINKING_EFFORTS.filter((effort) => levels.has(effort));
	// Reasoning is only advertised when omp can map at least one of the catalog's efforts;
	// otherwise omp would invent a ladder the proxy never listed.
	const reasoning = efforts.length > 0;

	const input: Array<"text" | "image"> = ["text"];
	if ((model.input_modalities ?? []).some((m) => String(m).trim().toLowerCase() === "image")) input.push("image");

	const config: Record<string, unknown> = {
		id,
		name: (model.display_name ?? model.name ?? id).trim() || id,
		reasoning,
		input,
	};
	if (reasoning) {
		const thinking: NonNullable<ProviderModelConfig["thinking"]> = { mode: "effort", efforts };
		const googleModel = getBundledModel("google", id);
		// The proxy translates Gemini efforts to native thinkingLevel, not a reseller budget.
		if (googleModel?.thinking?.mode === "google-level") {
			for (const effort of efforts) {
				const wireEffort = clampThinkingLevelForModel(googleModel, effort);
				if (wireEffort && wireEffort !== effort) (thinking.effortMap ??= {})[effort] = wireEffort;
			}
		}
		config.thinking = thinking;
	}
	if (typeof model.prefer_websockets === "boolean") config.preferWebsockets = model.prefer_websockets;
	const contextWindow = positive(model.context_window) ?? positive(model.max_context_window);
	if (contextWindow) config.contextWindow = contextWindow;
	const maxTokens = positive(model.max_tokens) ?? positive(model.max_output_tokens);
	if (maxTokens) config.maxTokens = maxTokens;
	// `cost` omitted on purpose: omp fills it from its bundled catalog by model id.
	return config as unknown as ProviderModelConfig;
}

export class ModelsHttpError extends Error {
	constructor(
		readonly status: number,
		statusText: string,
		body: string,
	) {
		super(`models request failed: ${status} ${statusText}${body ? ` body=${body.slice(0, 200)}` : ""}`);
		this.name = "ModelsHttpError";
	}
}

/**
 * GET the catalog. A non-2xx response throws. A 2xx body that is not a recognizable
 * catalog (HTML from a captive portal, unexpected JSON) throws unless `lenient`
 * (login validation accepts any 2xx); discovery must not treat it as "no models",
 * because omp would then prune the cached catalog.
 */
export async function fetchCatalog(
	modelsUrl: string,
	apiKey: string,
	{ lenient = false, timeoutMs = MODELS_REQUEST_TIMEOUT_MS }: { lenient?: boolean; timeoutMs?: number } = {},
): Promise<CodexClientModel[]> {
	const response = await fetch(modelsUrl, {
		headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new ModelsHttpError(response.status, response.statusText, await response.text().catch(() => ""));
	}
	const payload: unknown = await response.json().catch(() => undefined);
	if (Array.isArray(payload)) return payload as CodexClientModel[];
	const obj = payload as { models?: unknown; data?: unknown } | null | undefined;
	if (Array.isArray(obj?.models)) return obj.models as CodexClientModel[];
	if (Array.isArray(obj?.data)) return obj.data as CodexClientModel[];
	if (lenient) return [];
	throw new Error(`models response from ${modelsUrl} is not a recognizable catalog`);
}
