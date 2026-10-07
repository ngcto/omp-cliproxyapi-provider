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
| `prefer_websockets` | `preferWebsockets` (explicit `false` selects SSE) |
| `visibility: "hide"` | skipped |

Pricing is left unset so omp fills it from its bundled catalog by model id (unknown ids cost zero). A model is only marked `reasoning` when at least one of its listed efforts is an omp effort (`minimal`…`max`); `none` is not mapped, so `/thinking off` omits the reasoning field and the server's default effort applies.

For Gemini models in omp's bundled Google catalog, the extension maps listed efforts to supported native `thinkingLevel` values. For example, Gemini 3.7/3.8 Flash maps `minimal` to `low`, including omp's background requests. Older Flash models that accept `minimal` keep it. This corrects proxy client catalogs that advertise unsupported levels without adding request retries.

Known omp-side overrides the extension cannot change: omp forces a 1,000,000-token context window for the id `gpt-5.4`, and when the catalog omits `context_window` omp uses its bundled value for the id (128,000 for unknown ids).

## Deliberately not ported

omp already covers these, or the user opted out:

| Upstream feature | Status in omp |
| --- | --- |
| Footer elapsed time / TPS toast (`tps.ts`) | Not included (by request). |
| `/fast`, fast footer, Fast pricing | Native `/fast` (sends `service_tier=priority`), available for OpenAI-family model ids (e.g. `gpt-*`) only. Unlike upstream it is not limited to catalog `service_tiers`: omp's extension API cannot set `serviceTiers` on a model. |
| `/pause`, `/continue` | Native `/pause` freezes agent loops. |
| Proactive compaction, WebSocket reset after compaction | Native compaction; omp resets Codex append state after compaction. |
| Patched Codex module (plain API keys, provider ids, WebSocket retry patch, `CLIPROXYAPI_TRANSPORT`) | omp accepts non-JWT keys and has native bounded reconnect/SSE fallback. The extension honors catalog `prefer_websockets`; explicit `false` prevents upgrades even with `PI_CODEX_WEBSOCKET=1`. For other models, `PI_CODEX_WEBSOCKET=0` skips WebSockets. Upstream's retry/idle-TTL patch and `CLIPROXYAPI_TRANSPORT` are not ported. |
| Custom model cache + background refresh | `fetchDynamicModels` + omp's SQLite model cache. |
| `models.dev` pricing | omp bundled pricing. |
| “closed network connection” retry normalizer | Not ported: omp cannot rewrite error metadata from an extension. omp retries `stream disconnected before completion`; a bare Go `use of closed network connection` message is **not** classified retryable by omp. |

## Streaming failures

After updating the plugin, restart omp and run `/cliproxyapi-refresh`. Existing 24-hour cached models do not gain corrected effort mappings or transport metadata until refreshed.

`OpenAI Codex SSE stream stalled while waiting for the next event` is omp's local response-progress watchdog. Keepalive comments and ping frames do not reset it. A quiet reasoning phase can trigger it while the connection is still receiving bytes. In omp 18.5.1 and 18.8.0, first-event and idle defaults are five minutes unless settings or environment variables override them. The original pi transport has no equivalent default SSE idle deadline, so its behavior is not identical.

For long quiet reasoning, use a finite larger allowance. This example sets ten minutes for OpenAI-family HTTP streams in that process:

```bash
PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS=600000 PI_OPENAI_STREAM_IDLE_TIMEOUT_MS=600000 omp
```

Explicit omp settings under `/settings` → Providers → Timeouts take precedence over these variables. Set both values to Auto (`-1`) to use environment defaults, or set the desired seconds there. `0` disables a watchdog and can leave a dead request waiting indefinitely. The extension does not change process-wide timeouts. omp's native provider registration API has no provider-only timeout hook; replacing its transport solely for this would lose native compaction and session cleanup behavior.

Respecting catalog transport preferences prevents unwanted WebSocket attempts. It does not repair a proxy that closes an active stream or omits its terminal response event. Those failures still use omp's native recovery.

## Development

```bash
bun install
bun test
bun run typecheck
```
