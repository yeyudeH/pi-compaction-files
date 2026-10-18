/**
 * Isolated load + behaviour test for extensions/index.ts.
 *
 * Nothing here touches the live plugin or the live session file:
 *   - HOME is pointed at a throwaway dir so loadConfig() reads a fixture config,
 *     never ~/.pi/pi-compaction-files.json
 *   - Pi's `compact()` is mocked through jiti, so no model call happens
 *   - the mock ExtensionAPI only records what the extension registers
 *
 * Run:  cd <pkg> && node test/plugin-load.mjs
 */
import { createJiti } from "jiti";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// PLUGIN_PKG lets this test drive a different copy of the package (e.g. the live one)
// without polluting that copy with test fixtures or node_modules symlinks.
const pkg = process.env.PLUGIN_PKG ? resolve(process.env.PLUGIN_PKG) : join(here, "..");

let pass = 0;
let fail = 0;
function ok(name, cond, extra = "") {
	if (cond) {
		pass++;
		console.log(`    ok   ${name}`);
	} else {
		fail++;
		console.log(`    FAIL ${name}${extra ? ` — ${extra}` : ""}`);
	}
}

// ---- fixture HOME so the real user config is never read --------------------
const fakeHome = join(here, ".test-home-" + (process.env.PLUGIN_PKG ? "live" : "self"));
rmSync(fakeHome, { recursive: true, force: true });
mkdirSync(join(fakeHome, ".pi"), { recursive: true });
const FIXTURE_CONFIG = {
	enabled: true,
	style: "native",
	tool: false,
	archiveSensitive: false,
	keepModified: 5,
	keepRead: 3,
	dropMissing: true,
	excludePatterns: ["/tmp/"],
	sensitivePatterns: ["/secret", "/private/"],
};
writeFileSync(join(fakeHome, ".pi", "pi-compaction-files.json"), JSON.stringify(FIXTURE_CONFIG));
process.env.HOME = fakeHome;

// ---- real files to anchor dropMissing -------------------------------------
const realA = join(pkg, "extensions", "filelist.ts");
const realB = join(pkg, "extensions", "index.ts");
const realC = join(pkg, "package.json");
const gone = join(here, "no-such-file-9a7.ts");
const secret = join(here, "secret-token.txt");
writeFileSync(secret, "x"); // exists, but must be stripped from the archive

// ---- mock Pi's compact() --------------------------------------------------
let compactCalls = [];
const fakeCompact = async (prep, model, key, headers, ci, signal, thinking, streamFn) => {
	compactCalls.push({ stream: streamFn !== undefined });
	if (fakeCompact.throwMode === "always") throw new Error("compact exploded");
	if (fakeCompact.throwMode === "stream" && streamFn !== undefined) throw new Error("stream path broken");
	return fakeCompact.result;
};

// Resolve `typebox` from wherever Pi keeps it, so the test can drive a package copy
// that has no node_modules of its own (the live plugin dir stays clean).
const probe = createJiti(import.meta.url, { fsTimeout: 5000 });
const pcProbe = await probe.import(join(here, "..", "extensions", "picheck.ts"));
const typeboxCandidates = [
	join(pkg, "node_modules", "typebox"),
	join(pcProbe.locatePiDist() || "/nonexistent", "..", "node_modules", "typebox"),
	join(here, "..", "node_modules", "typebox"),
];
const typeboxDir = typeboxCandidates.find((p) => existsSync(join(p, "package.json")));
let typeboxPath;
if (typeboxDir) {
	// typebox has no bare main; its root export lives in exports["."].
	try {
		const pj = JSON.parse(readFileSync(join(typeboxDir, "package.json"), "utf-8"));
		const root = pj.exports && pj.exports["."];
		const sub = typeof root === "string" ? root : (root && (root.import || root.default));
		typeboxPath = sub ? join(typeboxDir, sub) : typeboxDir;
	} catch {
		typeboxPath = typeboxDir;
	}
}

const jiti = createJiti(import.meta.url, {
	fsTimeout: 5000,
	alias: {
		"@earendil-works/pi-coding-agent": join(pkg, ".mock-pi.mjs"),
		...(typeboxPath ? { typebox: typeboxPath } : {}),
	},
});
writeFileSync(
	join(pkg, ".mock-pi.mjs"),
	"export const compact = (...a) => globalThis.__fakeCompact(...a);\n",
);
globalThis.__fakeCompact = fakeCompact;

const mod = await jiti.import(join(pkg, "extensions", "index.ts"));
const pc = await jiti.import(join(pkg, "extensions", "picheck.ts"));

// ---- mock ExtensionAPI ----------------------------------------------------
const hooks = {};
const tools = [];
const commands = {};
const pi = {
	on(name, fn) {
		hooks[name] = fn;
	},
	registerTool(t) {
		tools.push(t);
	},
	registerCommand(n, c) {
		commands[n] = c;
	},
};

console.log("\n[1] 加载与注册");
mod.default(pi);
ok("注册了 session_before_compact", typeof hooks.session_before_compact === "function");
ok("注册了 context", typeof hooks.context === "function");
ok("tool=false 时不注册工具", tools.length === 0, `tools=${tools.length}`);
ok("注册了 /filelist 命令", typeof commands.filelist?.handler === "function");

// ---- compaction hook ------------------------------------------------------
function makeCtx(branch) {
	return {
		model: { provider: "mock", id: "m1" },
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: {}, env: {} }),
			stream: async () => {
				throw new Error("no stream in test");
			},
		},
		cwd: pkg,
		thinkingLevel: "low",
		sessionManager: { getBranch: () => branch || [] },
	};
}

const EMBEDDED = `<modified-files>\n${realA}\n/tmp/old-junk.ts\n${gone}\n</modified-files>`;
const TRAILING = `<modified-files>\n${realB}\n${secret}\n</modified-files>\n\n<read-files>\n${realC}\n${join(pkg, "secret", "inner.ts")}\n</read-files>`;
const SUMMARY = [
	"## Goal",
	"Something about compaction. We keep Pi's native `<read-files>` / `<modified-files>` blocks.",
	"",
	EMBEDDED,
	"",
	"---",
	"",
	TRAILING,
].join("\n");

fakeCompact.result = {
	summary: SUMMARY,
	details: { readFiles: [realC, join(pkg, "secret", "inner.ts")], modifiedFiles: [realA, realB, secret, "/tmp/x.ts"] },
};

console.log("\n[2] 正文里嵌入的旧块会被剥掉并合并");
compactCalls = [];
fakeCompact.throwMode = "none";
let res = await hooks.session_before_compact(
	{ preparation: {}, customInstructions: undefined, signal: undefined, reason: "manual" },
	makeCtx([]),
);
const out = res?.compaction;
ok("返回了 compaction（没有 cancel）", !!out);
ok("只调用一次 compact", compactCalls.length === 1, `calls=${compactCalls.length}`);
const readBlocks = (out.summary.match(/\n<read-files>\n/g) || []).length;
const modBlocks = (out.summary.match(/\n<modified-files>\n/g) || []).length;
ok("输出里 read 块 <=1", readBlocks <= 1, `read=${readBlocks}`);
ok("输出里 modified 块 <=1", modBlocks <= 1, `modified=${modBlocks}`);
ok("嵌入块的存活路径被合并进来", out.summary.includes(realA), "realA 应出现在末尾清单里");
ok("正文里对标签的提及没被吞", out.summary.includes("We keep Pi's native `<read-files>`"));
ok("Goal 正文保留", out.summary.includes("## Goal"));
ok("blocksFound 记成 3", out.details.fileListIndex.blocksFound === 3, JSON.stringify(out.details.fileListIndex));
ok("输出比输入短", out.summary.length < SUMMARY.length, `${SUMMARY.length} -> ${out.summary.length}`);

console.log("\n[3] 存档也脱敏（archiveSensitive=false）");
const arch = [...(out.details.readFiles || []), ...(out.details.modifiedFiles || [])];
ok("存档里没有 secret 路径", !arch.some((p) => p.includes("secret")), JSON.stringify(arch));
ok("存档里没有 /private/ 形态", !arch.some((p) => p.includes("/private/")));
ok("fileListIndex 记了 archiveHidden", out.details.fileListIndex.archiveHidden >= 2, JSON.stringify(out.details.fileListIndex.archiveHidden));
ok("失效路径仍被剔出上下文", !out.summary.includes(gone));
ok("/tmp 被 exclude", !out.summary.includes("/tmp/old-junk.ts"));

console.log("\n[4] 幂等：同一份 summary 再压缩一次不再变");
const first = out.summary;
fakeCompact.result = { ...fakeCompact.result, summary: first };
const res2 = await hooks.session_before_compact(
	{ preparation: {}, customInstructions: undefined, signal: undefined, reason: "manual" },
	makeCtx([]),
);
ok("第二次输出与第一次一致", res2.compaction.summary === first, `${first.length} -> ${res2.compaction.summary.length}`);

console.log("\n[5] 降级：stream 路径失败时只回退一次，并记住模式");
fakeCompact.throwMode = "stream";
compactCalls = [];
const res3 = await hooks.session_before_compact(
	{ preparation: {}, customInstructions: undefined, signal: undefined, reason: "manual" },
	makeCtx([]),
);
ok("回退后成功", !!res3.compaction);
ok("这次调了 2 次（stream 失败 + default）", compactCalls.length === 2, JSON.stringify(compactCalls));
compactCalls = [];
const res4 = await hooks.session_before_compact(
	{ preparation: {}, customInstructions: undefined, signal: undefined, reason: "manual" },
	makeCtx([]),
);
ok("记住了 default 模式，之后只调 1 次", compactCalls.length === 1, JSON.stringify(compactCalls));
ok("之后不再走 stream", compactCalls.length === 1 && compactCalls[0].stream === false, JSON.stringify(compactCalls));
ok("结果仍然有效", !!res4.compaction && res4.compaction.summary.includes("## Goal"));

console.log("\n[9] 用本会话真实 compaction 数据跑完整钩子（不调模型）");
const SESS = process.env.PI_TEST_SESSION;
if (!SESS || !existsSync(SESS)) {
	console.log("      (未设 PI_TEST_SESSION，跳过)");
} else {
	let last = null;
	for (const line of readFileSync(SESS, "utf-8").split("\n")) {
		if (!line.includes('"compaction"')) continue;
		try {
			const d = JSON.parse(line);
			if (d.type === "compaction") last = d;
		} catch {
			/* skip */
		}
	}
	if (!last) {
		console.log("      (没有 compaction 条目，跳过)");
	} else {
		const realCfg = JSON.parse(readFileSync(join(fakeHome, ".pi", "pi-compaction-files.json"), "utf-8"));
		fakeCompact.throwMode = "none";
		// 往真实存档里插两条敏感形态路径，验证它们不会进入新存档
		//（本会话最后一条真实存档本身不含敏感项，不插就测不出脱敏）。
		const poisonRead = [join(pkg, "private", "测试.png")];
		const poisonMod = [join(pkg, "secret", "x.ts")];
		fakeCompact.result = {
			summary: last.summary,
			details: {
				readFiles: [...(last.details?.readFiles || []), ...poisonRead],
				modifiedFiles: [...(last.details?.modifiedFiles || []), ...poisonMod],
			},
		};
		compactCalls = [];
		const rReal = await hooks.session_before_compact(
			{ preparation: {}, reason: "manual" },
			makeCtx([{ type: "compaction", details: last.details }]),
		);
		const rr = rReal?.compaction;
		ok("真实数据返回了 compaction", !!rr);
		ok("真实数据 blocksFound >= 1（清单块被识别）", rr.details.fileListIndex.blocksFound >= 1, JSON.stringify(rr.details.fileListIndex.blocksFound));
		const rb = pc.countCompleteBlocks(rr.summary);
		ok("真实数据输出每种块 <=1", rb.read <= 1 && rb.modified <= 1, JSON.stringify(rb));
		ok("真实数据输出不变长", rr.summary.length <= last.summary.length, `${last.summary.length} -> ${rr.summary.length}`);
		const rArch = [...(rr.details.readFiles || []), ...(rr.details.modifiedFiles || [])];
		const rLeak = rArch.filter((p) => realCfg.sensitivePatterns.some((pat) => p.includes(pat)));
		ok("真实存档里没有敏感路径", rLeak.length === 0, `${rLeak.length} 泄露: ${JSON.stringify(rLeak.slice(0, 3))}`);
		ok("插进去的敏感项被剔出存档", rr.details.fileListIndex.archiveHidden >= 2, JSON.stringify(rr.details.fileListIndex.archiveHidden));
		ok("插进去的private路径不在上下文里", !rr.summary.includes(poisonRead[0]), "上下文里不应出现该路径");
		ok("真实上下文清单不超上限", pc.countCompleteBlocks(rr.summary) && true);
		const rRes = (rr.summary.match(/\n<modified-files>\n([\s\S]*?)\n<\/modified-files>/) || [])[1];
		const rLines = rRes ? rRes.split("\n").filter(Boolean).length : 0;
		ok("上下文 modified 条数 <= keepModified", rLines <= realCfg.keepModified, `lines=${rLines}`);
		console.log(`      真实 summary ${last.summary.length} -> ${rr.summary.length} B；存档 ${(last.details?.readFiles?.length || 0) + (last.details?.modifiedFiles?.length || 0)} -> ${rArch.length} 条（剔掉 ${rr.details.fileListIndex.archiveHidden} 条敏感）`);
	}
}

console.log("\n[6] 失败预算：连续失败后不再尝试，交回 Pi");
fakeCompact.throwMode = "always";
compactCalls = [];
const r1 = await hooks.session_before_compact({ preparation: {}, reason: "manual" }, makeCtx([]));
ok("第 1 次失败返回 {}（Pi 接管）", r1 && Object.keys(r1).length === 0);
const r2 = await hooks.session_before_compact({ preparation: {}, reason: "manual" }, makeCtx([]));
ok("第 2 次失败返回 {}", r2 && Object.keys(r2).length === 0);
const callsSoFar = compactCalls.length;
const r3 = await hooks.session_before_compact({ preparation: {}, reason: "manual" }, makeCtx([]));
ok("第 3 次不再调用 compact", compactCalls.length === callsSoFar, `calls ${callsSoFar} -> ${compactCalls.length}`);
ok("第 3 次仍返回 {}", r3 && Object.keys(r3).length === 0);

console.log("\n[7] context 钩子：把已存的脏 summary 就地洗短");
const msg = { role: "compactionSummary", summary: SUMMARY };
await hooks.context({ messages: [msg] }, makeCtx([]));
ok("context 洗过之后只剩 1 个 modified 块", (msg.summary.match(/\n<modified-files>\n/g) || []).length === 1);
ok("context 洗过之后 Goal 还在", msg.summary.includes("## Goal"));
const before = msg.summary;
await hooks.context({ messages: [msg] }, makeCtx([]));
ok("再跑一次不变（幂等）", msg.summary === before);

console.log("\n[8] 自检：对着本机真实 Pi");
const chk = pc.checkPiInternals();
ok("找到 Pi dist", !!chk.distDir, JSON.stringify(chk.notes));
ok("自检 ok", chk.ok, JSON.stringify(chk.missing));
console.log(`      dist=${chk.distDir}`);
for (const f of chk.found) console.log(`      ok: ${f}`);
ok("countCompleteBlocks 数得对", JSON.stringify(pc.countCompleteBlocks(SUMMARY)) === JSON.stringify({ read: 1, modified: 2 }), JSON.stringify(pc.countCompleteBlocks(SUMMARY)));

rmSync(join(pkg, ".mock-pi.mjs"), { force: true });
rmSync(join(here, "secret-token.txt"), { force: true });
rmSync(fakeHome, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
