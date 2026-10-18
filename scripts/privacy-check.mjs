/**
 * Privacy gate: fail the build if anything that looks like a developer's real
 * machine, account, session or private directory leaks into the published tree.
 *
 * Run:  node scripts/privacy-check.mjs
 * Also wired into `npm run check`.
 *
 * It checks two things:
 *   1. forbidden patterns (home dirs, session ids, host names, personal dir names)
 *   2. that the tarball file list (`npm pack --dry-run`) contains no dot-directories
 *      or build caches
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// Deliberately broad: any /home/<name> or /Users/<name> that is not the neutral
// fixture used by the tests.
// Generic patterns only — this file is published, so it must not quote the author's
// own account, host or directory names. Put those in scripts/privacy-extra.txt
// (gitignored and npmignored); one pattern per line, plain substrings.
const FORBIDDEN = [
	{ re: /\/home\/(?!dev\/)[a-z]/, why: "a real /home/<user> path" },
	{ re: /\/Users\/[a-z]/, why: "a real /Users/<user> path" },
	{ re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, why: "a UUID (likely a session id)" },
	{ re: /\b20\d\d-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_/, why: "a Pi session file name" },
	{ re: /--home-[^/]*--/, why: "a Pi session directory name" },
	{ re: /\/srv\/[a-z-]+\/.*sessions?\//, why: "a session path on a non-standard mount" },
	{ re: /\b\w+@\w+\.(com|net|org|xyz|dev|io)\b/, why: "an e-mail address" },
	{ re: /\b\w+\.(xyz|internal|local)\b\/(api|v1|console)/, why: "a hostname plus endpoint from the author's infrastructure" },
];

function extraPatterns() {
	// Deliberately OUTSIDE the package directory: this file names the author's own
	// account/host/private folders, and the `files` allowlist in package.json would
	// otherwise ship it. Override with PI_PRIVACY_FILE.
	const f = process.env.PI_PRIVACY_FILE || join(root, "..", "privacy-extra.txt");
	if (!existsSync(f)) return [];
	return readFileSync(f, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"))
		.map((l) => ({ re: new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), why: `private pattern from privacy-extra.txt: ${l}` }));
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "dist"]);
const SCAN_EXT = [".ts", ".mjs", ".js", ".json", ".md", ".txt", ".yml", ".yaml", ""];

let hits = 0;
const files = [];
(function walk(dir) {
	for (const name of readdirSync(dir)) {
		if (SKIP_DIRS.has(name)) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (SCAN_EXT.some((e) => name.endsWith(e))) files.push(p);
	}
})(root);

const EXTRA = extraPatterns();
const ALL = [...FORBIDDEN, ...EXTRA];

for (const f of files) {
	const rel = relative(root, f);
	if (rel.startsWith("scripts/privacy-check")) continue; // this file quotes the generic patterns
	const text = readFileSync(f, "utf8");
	for (let i = 0; i < text.split("\n").length; i++) {
		const line = text.split("\n")[i];
		for (const { re, why } of ALL) {
			if (re.test(line)) {
				hits++;
				console.log(`  ✗ ${rel}:${i + 1}  ${why}`);
				console.log(`      ${line.trim().slice(0, 120)}`);
				break;
			}
		}
	}
}

// tarball contents
if (existsSync(join(root, "package.json"))) {
	try {
		const out = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf8" });
		const parsed = JSON.parse(out);
		const list = (Array.isArray(parsed) ? parsed[0] : parsed).files || [];
		const bad = list.filter((f) => /(^|\/)\.(pi|cache|config)|node_modules|\.env|\.jsonl|privacy-extra/.test(f.path));
		console.log(`\n  通用模式 ${FORBIDDEN.length} 条 + 本地私有模式 ${EXTRA.length} 条`);
	console.log(`  npm pack 会打包 ${list.length} 个文件`);
		for (const b of bad) {
			hits++;
			console.log(`  ✗ tarball 里有不该出现的文件: ${b.path}`);
		}
		const expected = ["extensions/", "docs/", "README.md", "README.zh.md", "CHANGELOG.md", "LICENSE", "package.json"];
		const missing = expected.filter((e) => !list.some((f) => f.path === e || f.path.startsWith(e)));
		for (const m of missing) console.log(`  ! 未打包（确认是否有意）: ${m}`);
	} catch (e) {
		console.log(`  ! npm pack --dry-run 失败: ${String(e).slice(0, 120)}`);
	}
}

console.log(hits === 0 ? "\n  ✓ 隐私检查通过（0 处泄露）" : `\n  ✗ 隐私检查失败：${hits} 处`);
process.exit(hits === 0 ? 0 : 1);
