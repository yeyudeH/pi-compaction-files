/**
 * Self-check: this extension depends on three *internal* Pi behaviours that have no
 * public contract:
 *
 *   1. `compaction.js` skips inheriting the previous file lists when the previous
 *      compaction came from a hook (`!prevCompaction.fromHook`).
 *   2. `session-manager.js` persists `fromHook` on the compaction entry.
 *   3. `compaction.js` still appends `<read-files>` / `<modified-files>` blocks.
 *
 * If a Pi upgrade changes any of them the extension does not crash — it silently
 * stops helping, and the file lists start growing again. So we look for the anchors
 * at load time and say so out loud. This is a *check*, not a dependency: failing it
 * never disables the extension, it only logs.
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PiCheck {
	ok: boolean;
	distDir?: string;
	found: string[];
	missing: string[];
	notes: string[];
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

/** Walk up from `start` looking for `<…>/core/compaction/compaction.js`. */
function distFrom(start: string): string | undefined {
	let dir = dirname(start);
	for (let i = 0; i < 8; i++) {
		if (isFile(join(dir, "core", "compaction", "compaction.js"))) return dir;
		const next = dirname(dir);
		if (next === dir) break;
		dir = next;
	}
	return undefined;
}

/** Best-effort discovery of Pi's `dist/` directory from inside a running Pi. */
export function locatePiDist(explicit?: string): string | undefined {
	if (explicit && isFile(join(explicit, "core", "compaction", "compaction.js"))) return explicit;
	if (explicit) {
		try {
			const r = distFrom(realpathSync(join(explicit, "core", "compaction", "compaction.js")));
			if (r) return r;
		} catch {
			/* fall through */
		}
	}

	// 1. env override
	const env = process.env.PI_CODING_AGENT_DIST;
	if (env && isFile(join(env, "core", "compaction", "compaction.js"))) return env;

	// 2. resolvable as a dependency (true in the offline test fixture)
	try {
		const req = createRequire(import.meta.url);
		const entry = req.resolve("@earendil-works/pi-coding-agent");
		const d = distFrom(realpathSync(entry));
		if (d) return d;
	} catch {
		/* not installed as a dependency — expected in production */
	}

	// 3. follow the launcher on PATH (pi's bin is a symlink into dist/bundle/cli.js)
	const argv0 = (process.argv[1] || process.argv[0] || "").trim();
	const names = [argv0, "pi"].filter(Boolean);
	const pathDirs = (process.env.PATH || "").split(":").filter(Boolean);
	const tried = new Set<string>();
	for (const name of names) {
		const cands = name.includes("/") ? [name] : pathDirs.map((d) => join(d, name));
		for (const c of cands) {
			if (tried.has(c) || !isFile(c)) continue;
			tried.add(c);
			try {
				const d = distFrom(realpathSync(c));
				if (d) return d;
			} catch {
				/* keep looking */
			}
		}
	}

	// 4. common global install roots
	for (const root of [
		"/usr/local/lib/node_modules",
		"/usr/lib/node_modules",
		join(process.env.HOME || "", ".pi/agent/npm/node_modules"),
	]) {
		const p = join(root, "@earendil-works", "pi-coding-agent", "dist");
		if (isFile(join(p, "core", "compaction", "compaction.js"))) return p;
	}
	return undefined;
}

function read(p: string): string {
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return "";
	}
}

/** Look for the anchors. `ok` means every anchor was found. */
export function checkPiInternals(explicitDir?: string): PiCheck {
	const found: string[] = [];
	const missing: string[] = [];
	const notes: string[] = [];

	const distDir = locatePiDist(explicitDir);
	if (!distDir) {
		notes.push("could not locate Pi dist/ (checked PI_CODING_AGENT_DIST, node resolution, PATH launcher, global roots)");
		return { ok: false, found, missing: ["pi dist/"], notes };
	}

	const comp = read(join(distDir, "core", "compaction", "compaction.js"));
	const utils = read(join(distDir, "core", "compaction", "utils.js"));
	const sm = read(join(distDir, "core", "session-manager.js"));
	if (!comp) {
		notes.push(`compaction.js unreadable under ${distDir}`);
		return { ok: false, distDir, found, missing: ["compaction.js"], notes };
	}

	// anchor 1 — the inheritance guard
	if (/!\s*\w*[Cc]ompaction\w*\.fromHook/.test(comp) || /fromHook/.test(comp)) {
		found.push("compaction.js: fromHook inheritance guard present");
	} else {
		missing.push("compaction.js: no fromHook guard (hook-produced compactions may inherit old lists again)");
	}

	// anchor 2 — fromHook is persisted on the entry
	if (sm && /fromHook/.test(sm)) {
		found.push("session-manager.js: fromHook persisted on compaction entries");
	} else {
		missing.push("session-manager.js: fromHook not found (snowball may resume)");
	}

	// anchor 3 — Pi still emits the blocks we shrink.
	// The literal lives in compaction/utils.js; compaction.js only calls the formatter.
	if (/<read-files>/.test(utils) && /formatFileOperations/.test(comp)) {
		found.push("compaction/utils.js + compaction.js: still emits read-files/modified-files blocks");
	} else if (!utils) {
		missing.push("compaction/utils.js not found (cannot confirm blocks are still emitted)");
	} else {
		notes.push("Pi no longer emits file blocks — this extension is now redundant, not broken");
	}

	// anchor 4 — details is not rendered into context (we archive there)
	if (/details/.test(comp)) found.push("compaction.js: details field still carried");
	else missing.push("compaction.js: details field not found (archive may be dropped)");

	return { ok: missing.length === 0, distDir, found, missing, notes };
}

/**
 * Functional guard that needs no file paths: after a rewrite there must be at most
 * one complete block of each kind left. More than that means something re-seeded a
 * list we did not account for (Pi change, or a block shape our regexes miss).
 */
export function countCompleteBlocks(summary: string): { read: number; modified: number } {
	let read = 0;
	let modified = 0;
	for (const m of summary.matchAll(/\n<read-files>\n[\s\S]*?\n<\/read-files>/g)) read++;
	for (const m of summary.matchAll(/\n<modified-files>\n[\s\S]*?\n<\/modified-files>/g)) modified++;
	return { read, modified };
}
