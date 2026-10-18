/**
 * pi-compaction-files
 *
 * Pi's compaction appends unlimited `<read-files>` / `<modified-files>` blocks to
 * every summary and re-inherits them on the next compaction. In a long-running real session
 * that reached 1907 paths (~27.5k Pi-estimated tokens) injected on every turn.
 *
 * This extension does two things, and nothing else:
 *
 * 1. `session_before_compact`: it calls Pi's own `compact()` (so the summary text
 *    is produced exactly as Pi would produce it), then replaces the file blocks in
 *    the returned summary with a skills-style index. Because the result comes from
 *    a hook, Pi persists `fromHook: true`, which stops the next compaction from
 *    inheriting the old lists (`compaction.js:21`) — the snowball breaks at source.
 *    The full lists are kept in the entry's `details`, which Pi never renders.
 *
 * 2. `context`: it rewrites the already-stored compaction message the same way on
 *    every turn, so an existing bloated session shrinks immediately without
 *    touching the session file.
 *
 * Plus a `session_files` tool for on-demand lookup of the full inventory.
 *
 * Never cancels compaction. If anything here fails it returns {} and Pi's default
 * path runs untouched.
 *
 * Config (optional): ~/.pi/pi-compaction-files.json
 *   { "enabled": true, "keepModified": 60, "keepRead": 40, "dropMissing": true,
 *     "excludePatterns": [...], "sensitivePatterns": [...] }
 * Disable at runtime: PI_FILELIST_DISABLE=1
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_OPTIONS,
	hasFileBlocks,
	pathMatchesAny,
	realFs,
	rewriteSummary,
	type FileListOptions,
	type ListStats,
} from "./filelist";
import { checkPiInternals, countCompleteBlocks, type PiCheck } from "./picheck";

interface Config extends FileListOptions {
	enabled: boolean;
	/** Register the session_files lookup tool (only meaningful with style="index"). */
	tool: boolean;
	/** Keep paths matching sensitivePatterns in the on-disk `details` archive too.
	 *  Default false: they are stripped from the archive as well as from context. */
	archiveSensitive: boolean;
	/** Explicit Pi dist/ dir for the self-check (usually unnecessary). */
	piDistDir?: string;
}

/** How many consecutive hook failures before we stop trying (Pi handles it). */
const MAX_FAIL_STREAK = 2;

const CONFIG_PATH = join(homedir(), ".pi", "pi-compaction-files.json");

function loadConfig(): Config {
	const base: Config = { enabled: true, tool: false, archiveSensitive: false, ...DEFAULT_OPTIONS };
	if (process.env.PI_FILELIST_DISABLE === "1") {
		base.enabled = false;
		return base;
	}
	try {
		if (!existsSync(CONFIG_PATH)) return base;
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<Config>;
		return {
			enabled: raw.enabled !== false,
			tool: raw.tool === true,
			archiveSensitive: raw.archiveSensitive === true,
			piDistDir: typeof raw.piDistDir === "string" && raw.piDistDir ? raw.piDistDir : undefined,
			style: raw.style === "index" ? "index" : "native",
			indexRecent: Number.isSafeInteger(raw.indexRecent) && (raw.indexRecent as number) >= 0 ? (raw.indexRecent as number) : base.indexRecent,
			keepModified: Number.isSafeInteger(raw.keepModified) ? (raw.keepModified as number) : base.keepModified,
			keepRead: Number.isSafeInteger(raw.keepRead) ? (raw.keepRead as number) : base.keepRead,
			dropMissing: raw.dropMissing !== false,
			excludePatterns: Array.isArray(raw.excludePatterns) ? raw.excludePatterns : base.excludePatterns,
			sensitivePatterns: Array.isArray(raw.sensitivePatterns) ? raw.sensitivePatterns : base.sensitivePatterns,
		};
	} catch {
		return base;
	}
}

function log(msg: string): void {
	process.stderr.write(`[pi-compaction-files] ${msg}\n`);
}

/** Cap the archived inventory so the session file cannot grow without bound. */
const MAX_ARCHIVED = 4000;

function norm(p: string, cwd: string): string {
	const t = p.trim();
	if (!t) return t;
	return t.startsWith("/") ? t : `${cwd.replace(/\/+$/, "")}/${t}`;
}

/** Newest-first union, deduped, capped. Reports how many entries were dropped. */
function mergeLists(primary: string[], secondary: string[]): { list: string[]; overflow: number } {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of [...primary, ...secondary]) {
		const t = p.trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	if (out.length <= MAX_ARCHIVED) return { list: out, overflow: 0 };
	return { list: out.slice(0, MAX_ARCHIVED), overflow: out.length - MAX_ARCHIVED };
}

/** Cheap identity for one compaction summary; used to avoid re-filtering every turn. */
function signature(summary: string): string {
	return `${summary.length}:${summary.slice(0, 64)}:${summary.slice(-64)}`;
}

interface CachedRewrite {
	summary: string;
	stats: ListStats;
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();
	/** compaction summary signature -> rewritten summary */
	const cache = new Map<string, CachedRewrite>();
	let lastReport: { at: string; stats: ListStats; source: string } | null = null;
	/** consecutive hook failures; at MAX_FAIL_STREAK we stop and let Pi handle compaction */
	let failStreak = 0;
	let failStreakLogged = false;
	/** per-model memory of which completion path worked, so we do not re-probe every time */
	const streamMode = new Map<string, "stream" | "default">();
	const piCheck: PiCheck = checkPiInternals(config.piDistDir);

	if (!piCheck.ok) {
		log(
			`SELF-CHECK: Pi internals not fully recognised (${piCheck.missing.join("; ")}). ` +
				`The extension still runs, but the file lists may grow again — re-check after a Pi upgrade.`,
		);
	} else {
		log(`self-check ok (pi dist ${piCheck.distDir})`);
	}
	for (const n of piCheck.notes) log(`self-check note: ${n}`);

	function rewrite(summary: string, cwd: string, source: string): { summary: string; stats: ListStats; changed: boolean } {
		const sig = signature(summary);
		const hit = cache.get(sig);
		if (hit) return { summary: hit.summary, stats: hit.stats, changed: true };
		const res = rewriteSummary(summary, config, cwd, realFs);
		if (!res.changed) return { summary, stats: res.stats, changed: false };
		const entry: CachedRewrite = { summary: res.summary, stats: res.stats };
		cache.set(sig, entry);
		while (cache.size > 8) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		lastReport = { at: new Date().toISOString(), stats: res.stats, source };
		log(
			`${source}: blocks ${res.stats.blocksFound}, read ${res.stats.readTotal}->${res.stats.keptRead}, ` +
				`modified ${res.stats.modifiedTotal}->${res.stats.keptModified}, ` +
				`missing -${res.stats.droppedMissing}, excluded -${res.stats.droppedExcluded}, dup -${res.stats.droppedDuplicate}, ` +
				`sensitive hidden ${res.stats.hiddenSensitive}; chars ${res.stats.charsBefore}->${res.stats.charsAfter} ` +
				`(≈${Math.ceil(Math.max(0, res.stats.charsBefore - res.stats.charsAfter) / 4)} tokens saved)`,
		);
		// Functional guard, independent of Pi's source: after a rewrite at most one
		// complete block of each kind may remain (the one we just emitted).
		const left = countCompleteBlocks(res.summary);
		if (left.read > 1 || left.modified > 1) {
			log(
				`WARNING: ${source} left ${left.read} read + ${left.modified} modified complete blocks after rewrite ` +
					`(expected <=1 each). A block shape our regexes miss is surviving into context.`,
			);
		}
		return { summary: res.summary, stats: res.stats, changed: true };
	}

	// ---- 1. Shrink every future compaction at the source -------------------
	pi.on("session_before_compact", async (event, ctx: ExtensionContext) => {
		if (!config.enabled) return {};
		const model = ctx.model;
		if (!model) return {};
		if (failStreak >= MAX_FAIL_STREAK) {
			if (!failStreakLogged) {
				log(`${failStreak} consecutive failures; leaving compaction to Pi until a Pi restart`);
				failStreakLogged = true;
				}
			return {};
		}
		try {
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth || auth.ok !== true) {
				log(`no auth for ${model.provider}/${model.id}; leaving compaction to Pi`);
				return {};
			}
			const streamFn = (m: unknown, c: unknown, o: unknown) =>
				ctx.modelRegistry.stream(m as never, c as never, o as never);
			const modelKey = `${model.provider}/${model.id}`;
			const preferred = streamMode.get(modelKey);
			const doCompact = (useStream: boolean) =>
				compact(
					event.preparation,
					model,
					auth.apiKey,
					auth.headers,
					event.customInstructions,
					event.signal,
					ctx.thinkingLevel,
					useStream ? (streamFn as never) : undefined,
					auth.env,
				);
			let result;
			// One attempt on the remembered path; one fallback at most. We never retry
			// both paths every time — that would silently double the summarisation cost.
			try {
				result = await doCompact(preferred !== "default");
				if (!preferred) streamMode.set(modelKey, "stream");
			} catch (err) {
				if (preferred === "default") throw err;
				log(`stream path failed (${String(err)}); retrying with default completion`);
				result = await doCompact(false);
				streamMode.set(modelKey, "default");
			}
			const details = (result.details ?? {}) as { readFiles?: string[]; modifiedFiles?: string[] };
			const fullRead = Array.isArray(details.readFiles) ? details.readFiles : [];
			const fullModified = Array.isArray(details.modifiedFiles) ? details.modifiedFiles : [];

			// Pi stops inheriting file lists once a hook produced the compaction
			// (compaction.js:21 requires !fromHook). Merge the previous entry's lists back
			// in so session_files keeps answering across compactions; details are never
			// rendered into context, so this costs prompt tokens nothing.
			const prev = previousFileLists(ctx);
			// The archive is plaintext in the session file. Unless explicitly asked to
			// keep it, strip sensitive-shaped paths from the archive as well as from the
			// rendered list, so enabling the session_files tool cannot surface them.
			const desensitise = (list: string[]): { list: string[]; hidden: number } => {
				if (config.archiveSensitive) return { list, hidden: 0 };
				const kept = list.filter((p) => !pathMatchesAny(norm(p, ctx.cwd), config.sensitivePatterns));
				return { list: kept, hidden: list.length - kept.length };
			};
			const mergedModifiedRaw = mergeLists(fullModified, prev.modified);
			const mergedModified = { list: desensitise(mergedModifiedRaw.list).list, overflow: mergedModifiedRaw.overflow };
			const archivedHidden = desensitise(mergedModifiedRaw.list).hidden;
			const modifiedSet = new Set(mergedModified.list.map((p) => norm(p, ctx.cwd)));
			const mergedReadRaw = mergeLists(
				fullRead.filter((p) => !modifiedSet.has(norm(p, ctx.cwd))),
				prev.modified.concat(prev.read),
			);
			const readDes = desensitise(mergedReadRaw.list);
			const mergedRead = { list: readDes.list, overflow: mergedReadRaw.overflow };
			const archiveHiddenTotal = archivedHidden + readDes.hidden;

			const rw = rewrite(result.summary, ctx.cwd, `compact(${event.reason})`);
			if (rw.changed) result.summary = rw.summary;
			// Keep the inventory where Pi never renders it, so session_files can answer —
			// written whether or not the summary text needed changing.
			result.details = {
				...details,
				readFiles: mergedRead.list,
				modifiedFiles: mergedModified.list,
				fileListIndex: {
					keptRead: rw.stats.keptRead,
					keptModified: rw.stats.keptModified,
					droppedMissing: rw.stats.droppedMissing,
					droppedExcluded: rw.stats.droppedExcluded,
					droppedDuplicate: rw.stats.droppedDuplicate,
					hiddenSensitive: rw.stats.hiddenSensitive,
					mergedReadTotal: mergedRead.list.length,
					mergedModifiedTotal: mergedModified.list.length,
					mergedOverflow: mergedRead.overflow + mergedModified.overflow,
					blocksFound: rw.stats.blocksFound,
					archiveHidden: archiveHiddenTotal,
					archiveSensitiveKept: config.archiveSensitive,
				},
			};
			failStreak = 0;
			failStreakLogged = false;
			return { compaction: result };
		} catch (err) {
			failStreak++;
			log(
				`compaction hook failed (attempt ${failStreak}/${MAX_FAIL_STREAK}), leaving it to Pi: ${String(err)}` +
					(failStreak >= MAX_FAIL_STREAK ? " — disabling for this Pi process" : ""),
			);
			return {};
		}
	});

	// ---- 2. Shrink the already-stored compaction on every turn -------------
	pi.on("context", async (event, ctx: ExtensionContext) => {
		if (!config.enabled) return {};
		let touched = 0;
		for (const message of event.messages) {
			const anyMsg = message as unknown as { role?: string; summary?: string };
			if (anyMsg.role !== "compactionSummary" || typeof anyMsg.summary !== "string") continue;
			if (!hasFileBlocks(anyMsg.summary)) continue;
			const rw = rewrite(anyMsg.summary, ctx.cwd, "context");
			if (rw.changed) {
				anyMsg.summary = rw.summary;
				touched++;
			}
		}
		// In-place edits are honoured by Pi; returning nothing keeps the array identity.
		return touched > 0 ? undefined : {};
	});

	// ---- 3. On-demand lookup of the full inventory -------------------------
	function previousFileLists(ctx: ExtensionContext): { read: string[]; modified: string[] } {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as unknown as { type?: string; details?: unknown };
				if (entry?.type !== "compaction") continue;
				const details = entry.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
				if (!details) return { read: [], modified: [] };
				return {
					read: Array.isArray(details.readFiles) ? details.readFiles : [],
					modified: Array.isArray(details.modifiedFiles) ? details.modifiedFiles : [],
				};
			}
		} catch {
			return { read: [], modified: [] };
		}
		return { read: [], modified: [] };
	}

	function latestCompactionDetails(ctx: ExtensionContext): { read: string[]; modified: string[] } | undefined {
		try {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i] as unknown as { type?: string; details?: unknown };
				if (entry?.type !== "compaction") continue;
				const details = entry.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
				if (!details) return { read: [], modified: [] };
				return {
					read: Array.isArray(details.readFiles) ? details.readFiles : [],
					modified: Array.isArray(details.modifiedFiles) ? details.modifiedFiles : [],
				};
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	if (config.tool)
			pi.registerTool({
			name: "session_files",
			label: "Session Files",
			description:
			"Search the full file inventory kept in this session's compaction records. Only an index is in context; the full list lives in the session entry details. Filters by keyword and returns matching paths.",
		promptSnippet: "Search the compaction file inventory (the full list is not in context)",
		promptGuidelines: [
			"Use session_files to look up which files were read or modified earlier; do not try to read the whole inventory.",
			"session_files returns paths only, never file contents; use read for contents.",
		],
			parameters: Type.Object({
				kind: Type.Optional(
				Type.String({ description: "read | modified | all (default all)" }),
			),
			query: Type.Optional(Type.String({ description: "case-insensitive substring filter, e.g. nginx, gateway" })),
				limit: Type.Optional(Type.Number({ description: "max results, default 60, capped at 300" })),
			}),
			async execute(
				_toolCallId: string,
			params: { kind?: string; query?: string; limit?: number },
			_signal: unknown,
			_onUpdate: unknown,
				ctx: ExtensionContext,
			) {
				const lists = latestCompactionDetails(ctx);
			if (!lists) {
				return {
						content: [{ type: "text" as const, text: "No compaction entries on this session branch, so there is no inventory to search." }],
					details: { read: 0, modified: 0 },
					};
				}
				const kind = (params.kind ?? "all").toLowerCase();
				const pool =
					kind === "read" ? lists.read : kind === "modified" ? lists.modified : [...lists.modified, ...lists.read];
				const q = (params.query ?? "").toLowerCase();
				const limit = Math.min(Math.max(params.limit ?? 60, 1), 300);
				const seen = new Set<string>();
				const out: string[] = [];
				for (const raw of pool) {
					const p = raw.trim();
					if (!p || seen.has(p)) continue;
					seen.add(p);
					if (q && !p.toLowerCase().includes(q)) continue;
					out.push(p);
					if (out.length >= limit) break;
			}
				const head = `inventory: ${lists.read.length} read / ${lists.modified.length} modified; ${out.length} match(es)${out.length >= limit ? " (truncated — narrow with query)" : ""}`;
			return {
				content: [{ type: "text" as const, text: out.length ? `${head}\n${out.join("\n")}` : head }],
				details: { read: lists.read.length, modified: lists.modified.length, matched: out.length },
			};
		},
	});

	// ---- 4. Status -------------------------------------------------------
	pi.registerCommand("filelist", {
		description: "Show pi-compaction-files stats and config",
		handler: async (_args: string, ctx) => {
			const lines = [
				`enabled=${config.enabled} style=${config.style} keepModified=${config.keepModified} keepRead=${config.keepRead} dropMissing=${config.dropMissing}`,
				`archiveSensitive=${config.archiveSensitive} tool=${config.tool} indexRecent=${config.indexRecent} failStreak=${failStreak}/${MAX_FAIL_STREAK}`,
				`exclude=[${config.excludePatterns.join(", ")}]`,
				`cache=${cache.size} streamMode=[${[...streamMode.entries()].map(([m, s]) => `${m}:${s}`).join(", ")}]`,
				`pi-self-check=${piCheck.ok ? "ok" : "PROBLEM"}${piCheck.distDir ? ` dist=${piCheck.distDir}` : ""}`,
			];
			for (const f of piCheck.found) lines.push(`  ok: ${f}`);
			for (const f of piCheck.missing) lines.push(`  MISSING: ${f}`);
			for (const n of piCheck.notes) lines.push(`  note: ${n}`);
			if (lastReport) {
				const s = lastReport.stats;
				lines.push(
					`last(${lastReport.source}, ${lastReport.at}): read ${s.readTotal}->${s.keptRead}, modified ${s.modifiedTotal}->${s.keptModified}, ` +
						`missing -${s.droppedMissing}, excluded -${s.droppedExcluded}, dup -${s.droppedDuplicate}, hidden ${s.hiddenSensitive}, ` +
						`chars ${s.charsBefore}->${s.charsAfter}`,
				);
			} else {
				lines.push("last: no compaction summary processed yet");
			}
			const lists = latestCompactionDetails(ctx as unknown as ExtensionContext);
			if (lists) lines.push(`current inventory: read ${lists.read.length} / modified ${lists.modified.length}`);
			const text = lines.join("\n");
			try {
				(ctx as unknown as { ui?: { notify?: (m: string, t: string) => void } }).ui?.notify?.(text, "info");
			} catch {
				/* no UI (print/rpc mode) */
			}
			process.stderr.write(`${text}\n`);
		},
	});
}
