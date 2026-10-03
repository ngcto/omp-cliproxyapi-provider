# omp-cliproxyapi-provider

Native [oh-my-pi](https://omp.sh) extension that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and registers them as an omp provider. Port of [`pi-cliproxyapi-provider`](https://github.com/router-for-me/pi-cliproxyapi-provider), reduced to what omp does not already do natively.

## Install

```bash
omp plugin install github:ngcto/omp-cliproxyapi-provider
```

Pin a branch, tag or commit with `#<ref>` (e.g. `github:ngcto/omp-cliproxyapi-provider#main`). Update with `omp plugin install --force github:ngcto/omp-cliproxyapi-provider`, remove with `omp plugin uninstall omp-cliproxyapi-provider`.

From a local checkout (development): `omp plugin link /absolute/path/to/omp-cliproxyapi-provider`, or load it for one run with `omp -e /absolute/path/to/omp-cliproxyapi-provider/src/index.ts`.

## Setup

```text
/login cliproxyapi
```

Prompts for base URL (preferred form `host:port`, e.g. `http://127.0.0.1:8317`) and API key, validates against `{root}/v1/models?client_version=pi` (any 2xx counts as success, even with an empty catalog; otherwise you are re-prompted). Re-running `/login` replaces the stored credential and moves inference to the new host. The API key is stored by omp (`agent.db`); only the base URL is mirrored to `~/.omp/agent/cliproxyapi.json`.

Non-interactive: set `CLIPROXYAPI_API_KEY` / `CLIPROXYAPI_BASE_URL` (or `apiKey` / `baseUrl` in `cliproxyapi.json`, see `cliproxyapi.example.json`). A key saved by `/login` wins over the env/file key. The base URL resolves as env > `cliproxyapi.json` > default, so a stale `CLIPROXYAPI_BASE_URL` overrides a fresh `/login`. A missing, corrupt or invalid config never stops the extension from loading, so `/login` can always repair it. `CLIPROXYAPI_PROVIDER_ID` / `CLIPROXYAPI_PROVIDER_NAME` (or `providerId` / `providerName`) rename the provider (default `cliproxyapi` / `CLIProxyAPI`).

| Input base URL | Inference base | Catalog URL |
| --- | --- | --- |
| `http://127.0.0.1:8317` | `http://127.0.0.1:8317/backend-api/` | `http://127.0.0.1:8317/v1/models?client_version=pi` |
| `…/backend-api`, `…/v1`, `127.0.0.1:8317` | same | same |

## Commands

- `/cliproxyapi-refresh` — force a live catalog refresh.

Models are discovered through omp's `fetchDynamicModels`, so omp's own model cache (24 h, `models.db`, keyed by provider id only) applies. After changing the base URL or key outside `/login` (env, config file), run `/cliproxyapi-refresh`. A 2xx response that is not a catalog (e.g. a captive-portal page) is treated as a failure, so omp keeps the cached models instead of pruning them.

## Model mapping

| CLIProxyAPI | omp |
| --- | --- |
| `slug` / `id` | `id` |
| `display_name` | `name` |
| `context_window` (fallback `max_context_window`) | `contextWindow` |
| `max_tokens` / `max_output_tokens` | `maxTokens` |
| `input_modalities` | `input` (`text`, `image`) |
| `supported_reasoning_levels[].effort` | `reasoning` + `thinking.efforts` (`minimal`…`max`) |
| `visibility: "hide"` | skipped |

Pricing is left unset so omp fills it from its bundled catalog by model id (unknown ids cost zero). A model is only marked `reasoning` when at least one of its listed efforts is an omp effort (`minimal`…`max`); `none` is not mapped, so `/thinking off` omits the reasoning field and the server's default effort applies.

Known omp-side overrides the extension cannot change: omp forces a 1,000,000-token context window for the id `gpt-5.4`, and when the catalog omits `context_window` omp uses its bundled value for the id (128,000 for unknown ids).

## Deliberately not ported

omp already covers these, or the user opted out:

| Upstream feature | Status in omp |
| --- | --- |
| Footer elapsed time / TPS toast (`tps.ts`) | Not included (by request). |
| `/fast`, fast footer, Fast pricing | Native `/fast` (sends `service_tier=priority`), available for OpenAI-family model ids (e.g. `gpt-*`) only. Unlike upstream it is not limited to catalog `service_tiers`: omp's extension API cannot set `serviceTiers` on a model. |
| `/pause`, `/continue` | Native `/pause` freezes agent loops. |
| Proactive compaction, WebSocket reset after compaction | Native compaction; omp resets Codex append state after compaction. |
| Patched Codex module (plain API keys, provider ids, WebSocket retry patch, `CLIPROXYAPI_TRANSPORT`) | Not needed for auth: omp's Codex transport accepts non-JWT keys and does no provider-id gating. omp tries a WebSocket upgrade first and falls back to SSE (one failed GET per session against a server without WebSocket support); set `PI_CODEX_WEBSOCKET=0` to skip it. |
| Custom model cache + background refresh | `fetchDynamicModels` + omp's SQLite model cache. |
| `models.dev` pricing | omp bundled pricing. |
| “closed network connection” retry normalizer | Not ported: omp cannot rewrite error metadata from an extension. omp retries `stream disconnected before completion`; a bare Go `use of closed network connection` message is **not** classified retryable by omp. |

## Development

```bash
bun install
bun test
bun run typecheck
```
