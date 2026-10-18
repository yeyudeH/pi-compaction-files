/**
 * Fixture builder + mock OpenAI-compatible provider for the isolated Pi test.
 *
 * It records the exact request body Pi sends to the provider, so we can measure
 * what the compaction file lists actually cost in the outbound prompt, with and
 * without the extension. No GPU, no real model.
 *
 * Run: node test/mock-provider.mjs [--port 18300] [--out /tmp/pi-filelist-test/req.json]
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const portIdx = process.argv.indexOf("--port");
const port = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 18300;
const outIdx = process.argv.indexOf("--out");
const out = outIdx >= 0 ? process.argv[outIdx + 1] : "/tmp/pi-filelist-test/req.json";

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		let parsed;
		try {
			parsed = JSON.parse(body);
		} catch {
			parsed = { raw: body };
		}
		const record = {
			url: req.url,
			at: new Date().toISOString(),
			payloadChars: body.length,
			messages: (parsed.messages ?? []).map((m) => ({
				role: m.role,
				chars: typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length,
			})),
			max_tokens: parsed.max_tokens,
			stream: parsed.stream,
			tools: (parsed.tools ?? []).map((t) => t?.function?.name ?? "?"),
			// Keep the compaction-related text so assertions can be made on it.
			compactionMessage: (parsed.messages ?? [])
				.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
				.find((t) => t.includes("<summary>") || t.includes("<session_files>") || t.includes("<read-files>")),
		};
		writeFileSync(out, JSON.stringify(record, null, 2));
		process.stderr.write(`[mock] ${req.url} payload=${body.length} chars, messages=${record.messages.length}\n`);

		const text = "MOCK-OK";
		if (parsed.stream) {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta, finish) =>
				`data: ${JSON.stringify({ id: "mock1", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
			res.write(chunk({ role: "assistant", content: text }));
			res.write(chunk({}, "stop"));
			res.write("data: [DONE]\n\n");
			res.end();
		} else {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					id: "mock1",
					object: "chat.completion",
					model: parsed.model,
					choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
					usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
				}),
			);
		}
	});
});

server.listen(port, "127.0.0.1", () => process.stderr.write(`[mock] listening on 127.0.0.1:${port}\n`));
