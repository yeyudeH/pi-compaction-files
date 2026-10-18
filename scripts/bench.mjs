/**
 * Benchmark this extension against your own session. Read-only.
 *
 *   PI_TEST_SESSION=~/.pi/agent/sessions/<dir>/<session>.jsonl node scripts/bench.mjs
 *
 * Sections:
 *   1  what Pi's native compactions cost in your session, and the fitted growth
 *   2  what this extension leaves in context
 *   3  how many paths each side keeps
 *   4  sensitive-shaped paths sitting in your archived details
 *   5  this extension's own per-turn cost on your data
 *   6  projection with your measured parameters
 *   7  false-positive check on narrative tag mentions
 */
import { createJiti } from "jiti";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const SESS = process.env.PI_TEST_SESSION;
if (!SESS || !existsSync(SESS)) {
	console.log("用法: PI_TEST_SESSION=~/.pi/agent/sessions/<dir>/<session>.jsonl node scripts/bench.mjs");
	console.log("（脚本只读，不会写会话文件）");
	process.exit(1);
}

const jiti = createJiti(import.meta.url, { fsTimeout: 8000 });
const fl = await jiti.import(join(pkg, "extensions", "filelist.ts"));

let CFG = { ...fl.DEFAULT_OPTIONS };
try {
	const home = process.env.HOME || "";
	CFG = { ...CFG, ...JSON.parse(readFileSync(join(home, ".pi", "pi-compaction-files.json"), "utf8")) };
} catch {
	/* defaults */
}

const CWD = process.cwd();
const entries = [];
for (const line of readFileSync(SESS, "utf8").split("\n")) {
	if (!line.includes('"compaction"')) continue;
	try {
		const d = JSON.parse(line);
		if (d.type === "compaction") entries.push(d);
	} catch {
		/* skip */
	}
}
entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

const tok = (n) => Math.ceil((typeof n === "string" ? n.length : n) / 4);
const pad = (s, n) => String(s).padStart(n);

console.log(`\n会话: ${SESS}`);
console.log(`compaction 条目 ${entries.length}   配置 style=${CFG.style} keepModified=${CFG.keepModified} keepRead=${CFG.keepRead}`);

if (!entries.length) {
	console.log("\n这个会话还没有压缩记录。用一段时间（或 /compact 一次）再跑。");
	process.exit(0);
}

console.log("\n【1】Pi 原生条目实际进上下文的清单");
const native = [];
for (const e of entries) {
	if (e.fromHook === true) continue;
	const s = e.summary || "";
	native.push({ t: String(e.timestamp).slice(0, 16), total: s.length, block: s.length - fl.extractFileLists(s).text.length });
}
if (native.length >= 2) {
	const max = native.reduce((a, b) => (b.block > a.block ? b : a));
	const step = (native[native.length - 1].block - native[0].block) / (native.length - 1);
	console.log(`  条目 ${native.length} 个   最小 ${native[0].block} B   最大 ${max.block} B（${max.t}，占 ${(100 * max.block / max.total).toFixed(1)}%，≈${tok(max.block)} token）`);
	console.log(`  拟合增长 ${step >= 0 ? "+" : ""}${step.toFixed(0)} B / 次压缩`);
} else {
	console.log(`  原生条目不足（${native.length}），无法拟合增长`);
}

console.log("\n【2】本扩展产出的条目");
const hooked = entries.filter((e) => e.fromHook === true);
console.log("  时间              输入      处理后    清单条数  完整块数");
for (const e of hooked.slice(-6)) {
	const s = e.summary || "";
	const out = fl.rewriteSummary(s, CFG, CWD);
	const r = fl.extractFileLists(out.summary);
	console.log(`  ${String(e.timestamp).slice(0, 16)}  ${pad(s.length, 7)}  ${pad(out.summary.length, 9)}  ${pad(r.read.length + r.modified.length, 8)}  ${pad(r.blocks, 9)}`);
}
if (!hooked.length) console.log("  （还没有由本扩展产出的压缩条目 — 重启 Pi 并等一次压缩）");

console.log("\n【3】上下文里实际保留的路径");
const last = entries[entries.length - 1];
const raw = fl.extractFileLists(last.summary || "");
const after = fl.rewriteSummary(last.summary || "", CFG, CWD);
const kept = fl.extractFileLists(after.summary);
console.log(`  输入里出现的真实路径（含被抄块）: ${new Set([...raw.read, ...raw.modified]).size}`);
console.log(`  处理后上下文保留: read ${kept.read.length} + modified ${kept.modified.length}`);
console.log(`  上限: keepModified ${CFG.keepModified} + keepRead ${CFG.keepRead}`);

console.log("\n【4】会话文件 details 存档里的敏感形态路径");
let arch = 0, sens = 0;
const kinds = new Set();
for (const e of entries) {
	const d = e.details || {};
	const l = [...(d.readFiles || []), ...(d.modifiedFiles || [])];
	arch += l.length;
	for (const p of l) if ((CFG.sensitivePatterns || []).some((pat) => p.includes(pat))) {
		sens++;
		kinds.add(p);
	}
}
console.log(`  存档 ${arch} 条，敏感形态 ${sens} 条（${arch ? (100 * sens / arch).toFixed(2) : "0"}%），涉及 ${kinds.size} 种`);
console.log(`  archiveSensitive=${CFG.archiveSensitive !== true ? "false（新存档会剔掉这些）" : "true（新存档仍会写入这些）"}`);

console.log("\n【5】本扩展自身开销（你的数据）");
const bench = (fn, n) => {
	const t0 = process.hrtime.bigint();
	for (let i = 0; i < n; i++) fn();
	return Number(process.hrtime.bigint() - t0) / 1e6 / n;
};
console.log(`  冷路径（含 statSync）: ${bench(() => fl.rewriteSummary(last.summary || "", CFG, CWD), 20).toFixed(2)} ms/次`);
console.log(`  热路径（只做签名）:   ${bench(() => { const s = last.summary || ""; return `${s.length}:${s.slice(0, 64)}:${s.slice(-64)}`; }, 2000).toFixed(4)} ms/次`);

console.log("\n【6】推演（按你这份会话实测到的参数）");
if (native.length >= 2) {
	const step = (native[native.length - 1].block - native[0].block) / (native.length - 1);
	const nowBlock = (last.summary || "").length - fl.extractFileLists(after.summary).text.length;
	console.log(`  +N 次压缩        Pi 原生                本扩展（恒定）`);
	for (const N of [5, 10, 20, 40]) {
		const nat = Math.max(0, native[native.length - 1].block) + step * N;
		console.log(`  ${pad(N, 3)}     ${pad(Math.round(nat), 8)} B (${pad(tok(nat), 5)} tok)   ${pad(nowBlock, 6)} B (${pad(tok(nowBlock), 3)} tok)`);
	}
}

console.log("\n【7】误伤检查");
let mentions = 0, blocks = 0;
for (const e of entries) {
	const s = e.summary || "";
	mentions += (s.match(/<read-files>|<modified-files>/g) || []).length;
	blocks += fl.extractFileLists(s).blocks * 2;
}
console.log(`  标签出现总次数 ${mentions}，其中属于完整块的 ${blocks}，纯提及 ${Math.max(0, mentions - blocks)}`);
let swallowed = 0;
for (const e of entries) {
	const s = e.summary || "";
	if (!s.includes("`<read-files>`") && !s.includes("`<modified-files>`")) continue;
	const out = fl.rewriteSummary(s, CFG, CWD).summary;
	if (s.includes("`<read-files>`") && !out.includes("`<read-files>`")) swallowed++;
	if (s.includes("`<modified-files>`") && !out.includes("`<modified-files>`")) swallowed++;
}
console.log(`  处理后被误吞的行内提及: ${swallowed}`);

console.log("\n【6b】当前这一轮的实际占比");
const curBlock = (last.summary || "").length - fl.extractFileLists(last.summary || "").text.length;
const afterBlock = after.summary.length - fl.extractFileLists(after.summary).text.length;
console.log(`  摘要总长 ${(last.summary || "").length} B ≈ ${tok(last.summary || "")} token`);
console.log(`  其中清单块 ${curBlock} B ≈ ${tok(curBlock)} token（${(100 * curBlock / Math.max(1, (last.summary || "").length)).toFixed(1)}%）`);
console.log(`  处理后清单块 ${afterBlock} B ≈ ${tok(afterBlock)} token（${(100 * afterBlock / Math.max(1, after.summary.length)).toFixed(1)}%）`);
