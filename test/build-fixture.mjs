/**
 * Build an isolated Pi fixture: fake HOME with a mock provider, plus a session
 * file whose compaction entry carries the real file lists from this workspace.
 *
 * Run: node test/build-fixture.mjs [--root /tmp/pi-filelist-test]
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const rootIdx = process.argv.indexOf("--root");
const ROOT = rootIdx >= 0 ? process.argv[rootIdx + 1] : "/tmp/pi-filelist-test";
const SESSION_SRC =
	process.env.PI_TEST_SESSION ??
	"/home/dev/.pi/agent/sessions/<your-session-dir>/<your-session>.jsonl";
const PORT = Number(process.env.PI_TEST_PORT ?? 18300);
const CTX = Number(process.env.PI_TEST_CTX ?? 262144);
const CWD = ROOT;

rmSync(ROOT, { recursive: true, force: true });
const agentDir = join(ROOT, "home", ".pi", "agent");
mkdirSync(agentDir, { recursive: true });

// --- fake provider -----------------------------------------------------------
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify(
		{
			providers: {
				mock: {
					baseUrl: `http://127.0.0.1:${PORT}/v1`,
					api: "openai-completions",
					apiKey: "mock-key",
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						supportsStrictMode: false,
						maxTokensField: "max_tokens",
					},
					models: [
						{
							id: "mock-llm",
							name: "Mock LLM",
							reasoning: false,
							input: ["text"],
							contextWindow: CTX,
							maxTokens: 2000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		},
		null,
		2,
	),
);
writeFileSync(
	join(agentDir, "settings.json"),
	JSON.stringify(
		{
			defaultProvider: "mock",
			defaultModel: "mock-llm",
			quietStartup: true,
			compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 400 },
		},
		null,
		2,
	),
);

// --- session fixture ---------------------------------------------------------
let last = null;
for (const line of readFileSync(SESSION_SRC, "utf-8").split("\n")) {
	if (!line.includes('"compaction"')) continue;
	try {
		const d = JSON.parse(line);
		if (d.type === "compaction") last = d;
	} catch {
		/* skip */
	}
}
if (!last) throw new Error("no compaction entry found in the source session");

const ts = new Date().toISOString();
const entries = [
	{ type: "session", version: 3, id: "fixture-session", timestamp: ts, cwd: CWD },
	{
		type: "message",
		id: "a1",
		parentId: null,
		timestamp: ts,
		message: { role: "user", content: [{ type: "text", text: "fixture: earlier turn" }], timestamp: ts },
	},
	{
		type: "compaction",
		id: "c1",
		parentId: "a1",
		timestamp: ts,
		summary: last.summary,
		firstKeptEntryId: "a1",
		tokensBefore: last.tokensBefore,
		details: last.details,
		usage: last.usage,
		fromHook: false,
	},
	{
		type: "message",
		id: "u2",
		parentId: "c1",
		timestamp: ts,
		message: { role: "user", content: [{ type: "text", text: "reply with OK" }], timestamp: ts },
	},
	// Enough post-compaction history that prepareCompaction has something to cut.
	...Array.from({ length: 6 }, (_, i) => ({
		type: "message",
		id: `m${i}`,
		parentId: i === 0 ? "u2" : `m${i - 1}`,
		timestamp: ts,
		message: {
			role: i % 2 === 0 ? "user" : "assistant",
			content: [{ type: "text", text: `turn ${i}: ${"filler text ".repeat(600)}` }],
			timestamp: ts,
		},
	})),
];
const sessionFile = join(ROOT, "fixture.jsonl");
writeFileSync(sessionFile, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

console.log(
	JSON.stringify(
		{
			root: ROOT,
			agentDir,
			sessionFile,
			fixtureSummaryChars: last.summary.length,
			fixtureRead: (last.details?.readFiles ?? []).length,
			fixtureModified: (last.details?.modifiedFiles ?? []).length,
			port: PORT,
			contextWindow: CTX,
		},
		null,
		2,
	),
);
