/**
 * Offline harness for pi-compaction-files — no pi, no model, no network.
 *
 * Covers the pure logic in extensions/filelist.ts:
 *   block extraction, relative/absolute dedupe, dead-path drop, exclude patterns,
 *   sensitive-path hiding, recency cap, idempotency, and a run against the real
 *   compaction entry currently stored in this workspace's session file.
 *
 * Run:
 *   cd <pkg> && ln -sfn ~/.pi/agent/npm/node_modules/jiti node_modules/jiti && node test/harness.mjs
 */
import { createJiti } from "jiti";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = process.env.PLUGIN_PKG ? fileURLToPath(new URL("file://"+process.env.PLUGIN_PKG)) : join(here, "..");
const jiti = createJiti(import.meta.url);
const fl = await jiti.import(join(pkg, "extensions", "filelist.ts"));

const {
	DEFAULT_OPTIONS,
	emptyStats,
	extractFileLists,
	hasFileBlocks,
	normalizePath,
	piTokens,
	renderIndex,
	rewriteSummary,
} = fl;

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`  ok   ${name}`);
	} else {
		fail++;
		console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}
function eq(name, a, b) {
	ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}

/** Deterministic fake filesystem. */
function fakeFs({ existing, mtimes } = {}) {
	const ex = existing instanceof Set ? existing : new Set(existing ?? []);
	const mt = mtimes ?? {};
	return {
		exists: (p) => ex.has(p),
		mtimeMs: (p) => (p in mt ? mt[p] : null),
	};
}

const CWD = "/home/dev/project";

// ---------------------------------------------------------------- extraction
console.log("\n[1] 提取 Pi 的两个清单块");
const sample = [
	"## Goal\n- keep the server running",
	"",
	"<read-files>",
	"/etc/nginx/nginx.conf",
	"/tmp/junk.py",
	"AGENTS.md",
	"</read-files>",
	"",
	"<modified-files>",
	"/home/dev/project/AGENTS.md",
	"/home/dev/project/app.ts",
	"</modified-files>",
].join("\n");

ok("hasFileBlocks 命中", hasFileBlocks(sample));
const ex = extractFileLists(sample);
eq("read 条数", ex.read.length, 3);
eq("modified 条数", ex.modified.length, 2);
ok("正文里已无 read-files", !ex.text.includes("<read-files>"));
ok("正文里已无 modified-files", !ex.text.includes("<modified-files>"));
ok("正文保留", ex.text.includes("keep the server running"));
eq("相对路径归一化", normalizePath("AGENTS.md", CWD), "/home/dev/project/AGENTS.md");
eq("绝对路径不变", normalizePath("/etc/nginx/nginx.conf", CWD), "/etc/nginx/nginx.conf");

// ------------------------------------------------------------------ filters
console.log("\n[2] 过滤规则");
const all = new Set([
	"/etc/nginx/nginx.conf",
	"/home/dev/project/AGENTS.md",
	"/home/dev/project/app.ts",
	"/tmp/junk.py",
	"/dev/shm/probe.mjs",
	"/home/dev/project/x/node_modules/y/index.js",
	"/home/dev/.config/svc/svc-api.key",
	"/home/dev/project/private/登录.png",
]);
const mt = {
	"/etc/nginx/nginx.conf": 1000,
	"/home/dev/project/AGENTS.md": 5000,
	"/home/dev/project/app.ts": 3000,
};
const fs1 = fakeFs({ existing: all, mtimes: mt });
const opts = { ...DEFAULT_OPTIONS, sensitivePatterns: [...DEFAULT_OPTIONS.sensitivePatterns, "/private/"] };
const st = emptyStats();
const kept = fl.filterList(
	[
		"/etc/nginx/nginx.conf",
		"/tmp/junk.py",
		"/dev/shm/probe.mjs",
		"/home/dev/project/x/node_modules/y/index.js",
		"/home/dev/.config/svc/svc-api.key",
		"/home/dev/project/private/登录.png",
		"/home/dev/project/gone.ts",
		"/etc/nginx/nginx.conf",
	],
	"modified",
	opts,
	CWD,
	fs1,
	st,
);
eq("重复被去掉", st.droppedDuplicate, 1);
eq("临时/依赖被排除", st.droppedExcluded, 3);
eq("不存在被去掉", st.droppedMissing, 1);
eq("敏感路径只计数不列出", st.hiddenSensitive, 2);
ok("敏感路径确实不在结果里", !kept.some((p) => p.includes("svc-api.key") || p.includes("private")));
eq("剩下的都是可见且存在的", kept.length, 1);
eq("内容", kept[0], "/etc/nginx/nginx.conf");

console.log("\n[3] 数量上限 + 按 mtime 排序");
const many = Array.from({ length: 100 }, (_, i) => `/home/dev/project/f${String(i).padStart(3, "0")}.ts`);
const mtMany = Object.fromEntries(many.map((p, i) => [p, i + 1]));
const st2 = emptyStats();
const kept2 = fl.filterList(many, "modified", { ...DEFAULT_OPTIONS, keepModified: 10 }, CWD, fakeFs({ existing: new Set(many), mtimes: mtMany }), st2);
eq("上限生效", kept2.length, 10);
eq("最新的一条在里面", kept2.includes("/home/dev/project/f099.ts"), true);
ok("最旧的不在里面", !kept2.includes("/home/dev/project/f000.ts"));

console.log("\n[4] read 与 modified 的重叠只保留 modified");
const r = rewriteSummary(
	[
		"narrative",
		"<read-files>",
		"/home/dev/project/a.ts",
		"/home/dev/project/b.ts",
		"</read-files>",
		"<modified-files>",
		"/home/dev/project/a.ts",
		"</modified-files>",
	].join("\n"),
	{ ...DEFAULT_OPTIONS, style: "index" },
	CWD,
	fakeFs({ existing: new Set(["/home/dev/project/a.ts", "/home/dev/project/b.ts"]), mtimes: {} }),
);
ok("changed", r.changed);
eq("modified 保留 1", r.modified.length, 1);
eq("read 去掉重叠后 1", r.read.length, 1);
eq("重叠计数", r.stats.droppedDuplicate, 1);

console.log("\n[5] 幂等：已索引化的摘要不会被再处理");
const again = rewriteSummary(r.summary, { ...DEFAULT_OPTIONS, style: "index" }, CWD, fakeFs({ existing: new Set(["/home/dev/project/a.ts", "/home/dev/project/b.ts"]), mtimes: {} }));
eq("第二次 changed=false", again.changed, false);
eq("第二次内容不变", again.summary, r.summary);
// 路径很少时索引不划算，会退回 native；这里只要求「不劣于 native」。
const rNat = rewriteSummary(
	["narrative", "<read-files>", "/home/dev/project/a.ts", "/home/dev/project/b.ts", "</read-files>", "<modified-files>", "/home/dev/project/a.ts", "</modified-files>"].join("\n"),
	{ ...DEFAULT_OPTIONS, style: "native" },
	CWD,
	fakeFs({ existing: new Set(["/home/dev/project/a.ts", "/home/dev/project/b.ts"]), mtimes: {} }),
);
ok("路径少时 index 不劣于 native", r.summary.length <= rNat.summary.length, `index=${r.summary.length} native=${rNat.summary.length}`);

console.log("\n[5a2] 路径多时 index 必须出索引块并且更短");
const idxPaths = Array.from({ length: 40 }, (_, i) => `/home/dev/project/some/deeply/nested/source/file-${String(i).padStart(3, "0")}.ts`);
const idxFs = fakeFs({ existing: new Set(idxPaths), mtimes: {} });
const idxSummary = ["narrative", "<read-files>", ...idxPaths, "</read-files>", "<modified-files>", ...idxPaths.slice(0, 20), "</modified-files>"].join("\n");
const idxOut = rewriteSummary(idxSummary, { ...DEFAULT_OPTIONS, style: "index", indexRecent: 12 }, CWD, idxFs);
const idxNat = rewriteSummary(idxSummary, { ...DEFAULT_OPTIONS, style: "native" }, CWD, idxFs);
ok("路径多时出索引块", idxOut.summary.includes("<session_files>"));
ok("索引里带检索提示", idxOut.summary.includes("session_files"));
ok("路径多时 index 比 native 短", idxOut.summary.length < idxNat.summary.length, `index=${idxOut.summary.length} native=${idxNat.summary.length}`);
ok("索引列出条数不超 indexRecent", (() => { const m = idxOut.summary.match(/<session_files>\n([\s\S]*?)\n<\/session_files>/); return !!m && m[1].split("\n").filter((x) => x.startsWith("/")).length <= 12; })());

console.log("\n[5a] native 样式：保留 Pi 原生块，只是变短，且再跑一次不变");
const nat = rewriteSummary(
	["narrative", "<read-files>", "/home/dev/project/a.ts", "/home/dev/project/b.ts", "</read-files>", "<modified-files>", "/home/dev/project/a.ts", "</modified-files>"].join("\n"),
	{ ...DEFAULT_OPTIONS },
	CWD,
	fakeFs({ existing: new Set(["/home/dev/project/a.ts", "/home/dev/project/b.ts"]), mtimes: {} }),
);
eq("native 默认样式", DEFAULT_OPTIONS.style, "native");
ok("native 保留 <read-files>", nat.summary.includes("<read-files>"));
ok("native 保留 <modified-files>", nat.summary.includes("<modified-files>"));
ok("native 不出现 session_files", !nat.summary.includes("<session_files>"));
eq("native 重叠只留 modified", nat.read.length, 1);
const nat2 = rewriteSummary(nat.summary, { ...DEFAULT_OPTIONS }, CWD, fakeFs({ existing: new Set(["/home/dev/project/a.ts", "/home/dev/project/b.ts"]), mtimes: {} }));
eq("native 第二次 changed=false", nat2.changed, false);
eq("native 第二次内容不变", nat2.summary, nat.summary);
ok("native 块格式与 Pi 一致（\n\n<read-files>）", nat.summary.includes("\n\n<read-files>\n"));

console.log("\n[5a2] 正文里嵌入的完整块也剥掉（旧行为只取末尾，会漏）");
const tricky = [
	"正文开头有一个上一次压缩被拄进正文的旧块：",
	"<read-files>",
	"/fake/示例一.ts",
	"</read-files>",
	"（上面不是真清单，但它是成对的完整块）",
	"真清单在末尾：",
	"<read-files>",
	"/home/dev/project/real.ts",
	"</read-files>",
	"<modified-files>",
	"/home/dev/project/edited.ts",
	"</modified-files>",
].join("\n");
const tr = rewriteSummary(tricky, { ...DEFAULT_OPTIONS }, CWD, fakeFs({ existing: new Set(["/home/dev/project/real.ts", "/home/dev/project/edited.ts"]), mtimes: {} }));
eq("读到两个 read 块共 2 条", tr.stats.readTotal, 2);
eq("blocksFound 计 3 块", tr.stats.blocksFound, 3);
eq("存活进上下文的 read 只有真实那个", JSON.stringify(tr.read), JSON.stringify(["/home/dev/project/real.ts"]));
eq("modified 只 1 条", JSON.stringify(tr.modified), JSON.stringify(["/home/dev/project/edited.ts"]));
ok("嵌入块已从正文剥掉（不再残留）", !tr.summary.includes("/fake/示例一.ts"));
ok("正文文字部分保留", tr.summary.includes("真清单在末尾："));
eq("输出里 read 块 <=1", (tr.summary.match(/\n<read-files>\n/g) || []).length, 1);
eq("输出里 modified 块 <=1", (tr.summary.match(/\n<modified-files>\n/g) || []).length, 1);

console.log("\n[5b] 正文只是提到标签、没有真块时不应动它");
const mention = "笔记：Pi 会追加 `<read-files>` / `<modified-files>` 块，`<session_files>` 是建议格式。";
const mres = rewriteSummary(mention, { ...DEFAULT_OPTIONS }, CWD, fakeFs({ existing: [], mtimes: {} }));
eq("mention changed=false", mres.changed, false);
eq("mention 内容不变", mres.summary, mention);

console.log("\n[6] 索引格式");
const idx = renderIndex(["/x"], ["/y", "/z"], { ...emptyStats(), readTotal: 5, modifiedTotal: 9, keptRead: 1, keptModified: 2 });
ok("含 modified 计数", idx.includes('total="9"'));
ok("含 read 计数", idx.includes('total="5"'));
ok("含 recent_modified", idx.includes("<recent_modified>"));
ok("含 recent_read", idx.includes("<recent_read>"));
eq("piTokens 用 chars/4", piTokens("abcd"), 1);
eq("piTokens 向上取整", piTokens("abcde"), 2);

// ------------------------------------------------------- real session data
console.log("\n[7] 用本会话真实的 compaction 数据跑一遍（真实文件系统）");
const SESSION = process.env.PI_TEST_SESSION;
if (SESSION && readFileSync) {
	let last = null;
	for (const line of readFileSync(SESSION, "utf-8").split("\n")) {
		if (!line.includes('"compaction"')) continue;
		try {
			const d = JSON.parse(line);
			if (d.type === "compaction") last = d;
		} catch {
			/* skip */
		}
	}
	if (!last) {
		console.log("  (没找到 compaction 条目，跳过)");
	} else {
		const before = last.summary;
		for (const style of ["native", "index"]) {
		const out = rewriteSummary(before, { ...DEFAULT_OPTIONS, style }, CWD);
		const tag = style === "index" ? "<session_files>" : "<read-files>";
		const idxStart = out.summary.lastIndexOf(tag);
		const idxEnd = style === "index" ? out.summary.lastIndexOf("</session_files>") : out.summary.length;
		const region = idxStart >= 0 && idxEnd > idxStart ? out.summary.slice(idxStart, idxEnd) : "";
		const residual = extractFileLists(out.summary);
		// 已经洗过的会话再跑一次应该 changed=false；只有输入里确实有冗余时才要求变短。
		ok(`真实数据 blocksFound>=1 (${style})`, out.stats.blocksFound >= 1, `blocks=${out.stats.blocksFound}`);
		if (style === "native") {
			ok(`native 输出不再变长 (${style})`, out.summary.length <= before.length, `${before.length} -> ${out.summary.length}`);
			if (out.stats.blocksFound > 2) {
				ok(`有嵌入块时 native 必须洗短 (${style})`, out.summary.length < before.length, `${before.length} -> ${out.summary.length}`);
			}
		} else {
			// index 样式带计数和提示行，kept 多时比 native 块长是正常的；
			// 它只应不劣于同数据下的 native 输出。
			const natRef = rewriteSummary(before, { ...DEFAULT_OPTIONS, style: "native" }, CWD);
			ok(`index 不比 native 长过 400 字 (${style})`, out.summary.length <= natRef.summary.length + 400, `index=${out.summary.length} native=${natRef.summary.length}`);
		}
		ok(`输出里每种块最多一个 (${style})`, residual.blocks <= 2, `blocks=${residual.blocks}`);
		// 敏感项针对“真正进入上下文的路径”判，不按标签位置切文本（正文会提到标签）。
		const leaked = [...residual.read, ...residual.modified].filter((p) =>
			DEFAULT_OPTIONS.sensitivePatterns.some((pat) => p.includes(pat)),
		);
		ok(`清单里没有敏感路径 (${style})`, leaked.length === 0, JSON.stringify(leaked.slice(0, 3)));
		ok(`清单条数不超上限 (${style})`, residual.read.length + residual.modified.length <= DEFAULT_OPTIONS.keepModified + DEFAULT_OPTIONS.keepRead, `read=${residual.read.length} modified=${residual.modified.length}`);
		if (style === "index") {
			const hasIndex = idxStart >= 0;
			if (hasIndex) {
				ok("index: 真块已消失", residual.read.length === 0 && residual.modified.length === 0, `read=${residual.read.length} modified=${residual.modified.length}`);
				ok("index: 有索引块", true);
			} else {
				ok("index: 退回 native 时清单仍不超上限", residual.read.length <= DEFAULT_OPTIONS.keepRead && residual.modified.length <= DEFAULT_OPTIONS.keepModified, `read=${residual.read.length} modified=${residual.modified.length}`);
			}
		} else {
			ok("native: 块仍在且不超上限", residual.read.length <= DEFAULT_OPTIONS.keepRead && residual.modified.length <= DEFAULT_OPTIONS.keepModified, `read=${residual.read.length} modified=${residual.modified.length}`);
			// 注意：本会话正文里本来就提到过 <session_files>（我们自己写的笔记），
			// 所以只能断言「清单区」里没有，不能断言整份 summary 里没有。
			ok("native: 清单区不出现 session_files", !region.includes("<session_files>"));
			const nat2 = rewriteSummary(out.summary, { ...DEFAULT_OPTIONS }, CWD);
			ok("native: 再跑一次不再变", !nat2.changed && nat2.summary === out.summary);
		}
		ok(`正文保留（Goal 段还在）(${style})`, out.summary.includes("## Goal"));
		const saved = before.length - out.summary.length;
		const blockChars = before.length - extractFileLists(before).text.length;
		if (blockChars > 2000) {
			ok(`清单确实变小 (${style})`, out.summary.length < before.length * 0.5, `${before.length} -> ${out.summary.length}`);
		} else if (style === "native") {
			ok(`输入已很干净，不再变大 (${style})`, out.summary.length <= before.length * 1.05, `${before.length} -> ${out.summary.length}`);
		}
		ok("清单区没有 /tmp", !residual.read.concat(residual.modified).some((p) => p.includes("/tmp/")));
		ok("清单区没有 /dev/shm", !residual.read.concat(residual.modified).some((p) => p.includes("/dev/shm/")));
		ok("清单区没有凭据文件", !residual.read.concat(residual.modified).some((p) => p.includes("svc-api.key") || p.includes("/.pi/agent/settings.json")));
		ok("清单区没有私密目录", !residual.read.concat(residual.modified).some((p) => p.includes("private")));
		console.log(
			`  [${style}] read ${out.stats.readTotal}->${out.stats.keptRead}, modified ${out.stats.modifiedTotal}->${out.stats.keptModified}, ` +
				`missing -${out.stats.droppedMissing}, excluded -${out.stats.droppedExcluded}, dup -${out.stats.droppedDuplicate}, hidden ${out.stats.hiddenSensitive}`,
		);
		console.log(
			`  [${style}] 字符 ${before.length} -> ${out.summary.length}（清单区 ${blockChars} B，变化 ${saved >= 0 ? "省 " + saved : "涨 " + -saved}，Pi 估算 ${saved >= 0 ? "省 " : "涨 "}${piTokens("a".repeat(Math.abs(saved)))} token）`,
		);
		console.log(`  [${style}] 清单区预览:`);
		for (const l of region.split("\n").slice(0, 5)) console.log(`    ${l.trim().slice(0, 120)}`);
		}
	}
} else {
	console.log("  (未设 PI_TEST_SESSION，跳过真实数据用例)");
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
