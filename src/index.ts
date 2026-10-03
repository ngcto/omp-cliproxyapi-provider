/**
 * CLIProxyAPI provider for oh-my-pi.
 *
 * Registers one provider that speaks omp's native `openai-codex-responses` API
 * against `{root}/backend-api/`, discovers models from `{root}/v1/models`
 * (omp caches the result), and adds `/login` (baseUrl + API key) and
 * `/cliproxyapi-refresh`. Fast, pause, compaction, retry and elapsed/TPS
 * display are omp-native and intentionally not reimplemented.
 */

import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import {
	CREDENTIAL_TTL_MS,
	DEFAULT_BASE_URL,
	fetchCatalog,
	firstNonEmpty,
	resolveEndpoints,
	resolveSettings,
	saveConfig,
	toModelConfig,
} from "./catalog.ts";

type OAuthConfig = NonNullable<ProviderConfig["oauth"]>;

/** Constant identity so omp replaces the stored credential on re-login instead of adding a row. */
const CREDENTIAL_ACCOUNT_ID = "cliproxyapi";

export function createExtension(pi: ExtensionAPI, agentDir: string, env: NodeJS.ProcessEnv = process.env): void {
	const settings = resolveSettings(agentDir, env);
	const { providerId, providerName } = settings;
	let baseUrl = settings.baseUrl;

	const login: OAuthConfig["login"] = async (callbacks) => {
		let defaultBaseUrl = baseUrl;
		while (true) {
			callbacks.onProgress?.("Configure CLIProxyAPI. Preferred baseUrl form: host:port (e.g. http://127.0.0.1:8317).");
			const baseUrlInput =
				firstNonEmpty(
					await callbacks.onPrompt({
						message: `CLIProxyAPI base URL [${defaultBaseUrl}]:`,
						placeholder: defaultBaseUrl,
						allowEmpty: true,
					}),
					defaultBaseUrl,
				) ?? defaultBaseUrl;
			const apiKey = (
				await callbacks.onPrompt({ message: "CLIProxyAPI API key:", placeholder: "sk-...", allowEmpty: false, secret: true })
			).trim();
			try {
				if (!apiKey) throw new Error("API key cannot be empty.");
				// Any 2xx (even with an empty catalog) means the credentials work.
				await fetchCatalog(resolveEndpoints(baseUrlInput).modelsUrl, apiKey, { lenient: true });
			} catch (error) {
				callbacks.onProgress?.(
					`Login validation failed: ${error instanceof Error ? error.message : String(error)}\nPlease re-enter base URL and API key.`,
				);
				defaultBaseUrl = baseUrlInput;
				continue;
			}
			// The API key lives in omp's auth storage; only the (non-secret) baseUrl is mirrored to disk.
			saveConfig(agentDir, { baseUrl: baseUrlInput });
			baseUrl = baseUrlInput;
			// omp pins the provider-level baseUrl over per-model ones, so inference only moves to the new host once re-registered.
			register();
			return {
				access: apiKey,
				refresh: baseUrlInput,
				expires: Date.now() + CREDENTIAL_TTL_MS,
				accountId: CREDENTIAL_ACCOUNT_ID,
			};
		}
	};

	const fetchDynamicModels = async (storedKey: string | undefined): Promise<ProviderModelConfig[]> => {
		const apiKey = storedKey ?? settings.apiKey;
		if (!apiKey) return [];
		// Strict: an invalid baseUrl must fail discovery (omp keeps the cached catalog) rather than hit a default host.
		const { modelsUrl } = resolveEndpoints(baseUrl);
		const models: ProviderModelConfig[] = [];
		for (const entry of await fetchCatalog(modelsUrl, apiKey)) {
			const model = toModelConfig(entry);
			if (model) models.push(model);
		}
		return models;
	};

	function register(): void {
		let inferenceBaseUrl: string;
		try {
			inferenceBaseUrl = resolveEndpoints(baseUrl).inferenceBaseUrl;
		} catch {
			// Keep the provider (and so /login) available so a bad baseUrl can be fixed.
			inferenceBaseUrl = resolveEndpoints(DEFAULT_BASE_URL).inferenceBaseUrl;
		}
		pi.registerProvider(providerId, {
			baseUrl: inferenceBaseUrl,
			api: "openai-codex-responses",
			// Fallback only: a key saved by /login wins (omp ProviderConfig.apiKey semantics with oauth).
			...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
			oauth: {
				name: providerName,
				login,
				// API keys do not expire; keep the stored grant alive.
				refreshToken: async (credentials) => ({ ...credentials, expires: Date.now() + CREDENTIAL_TTL_MS }),
			},
			fetchDynamicModels,
		});
	}
	register();

	pi.registerCommand("cliproxyapi-refresh", {
		description: "Force refresh CLIProxyAPI models from the remote catalog.",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");
				return;
			}
			try {
				await ctx.modelRegistry.refreshProvider(providerId, "online");
				// omp swallows discovery failures and keeps serving the cached catalog; surface that.
				const state = ctx.modelRegistry.getProviderDiscoveryState(providerId);
				if (state?.stale || state?.status === "unavailable" || state?.status === "unauthenticated") {
					ctx.ui.notify(
						`Could not refresh ${providerName} models (${state.error ?? "catalog unavailable"}); keeping ${state.models.length} cached.`,
						"warning",
					);
					return;
				}
				const count = ctx.modelRegistry.getAll().filter((model) => model.provider === providerId).length;
				ctx.ui.notify(`Refreshed ${count} ${providerName} models.`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to refresh ${providerName} models: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

export default function (pi: ExtensionAPI): void {
	createExtension(pi, getAgentDir());
}
