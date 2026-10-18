/**
 * Drive Pi in RPC mode against the mock provider and trigger a manual /compact,
 * so the session_before_compact hook path is exercised for real.
 *
 * Run:
 *   node test/rpc-compact-check.mjs --root /tmp/pi-filelist-c-on [--ext /home/dev/pi-compaction-files]
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const argv = process.argv;
function flag(name) {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
}
const root = flag("--root");
const ext = flag("--ext");
if (!root) throw new Error("--root required");

const args = [
	"--mode", "rpc",
	"--provider", "mock",
	"--model", "mock-llm",
	"--session", resolve(root, "fixture.jsonl"),
	"--no-extensions",
	"--no-mcp",
	"--no-skills",
	"--no-context-files",
	"--thinking", "off",
];
if (ext) args.splice(args.indexOf("--no-extensions") + 1, 0, "-e", ext);

const child = spawn("pi", args, {
	cwd: root,
	env: { ...process.env, HOME: resolve(root, "home") },
	stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
const events = [];
let done = null;
const finished = new Promise((res) => (done = res));

child.stdout.on("data", (d) => {
	buf += d.toString();
	let nl;
	while ((nl = buf.indexOf("\n")) >= 0) {
		const line = buf.slice(0, nl).trim();
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		events.push(obj);
		if (obj.type === "response" && obj.command === "compact") {
			done?.({ ok: obj.success, data: obj.data, error: obj.error });
			done = null;
		}
	}
});
child.stderr.on("data", (d) => process.stderr.write(`[pi] ${d}`));

child.stdin.write(`${JSON.stringify({ type: "compact" })}\n`);

const twice = argv.includes("--twice");
let result = await Promise.race([finished, new Promise((r) => setTimeout(() => r({ ok: false, error: "timeout" }), 120000))]);
if (twice) {
	// Second compaction: Pi will not inherit file lists from a fromHook entry, so this
	// is where the merge in the hook has to show up.
	await new Promise((r) => setTimeout(r, 1500));
	child.stdin.write(`${JSON.stringify({ type: "compact" })}\n`);
	result = await Promise.race([finished, new Promise((r) => setTimeout(() => r({ ok: false, error: "timeout2" }), 120000))]);
}
console.log(JSON.stringify({ ...result, data: result.data ? { ...result.data, summary: `${String(result.data.summary ?? "").length} chars` } : undefined }, null, 2));
child.stdin.end();
child.kill("SIGTERM");
setTimeout(() => child.kill("SIGKILL"), 1500);
process.exit(result.ok ? 0 : 1);
