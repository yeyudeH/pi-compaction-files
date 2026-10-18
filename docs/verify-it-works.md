# Does it work on *my* machine? A 10-minute check

This is the tutorial the author wishes existed. It answers three questions with evidence
instead of vibes.

## 0. Before you install: measure what you are paying

Find your session file:

```bash
ls -lt ~/.pi/agent/sessions/*/*.jsonl | head -5
```

The top one is the session you are in right now (unless you have several open).

Now look at what the file lists cost in your newest compaction:

```bash
SESSION=$(ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1)
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
let last=null;
for(const l of lines){let e;try{e=JSON.parse(l)}catch{continue} if(e.type==="compaction")last=e;}
if(!last){console.log("这个会话还没有压缩过，看不出效果。用久一点再来。");process.exit(0)}
const s=last.summary||"";
const RE=/<read-files>\n[\s\S]*?\n<\/read-files>|<modified-files>\n[\s\S]*?\n<\/modified-files>/g;
const blocks=[...s.matchAll(RE)];
const bytes=blocks.reduce((a,b)=>a+b[0].length,0);
const paths=blocks.reduce((a,b)=>a+b[1].split("\n").filter(x=>x.trim()).length,0);
console.log(`最新摘要 ${s.length} B，其中文件清单 ${bytes} B（${(100*bytes/s.length).toFixed(1)}%），共 ${paths} 条`);
console.log(`每轮固定成本 ≈ ${Math.ceil(bytes/4)} token`);
console.log(`块数 ${blocks.length}（>2 说明有旧块被抄进了正文）`);
' "$SESSION"
```

Write the number down. On a session that has compacted a few dozen times you should see
something in the tens of kilobytes.

## 1. Install and restart

```bash
pi install npm:@yeyudeh/pi-compaction-files
# or: pi install git:github.com/yeyudeH/pi-compaction-files
```

**Restart Pi.** Extensions load at process start; installing does not affect the running
process.

## 2. Confirm it loaded and self-checked

Inside Pi, run:

```
/filelist
```

What you want to see:

```
enabled=true style=native keepModified=60 keepRead=40 dropMissing=true
archiveSensitive=false tool=false indexRecent=12 failStreak=0/2
pi-self-check=ok dist=/…/@earendil-works/pi-coding-agent/dist
  ok: compaction.js: fromHook inheritance guard present
  ok: session-manager.js: fromHook persisted on compaction entries
  ok: compaction/utils.js + compaction.js: still emits read-files/modified-files blocks
  ok: compaction.js: details field still carried
```

If you see `pi-self-check=PROBLEM` with a `MISSING:` line, your Pi version changed one of
the behaviours this extension relies on. It still runs, but it may not be helping. Open an
issue with that output.

If the command does not exist at all, the package did not load — check
`pi list` and whether the source is in `~/.pi/agent/settings.json`.

## 3. Confirm the stored summary shrank immediately

Re-run the measurement from step 0. The stored summary in the session file is unchanged
(the extension never rewrites your file), but the version sent to the model is rewritten
in memory every turn. To see the rewritten version, run the extension's own parser over
your session:

```bash
PI_TEST_SESSION="$SESSION" node scripts/bench.mjs
```

Look at section 【6b】: it prints the stored size and the size after processing.

## 4. Confirm the next compaction is taken over

After the session compacts again (Pi does it automatically near the context limit, or you
can run `/compact`), check the newest entry:

```bash
SESSION=$(ls -t ~/.pi/agent/sessions/*/*.jsonl | head -1)
node -e '
const fs=require("fs");
const lines=fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean);
let last=null;
for(const l of lines){let e;try{e=JSON.parse(l)}catch{continue} if(e.type==="compaction")last=e;}
console.log("fromHook:", last.fromHook);
console.log("fileListIndex:", JSON.stringify(last.details?.fileListIndex ?? "没有（说明这次不是本扩展产出的）"));
' "$SESSION"
```

You want `fromHook: true` and a `fileListIndex` object. `blocksFound` tells you whether the
summarizer re-seeded an old block during that compaction — if it is greater than 2, the
extension caught and merged one that Pi would have left in context.

## 5. Full benchmark on your own data

```bash
PI_TEST_SESSION="$SESSION" node scripts/bench.mjs
```

It prints:

1. what Pi's native entries actually cost in your session, and the fitted growth per step
2. 0.1.0 vs 0.2.0 side by side on your last 6 hook-produced summaries
3. how many paths each version keeps in context
4. how many sensitive-shaped paths are sitting in your archived `details`
5. the extension's own per-turn cost on your data
6. a projection with *your* measured parameters
7. how many narrative tag mentions exist and how many were swallowed

The script is read-only. It never writes to the session file.

## 6. If you want the full inventory back

The default caps the list at 60 modified + 40 read paths and drops dead ones. If you want
to be able to search the complete inventory:

```json
{
  "style": "index",
  "tool": true,
  "archiveSensitive": true,
  "indexRecent": 12
}
```

Then the model can call `session_files({ query: "nginx" })` instead of carrying the list.

Understand the trade: `archiveSensitive: true` writes every path — including
credential-shaped ones — into your session file on disk. The default is `false` for that
reason.

## 7. Turning it off

```bash
# one run
PI_FILELIST_DISABLE=1 pi

# permanently
pi remove @yeyudeh/pi-compaction-files
```

Nothing needs cleaning up afterwards. The extension never modified your session file, and
summaries it produced are ordinary Pi compaction entries.
