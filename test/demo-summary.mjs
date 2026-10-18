/** 一次性演示：真实 summary 的构成 vs 插件处理后的构成 + session_files 的真实返回。 */
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";

const jiti = createJiti(import.meta.url);
const fl = await jiti.import("/home/dev/pi-compaction-files/extensions/filelist.ts");

const SESSION = process.env.PI_TEST_SESSION;
let last = null;
for (const l of readFileSync(SESSION, "utf-8").split("\n")) {
	if (!l.includes('"compaction"')) continue;
	try {
		const d = JSON.parse(l);
		if (d.type === "compaction") last = d;
	} catch {
		/* skip */
	}
}

const s = last.summary;
const READ_RE = /\n*<read-files>\n([\s\S]*?)\n<\/read-files>/;
const MOD_RE = /\n*<modified-files>\n([\s\S]*?)\n<\/modified-files>/;
const rm = s.match(READ_RE);
const mm = s.match(MOD_RE);
const narrative = s.replace(rm[0], "").replace(mm[0], "").replace(/\s+$/, "");

console.log("=== 原先 summary 的构成（本会话真实数据）===");
console.log(`  总长 ${s.length.toLocaleString()} 字符`);
console.log(`  正文（叙事）        ${narrative.length.toLocaleString()} 字符  (${((narrative.length / s.length) * 100).toFixed(1)}%)`);
console.log(`  <read-files> 块      ${rm[0].length.toLocaleString()} 字符  共 ${rm[1].split("\n").length} 行`);
console.log(`  <modified-files> 块  ${mm[0].length.toLocaleString()} 字符  共 ${mm[1].split("\n").length} 行`);
console.log(`  ⇒ 清单合计占 ${(((rm[0].length + mm[0].length) / s.length) * 100).toFixed(1)}%，每轮都发给模型`);

console.log("\n  正文开头 2 行:");
for (const l of narrative.split("\n").slice(0, 2)) console.log("    " + l.slice(0, 100));
console.log("\n  <read-files> 块真实开头 4 行:");
for (const l of rm[0].split("\n").slice(0, 5)) console.log("    " + l.slice(0, 100));
console.log("\n  <modified-files> 块真实开头 4 行:");
for (const l of mm[0].split("\n").slice(0, 5)) console.log("    " + l.slice(0, 100));

const out = fl.rewriteSummary(s, fl.DEFAULT_OPTIONS, "/home/dev/project");
const iIdx = out.summary.lastIndexOf("<session_files>");
const idxBlock = out.summary.slice(iIdx);
const keptNarrative = out.summary.slice(0, iIdx).replace(/\s+$/, "");

console.log("\n=== 插件处理后 summary 的构成 ===");
console.log(`  总长 ${out.summary.length.toLocaleString()} 字符（原 ${s.length.toLocaleString()}，省 ${(s.length - out.summary.length).toLocaleString()}）`);
console.log(`  正文（叙事）          ${keptNarrative.length.toLocaleString()} 字符  ← 与 Pi 原文逐字一致: ${keptNarrative === narrative}`);
console.log(`  <session_files> 索引  ${idxBlock.length.toLocaleString()} 字符`);

console.log("\n  索引块完整内容（清单被换成的全部东西）:");
const lines = idxBlock.split("\n");
for (const l of lines.slice(0, 7)) console.log("    " + l.slice(0, 140));
console.log(`    …（recent_modified 共 ${fl.DEFAULT_OPTIONS.keepModified} 行）…`);
const readStart = lines.findIndex((l) => l.includes("<recent_read>"));
for (const l of lines.slice(readStart, readStart + 4)) console.log("    " + l.slice(0, 140));
console.log("    …（recent_read 共 40 行）…");
for (const l of lines.slice(-3)) console.log("    " + l.slice(0, 140));

// ---- session_files 工具的真实返回（照搬 index.ts 里的实现）----
console.log("\n=== session_files 工具输入 → 输出（真实清单）===");
const details = last.details;
function session_files(params) {
	const kind = (params.kind ?? "all").toLowerCase();
	const pool = kind === "read" ? details.readFiles : kind === "modified" ? details.modifiedFiles : [...details.modifiedFiles, ...details.readFiles];
	const q = (params.query ?? "").toLowerCase();
	const limit = Math.min(Math.max(params.limit ?? 60, 1), 300);
	const seen = new Set();
	const outArr = [];
	for (const raw of pool) {
		const p = raw.trim();
		if (!p || seen.has(p)) continue;
		seen.add(p);
		if (q && !p.toLowerCase().includes(q)) continue;
		outArr.push(p);
		if (outArr.length >= limit) break;
	}
	const head = `清单共 read ${details.readFiles.length} 条 / modified ${details.modifiedFiles.length} 条；过滤后匹配 ${outArr.length} 条${outArr.length >= limit ? "（已截断，可加 query 收窄）" : ""}：`;
	return { text: outArr.length ? `${head}\n${outArr.join("\n")}` : `${head}\n（无匹配）`, details: { read: details.readFiles.length, modified: details.modifiedFiles.length, matched: outArr.length } };
}

for (const p of [{ query: "nginx" }, { kind: "modified", query: "gateway", limit: 5 }, { kind: "read", limit: 3 }]) {
	const r = session_files(p);
	console.log(`\n  输入: ${JSON.stringify(p)}`);
	console.log("  输出:");
	for (const l of r.text.split("\n").slice(0, 8)) console.log("    " + l.slice(0, 120));
	console.log(`  details: ${JSON.stringify(r.details)}`);
}
