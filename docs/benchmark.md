# Benchmark: what this actually saves

Everything below is either **measured** on real data or **modelled** from measured
parameters. Each number is labelled.

## Data source

One long-running real Pi session: 30,990 entries, 112 compaction entries
(101 produced by Pi's default path, 11 produced by this extension).

The session belongs to the author. It has been scrubbed from this repository: no session
id, no account name, no host name, no personal directory names. Aggregate counts are kept
because they are what makes the claim checkable. `npm run privacy` fails the build if any
of that comes back.

## 1. Pi's default growth — measured

For each of the 101 native compactions, the file-list bytes were extracted with the same
parser the extension uses.

| | value |
|---|---|
| smallest | 149 B |
| largest | 110,924 B (57.0% of that summary, ≈27,731 tokens) |
| paths in the largest | 821 read + 1,109 modified = 1,930 |
| fitted growth | **+1,108 B per compaction** |

Growth is linear in the number of compactions and has no ceiling.

## 2. With the extension — measured

| | value |
|---|---|
| file-list bytes in the newest hook-produced summary | 1,594 B (4.8% of the summary, ≈399 tokens) |
| paths kept | 38 |
| ceiling | `keepModified + keepRead` = 100 paths, independent of compaction count |

Archive side (what lands in the session file, not in context):

| | entries | paths | bytes |
|---|---|---|---|
| hook-produced (this extension) | 11 | 12,426 | 0.68 MB |
| Pi default | 101 | 127,622 | 7.28 MB |

The archive this extension writes is ~20× smaller than what Pi accumulates, because it
merges instead of re-inheriting.

## 3. 0.1.0 vs 0.2.0 — measured, same input

The last 6 hook-produced summaries were run through both versions side by side.

| compaction | input | 0.1.0 out | 0.2.0 out | paths kept 0.1.0 → 0.2.0 | complete blocks left 0.1.0 → 0.2.0 |
|---|---|---|---|---|---|
| #1 | 31,452 | 31,452 | 31,452 | 2 → 2 | 1 → 1 |
| #2 | 25,776 | 25,776 | 25,776 | 8 → 8 | 2 → 2 |
| #3 | 33,776 | 33,776 | 33,776 | 1 → 1 | 1 → 1 |
| #4 | 33,428 | 33,428 | 33,428 | 4 → 4 | 1 → 1 |
| #5 | 24,809 | 24,809 | 24,809 | 21 → 21 | 1 → 1 |
| #6 | 33,424 | 33,424 | **33,281** | 2 → **38** | **3 → 1** |

Five of six are byte-identical: no regression. Row #6 is the case 0.2.0 fixes.

**Read row #6 carefully.** 0.1.0 reports "2 paths kept" but the other 38 were still in
context — inside a complete block sitting in the narrative that 0.1.0 never looked at.
So 0.2.0 does not save tokens on this input; it moves 38 paths from an uncontrolled place
into one capped list, and removes the duplicate copy. Net −143 B.

## 4. Projection — modelled from measured parameters

Parameters, all measured:

- native growth: **+1,108 B per compaction** (fit over 101 entries)
- re-seeded block size: **1,594 B** (the observed one)
- re-seed frequency: **1 in 11** hook-produced compactions

| +N compactions | Pi default | 0.1.0 at observed rate | 0.1.0 worst case (re-seed every time) | 0.2.0 |
|---|---|---|---|---|
| 5 | 116,463 B (29,116 tok) | 2,319 B | 9,564 B | **1,594 B** |
| 10 | 122,002 B (30,501 tok) | 3,043 B | 17,534 B | **1,594 B** |
| 20 | 133,079 B (33,270 tok) | 4,492 B | 33,474 B | **1,594 B** |
| 40 | 155,234 B (38,809 tok) | 7,390 B | 65,354 B (16,339 tok) | **1,594 B** |

This is a model, not a measurement of the future. The 0.2.0 column is not a model: it is
the cap.

## 5. Runtime cost of the extension — measured

`node --experimental-strip-types`, 20–2000 iterations on a real 33 KB summary:

| path | time |
|---|---|
| cold (`rewriteSummary` with real `statSync` per path) | 0.43 ms |
| warm (cache hit: signature computation only) | 0.0002 ms |

A normal turn takes the warm path.

## 6. False positives — measured

Across all 112 real compactions, the narrative mentions the tags without a matching block
**141 times**. After 0.2.0 processing, **0 of those mentions were swallowed**.

The guard is structural: the regex requires the tag alone on its own line plus a matching
closing tag, so inline prose like "keep Pi's native `` `<read-files>` `` blocks" cannot
match.

## 7. Privacy effect — measured

Archived paths in the session file: **140,048**. Matching `sensitivePatterns`:
**1,643 (1.17%), 21 distinct paths** — credential-shaped file names, agent config files,
files inside a private directory.

Before 0.2.0 these were hidden from the prompt but written to disk. Since 0.2.0 they are
stripped from new archives. Existing entries are not rewritten.

## What is *not* measured

- Whether the next real compaction after upgrading behaves as projected — that needs a Pi
  restart plus a compaction. Check `details.fileListIndex.blocksFound` and `fromHook` on
  the newest entry.
- `style: "index"` with `tool: true` in production. The `indexRecent` cap was measured
  offline.
- Whether the self-check catches every future Pi change. No upgrade drill has been run.
- Cross-model behaviour of the summarizer's re-seeding habit. One session, one model.

## Reproduce it

```bash
# against your own session (read-only)
node scripts/bench.mjs
```

It prints the same sections: native growth, per-version comparison, projection, runtime
cost, false-positive count, archive sensitivity.
