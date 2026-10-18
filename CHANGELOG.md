# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] - 2026-10-18

### Fixed
- Documentation only. The 0.2.0 tarball shipped the pre-release install section, which
  still said the npm package would be available "once … on the npm registry". 0.2.1
  carries the current install instructions (`pi install npm:@yeyudeh/pi-compaction-files`,
  with the git form as the alternative). No code changed between 0.2.0 and 0.2.1.

## [0.2.0] - 2026-10-18

### Added
- **Self-check on load** (`extensions/picheck.ts`). The extension depends on three Pi
  behaviours that are only partly documented. It now looks for the anchors in the
  installed Pi and logs a warning when one is missing, instead of silently doing
  nothing after a Pi upgrade. `piDistDir` overrides discovery;
  `PI_CODING_AGENT_DIST` is honoured.
- **Functional guard**: after a rewrite, if more than one complete block of a kind is
  still present, the extension logs a warning. This does not depend on Pi's source.
- **Archive desensitisation** (`archiveSensitive`, default `false`): paths matching
  `sensitivePatterns` are now stripped from the `details` archive as well as from the
  rendered list. Previously they were hidden from context but still written to the
  session file, where a future `session_files` tool could surface them.
- **Failure budget**: after 2 consecutive hook failures the extension stops trying for
  the rest of the Pi process and lets Pi handle compaction, instead of paying up to
  three summarisation calls every time.
- **`indexRecent` cap** (default 12) for `style: "index"`. Without it an index is
  *longer* than native output when many paths are kept (measured: +506 chars at
  kept=38); with it the index is 854 chars shorter than the input.
- **`style: "index"` falls back to `native` when the index would not be shorter.** With
  few kept paths (at or below `indexRecent`) the header and lookup note make an index
  longer than native — measured +417 chars at 10 kept paths. The index is an
  optimisation, so it is only used when it actually pays. The `session_files` tool keeps
  working either way: it reads the archived inventory, not the rendered block.
- `blocksFound` in the stats and in `details.fileListIndex`, so you can see whether the
  summarizer re-seeded an old block.
- Test suite `test/plugin-load.mjs`: loads the extension against a mocked Pi
  `compact()` and a throwaway `HOME`, so the whole hook chain is exercised with no
  model call and no read of the developer's own config.

### Changed
- User-facing strings (the `/filelist` output, log messages, the `session_files` tool
  description) are English.
- **All complete file blocks are stripped, not only the trailing one.** Pi appends the
  real block at the end, but the summarizer can reproduce an earlier block inside the
  narrative (measured: a 1,594 B / 38-path copy mid-summary while the real block sat at
  the end). The old "take the last match" behaviour left that copy in context on every
  turn and re-seeded the growth this extension exists to stop.
- Per-model memory of which completion path works, so the fallback is not re-probed on
  every compaction (steady state: one summarisation call, not two).
- `/filelist` now prints the self-check result, `archiveSensitive`, `indexRecent` and
  the current failure streak.

### Fixed
- `test/harness.mjs` crashed with `RangeError: Invalid count value` when a rewrite made
  the summary longer (`String.repeat` with a negative count).
- Test assertions that were wrong for an already-clean session (they demanded
  `changed === true` and derived the "list region" by tag position, which matched
  narrative mentions of the tags instead of real blocks).

## [0.1.0] - 2026-10-15

### Added
- `session_before_compact` handler that calls Pi's own `compact()` and then shortens the
  file blocks in the returned summary. Because the result comes from a hook, Pi records
  `fromHook: true` and stops inheriting the previous lists (documented in
  `docs/compaction.md`, "Cumulative File Tracking").
- `context` handler that rewrites an already-stored compaction summary in place on every
  turn, so an existing bloated session shrinks immediately without touching the session
  file.
- Path filtering: drop paths that no longer exist, drop temp patterns (`/tmp/`,
  `/dev/shm/`, `/node_modules/`, `/.cache/`, `/proc/`, `/sys/`), dedupe relative vs
  absolute forms, count and hide sensitive-shaped paths, keep the N most recently
  touched.
- Two render styles: `native` (Pi's own block format, shorter) and `index`
  (a `<session_files>` index).
- `session_files` lookup tool (opt-in, `tool: true`) and a `/filelist` status command.
- Offline test harness for the pure logic.
