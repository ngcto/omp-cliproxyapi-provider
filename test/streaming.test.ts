import { describe, expect, it } from "bun:test";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { streamSimple, type Context } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { toModelConfig } from "../src/catalog.ts";

const context: Context = { messages: [{ role: "user", content: "Say ok.", timestamp: 0 }] };
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function completion(id: string): Response {
	const item = {
		id: `msg_${id}`,
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "ok", annotations: [] }],
	};
	const events = [
		{ type: "response.created", response: { id: `resp_${id}`, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{
			type: "response.content_part.added",
			item_id: item.id,
			output_index: 0,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item },
		{
			type: "response.completed",
			response: {
				id: `resp_${id}`,
				status: "completed",
				output: [item],
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
			},
		},
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "Content-Type": "text/event-stream" },
	});
}

describe("native CLIProxyAPI requests", () => {
	it.each([
		["gemini-3.8-flash", "low"],
		["gemini-3.5-flash", "minimal"],
		["unknown-model", "minimal"],
	])("uses a supported wire effort for %s", async (id, expectedEffort) => {
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const body: unknown = await request.json();
				const reasoning: unknown = body && typeof body === "object" ? Reflect.get(body, "reasoning") : undefined;
				if (!reasoning || typeof reasoning !== "object" || Reflect.get(reasoning, "effort") !== expectedEffort) {
					return Response.json({ error: { message: "Unsupported thinking level" } }, { status: 400 });
				}
				return completion(id);
			},
		});
		try {
			const config = toModelConfig({ slug: id, supported_reasoning_levels: ["minimal", "low", "medium", "high"] });
			if (!config) throw new Error("Missing model");
			const model = buildModel({
				...config,
				provider: "cliproxyapi",
				api: "openai-codex-responses",
				baseUrl: `http://127.0.0.1:${server.port}/backend-api/`,
				cost,
				contextWindow: 128000,
				maxTokens: 4096,
			});
			const result = await streamSimple(model, context, {
				apiKey: "loopback-only",
				reasoning: THINKING_EFFORTS.find((effort) => effort === "minimal"),
				preferWebsockets: false,
				codexSseMaxAttempts: 1,
				signal: AbortSignal.timeout(2000),
			}).result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "ok" }));
		} finally {
			server.stop(true);
		}
	});

	it("keeps catalog-disabled WebSockets on SSE across native conversation turns", async () => {
		let upgrades = 0;
		const bodies: unknown[] = [];
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
					upgrades++;
					return new Response("WebSockets disabled by catalog", { status: 400 });
				}
				bodies.push(await request.json());
				return completion(`turn_${bodies.length}`);
			},
		});
		try {
			const config = toModelConfig({ slug: "gpt-test", prefer_websockets: false });
			if (!config) throw new Error("Missing model");
			const spec = {
				...config,
				provider: "cliproxyapi",
				api: "openai-codex-responses",
				baseUrl: `http://127.0.0.1:${server.port}/backend-api/`,
				cost,
				contextWindow: 128000,
				maxTokens: 4096,
			};
			const child = Bun.spawn(
				[process.execPath, "--eval", `
					import { streamSimple } from "@oh-my-pi/pi-ai";
					import { buildModel } from "@oh-my-pi/pi-catalog/build";
					const model = buildModel(${JSON.stringify(spec)});
					const context = ${JSON.stringify(context)};
					const state = new Map();
					try {
						for (let turn = 0; turn < 2; turn++) {
							const message = await streamSimple(model, context, {
								apiKey: "loopback-only", sessionId: "catalog-disabled-ws",
								providerSessionState: state, preferWebsockets: true,
								codexSseMaxAttempts: 1, signal: AbortSignal.timeout(2000),
							}).result();
							if (message.stopReason !== "stop" || message.api !== "openai-codex-responses") {
								throw new Error(JSON.stringify(message));
							}
							context.messages.push(message, { role: "user", content: "Again.", timestamp: turn + 1 });
						}
					} finally {
						for (const session of state.values()) session.close();
					}
				`],
				{
					cwd: dirname(dirname(fileURLToPath(import.meta.url))),
					env: { ...process.env, PI_CODEX_WEBSOCKET: "1" },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const stderr = await new Response(child.stderr).text();
			expect(await child.exited, stderr).toBe(0);
			expect(upgrades).toBe(0);
			expect(bodies).toHaveLength(2);
			for (const body of bodies) expect(body).not.toHaveProperty("previous_response_id");
			expect(bodies[1]).toMatchObject({
				input: expect.arrayContaining([
					expect.objectContaining({ role: "user", content: [{ type: "input_text", text: "Say ok." }] }),
					expect.objectContaining({ role: "assistant" }),
					expect.objectContaining({ role: "user", content: [{ type: "input_text", text: "Again." }] }),
				]),
			});
		} finally {
			server.stop(true);
		}
	});
});
