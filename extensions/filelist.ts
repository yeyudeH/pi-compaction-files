/**
 * pi-compaction-files — pure helpers.
 *
 * Pi's built-in compaction appends two unlimited-length blocks to every summary
 * (`compaction.js:710-711` -> `utils.js:66-77`):
 *
 *   <read-files>...</read-files>
 *   <modified-files>...</modified-files>
 *
 * and the next compaction inherits them again (`compaction.js:16-38`), so the
 * list only ever grows. In one long-running real session it reached 1907 paths /
 * 109,869 chars = ~27.5k tokens injected on every single turn.
 *
 * These helpers replace the blocks with a skills-style index: counts, the most
 * recently touched paths only, and a pointer to the `session_files` tool for
 * on-demand lookup. The full lists stay in the compaction entry's `details`,
 * which Pi never renders into context.
 *
 * No Pi imports here so the logic is unit-testable offline.
 */

import { existsSync, statSync } from "node:fs";

export interface FileListOptions {
	/**
	 * How the trimmed lists are rendered back into the summary.
	 *  - "native": re-emit Pi's own <read-files>/<modified-files> blocks, just shorter.
	 *  - "index":  replace them with a <session_files> index (needs the session_files tool).
	 */
	style: "native" | "index";
	/** How many most-recently-touched modified paths stay in context. */
	keepModified: number;
	/** How many most-recently-touched read paths stay in context. */
	keepRead: number;
	/** Drop paths that no longer exist on disk. */
	dropMissing: boolean;
	/** Substring patterns whose paths are dropped entirely. */
	excludePatterns: string[];
	/** Substring patterns whose paths are counted but never listed. */
	sensitivePatterns: string[];
	/**
	 * style="index" only: how many recent paths the index shows. The rest stay in the
	 * `details` archive for the session_files tool. Without this cap an index is LONGER
	 * than native (same lists plus a header and a note), which defeats the point.
	 */
	indexRecent: number;
}

export const DEFAULT_OPTIONS: FileListOptions = {
	style: "native",
	keepModified: 60,
	keepRead: 40,
	dropMissing: true,
	excludePatterns: ["/tmp/", "/dev/shm/", "/node_modules/", "/.cache/", "/proc/", "/sys/"],
	sensitivePatterns: [
		"/credential",
		"/secret",
		"/token",
		".key",
		"/password",
		"apikey",
		"/.pi/agent/settings.json",
		"/.pi/agent/models.json",
		// Add your own private directories here, e.g. "/secrets/", "/personal/",
		// or a non-English folder name you keep off the record.
	],
	indexRecent: 12,
};

export interface ListStats {
	readTotal: number;
	modifiedTotal: number;
	/** Complete file blocks found in the summary. >2 means the summarizer reproduced an
	 *  earlier block inside the narrative; all of them are stripped and merged. */
	blocksFound: number;
	droppedMissing: number;
	droppedExcluded: number;
	droppedDuplicate: number;
	hiddenSensitive: number;
	keptRead: number;
	keptModified: number;
	charsBefore: number;
	charsAfter: number;
}

export function emptyStats(): ListStats {
	return {
		readTotal: 0,
		modifiedTotal: 0,
		blocksFound: 0,
		droppedMissing: 0,
		droppedExcluded: 0,
		droppedDuplicate: 0,
		hiddenSensitive: 0,
		keptRead: 0,
		keptModified: 0,
		charsBefore: 0,
		charsAfter: 0,
	};
}

// Global + "strip every complete block". Pi appends the real blocks at the very end
// of the summary, but the summarizer can also reproduce an *earlier* block inside the
// narrative (observed in a long-running real session: a 1594 B / 38-path copy sitting
// mid-summary while Pi's real block sat at the end). Leaving those in place re-seeds
// the exact snowball this extension exists to stop, so we remove all of them and merge
// their paths into the inventory.
//
// Narrative *mentions* are still safe: the regex requires the tag alone on its own line
// plus a matching close tag, so prose like "keep Pi's native `<read-files>` blocks"
// never matches.
const READ_RE = /\n*<read-files>\n([\s\S]*?)\n<\/read-files>/g;
const MODIFIED_RE = /\n*<modified-files>\n([\s\S]*?)\n<\/modified-files>/g;

function splitPaths(body: string): string[] {
	return String(body ?? "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function hasFileBlocks(summary: string): boolean {
	return summary.includes("<read-files>") || summary.includes("<modified-files>");
}

/** Split the Pi file blocks out of a summary. Removes every complete block. */
export function extractFileLists(summary: string): {
	text: string;
	read: string[];
	modified: string[];
	blocks: number;
} {
	let text = summary;
	const read: string[] = [];
	const modified: string[] = [];
	let blocks = 0;

	text = text.replace(READ_RE, (_all: string, body: string) => {
		blocks++;
		read.push(...splitPaths(body));
		return "";
	});
	text = text.replace(MODIFIED_RE, (_all: string, body: string) => {
		blocks++;
		modified.push(...splitPaths(body));
		return "";
	});

	return { text: text.replace(/\s+$/, ""), read, modified, blocks };
}

/** Pi stores cwd-relative paths next to absolute ones; make them comparable. */
export function normalizePath(raw: string, cwd: string): string {
	const p = raw.trim();
	if (!p) return p;
	if (p.startsWith("/")) return p;
	return `${cwd.replace(/\/+$/, "")}/${p}`;
}

export interface FsProbe {
	exists(p: string): boolean;
	mtimeMs(p: string): number | null;
}

export const realFs: FsProbe = {
	exists(p: string): boolean {
		try {
			return existsSync(p);
		} catch {
			return false;
		}
	},
	mtimeMs(p: string): number | null {
		try {
			return statSync(p).mtimeMs;
		} catch {
			return null;
		}
	},
};

function matchesAny(p: string, patterns: string[]): boolean {
	for (const pat of patterns) if (pat && p.includes(pat)) return true;
	return false;
}

/** Public wrapper so callers can keep sensitive paths out of the archive too. */
export function pathMatchesAny(p: string, patterns: string[]): boolean {
	return matchesAny(p, patterns);
}

/**
 * Normalize, dedupe, drop dead/excluded paths, hide sensitive ones, then keep
 * the `keep` most recently touched. `stats` is updated in place.
 */
export function filterList(
	paths: string[],
	kind: "read" | "modified",
	opts: FileListOptions,
	cwd: string,
	fs: FsProbe,
	stats: ListStats,
): string[] {
	const seen = new Set<string>();
	const kept: string[] = [];

	for (const raw of paths) {
		const p = normalizePath(raw, cwd);
		if (!p) continue;
		if (seen.has(p)) {
			stats.droppedDuplicate++;
			continue;
		}
		seen.add(p);

		if (matchesAny(p, opts.excludePatterns)) {
			stats.droppedExcluded++;
			continue;
		}
		if (opts.dropMissing && !fs.exists(p)) {
			stats.droppedMissing++;
			continue;
		}
		kept.push(p);
	}

	// Sensitive paths are counted, and removed from the listing.
	const visible = kept.filter((p) => {
		if (matchesAny(p, opts.sensitivePatterns)) {
			stats.hiddenSensitive++;
			return false;
		}
		return true;
	});

	const limit = kind === "modified" ? opts.keepModified : opts.keepRead;
	if (visible.length <= limit) return visible;

	// Most recently touched first; paths with no stat go last.
	const ranked = visible
		.map((p) => ({ p, m: fs.mtimeMs(p) }))
		.sort((a, b) => (b.m ?? 0) - (a.m ?? 0) || a.p.localeCompare(b.p));
	return ranked.slice(0, limit).map((x) => x.p);
}

function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Pi's own block format (utils.js:66-77), just with shorter lists:
 *   \n\n<read-files>..</read-files>\n\n<modified-files>..</modified-files>
 */
export function renderNative(read: string[], modified: string[]): string {
	const sections: string[] = [];
	if (read.length > 0) sections.push(`<read-files>\n${[...read].sort().join("\n")}\n</read-files>`);
	if (modified.length > 0) sections.push(`<modified-files>\n${[...modified].sort().join("\n")}\n</modified-files>`);
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/** Skills-style index: counts + recent paths + a pointer to the tool. */
export function renderIndex(read: string[], modified: string[], stats: ListStats, recentCap = 12): string {
	const cap = Number.isSafeInteger(recentCap) && recentCap >= 0 ? recentCap : 12;
	const recentModified = modified.slice(0, cap);
	const recentRead = read.slice(0, cap);
	const lines: string[] = [];
	lines.push("<session_files>");
	lines.push(
		`  <modified total="${stats.modifiedTotal}" kept="${modified.length}" shown="${recentModified.length}" dropped_missing="${stats.droppedMissing}" dropped_excluded="${stats.droppedExcluded}" dropped_duplicate="${stats.droppedDuplicate}" hidden_sensitive="${stats.hiddenSensitive}"/>`,
	);
	lines.push(
		`  <read total="${stats.readTotal}" kept="${read.length}" shown="${recentRead.length}"/>`,
	);
	if (recentModified.length > 0) {
		lines.push("  <recent_modified>");
		for (const p of recentModified) lines.push(`    ${escapeXml(p)}`);
		lines.push("  </recent_modified>");
	}
	if (recentRead.length > 0) {
		lines.push("  <recent_read>");
		for (const p of recentRead) lines.push(`    ${escapeXml(p)}`);
		lines.push("  </recent_read>");
	}
	lines.push(
		"  <note>The full file inventory is not in context. Use the session_files tool to search it (session_files({query:\"nginx\"})); do not try to load the whole list.</note>",
	);
	lines.push("</session_files>");
	return `\n\n${lines.join("\n")}`;
}

export interface RewriteResult {
	summary: string;
	read: string[];
	modified: string[];
	stats: ListStats;
	changed: boolean;
}

/** Replace Pi's file blocks in a summary with the compact index. */
export function rewriteSummary(
	summary: string,
	opts: FileListOptions,
	cwd: string,
	fs: FsProbe = realFs,
): RewriteResult {
	if (!hasFileBlocks(summary)) return { summary, read: [], modified: [], stats: emptyStats(), changed: false };

	const { text, read: rawRead, modified: rawModified, blocks } = extractFileLists(summary);
	// A summary may merely *mention* the tags (e.g. the project's own notes about
	// compaction). Only real blocks count.
	if (rawRead.length === 0 && rawModified.length === 0) {
		return { summary, read: [], modified: [], stats: emptyStats(), changed: false };
	}
	const stats = emptyStats();
	stats.blocksFound = blocks;
	stats.readTotal = rawRead.length;
	stats.modifiedTotal = rawModified.length;
	stats.charsBefore = summary.length;

	// Modified wins when a path appears in both blocks.
	const modifiedSet = new Set(rawModified.map((p) => normalizePath(p, cwd)));
	const readDeduped: string[] = [];
	for (const p of rawRead) {
		if (modifiedSet.has(normalizePath(p, cwd))) {
			stats.droppedDuplicate++;
			continue;
		}
		readDeduped.push(p);
	}

	const modified = filterList(rawModified, "modified", opts, cwd, fs, stats);
	const read = filterList(readDeduped, "read", opts, cwd, fs, stats);
	stats.keptModified = modified.length;
	stats.keptRead = read.length;

	// An index only pays for itself when it is actually shorter. With few kept paths
	// (<= indexRecent) the header + lookup note make it LONGER than native (measured
	// +417 chars at 10 kept paths), so fall back rather than make context worse.
	const nativeBlock = renderNative(read, modified);
	const indexBlock = renderIndex(read, modified, stats, opts.indexRecent);
	const out = text + (opts.style === "index" && indexBlock.length <= nativeBlock.length ? indexBlock : nativeBlock);
	stats.charsAfter = out.length;
	// "changed" means the string actually differs, so re-running on already-trimmed
	// output is a no-op (the context hook relies on that to stay idempotent).
	return { summary: out, read, modified, stats, changed: out !== summary };
}

/** Pi's own token metric (compaction.js:198-219 uses chars/4). */
export function piTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
