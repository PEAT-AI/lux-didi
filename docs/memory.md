# The memory test

`scripts/didi-memory-eval` answers one question before every release: what did the
memory actually do for him, and what did he hear first?

It runs offline, with no human in the loop, on a copy of the store. It scores the
**first answer**, never the eventual recovery: a call that says "I don't have
anything about that" and finds it two turns later has failed this test.

`bash scripts/check-memory-eval.sh` is the release check. It builds the service
and runs `server/test/memory-eval.test.ts` on a synthetic fixture in under a
minute. It never reads the owner's store, never starts the app and never calls a
model.

## Running it on a store copy

```
bash scripts/run-local.sh --build-only
scripts/didi-memory-eval --store <copy-dir> --golden <golden.jsonl> --out <report.json> \
    [--answers <recorded-first-answers.json>] [--strict] [--data-dir <copy-dir>] \
    [--verifier <openai-model>] [--time-zone <zone>]
```

- `--store` (or `--data-dir`) names a directory that contains a `state.sqlite`
  copy. The harness opens it read-only through a transaction that refuses every
  write, so a harness bug cannot edit what it scores. The copy is made outside
  the harness, before the run; on a copy the repository stays clean.
- `--golden` names a golden item file **outside** the repository. It is one JSON
  object per line: `id`, `class`, `query`, `eval_at` (local ISO with offset),
  `cutoff_session`, `gold_turn_ids`, `required`, `forbidden`,
  `expect_in_start_block`, `expect_search`, `expect_abstain`, `notes`.
- `--answers` replays recorded first answers (a `recorded-first-answers` JSON
  file). Without it the first-answer and latency stages report
  `not_run: no_runner`; nothing is invented to fill the gap.
- `--strict` counts a `not_run` stage as a miss. The release check does not use
  it while the restore tool and the live first-answer runner are absent.
- `--verifier <openai-model>` opts into one structured grading call at
  temperature 0 for an item whose substrings did not match. It needs
  `OPENAI_API_KEY` and refuses to run without it. Offline nothing is verified by
  a model, and a verifier error (transport, shape or empty answer) is a failed
  item, never a pass.

Exit code: `0` all bars met, `1` a bar missed, `2` a usage or build error.

## What it scores

Per item, the classes are: 1 durable facts and preferences, 2 episodic paraphrase,
3 dated plans and open questions, 4 corrections and supersession, 5 cross-call
continuity, 6 false premise and abstention, 7 conversation identification and
restore.

1. **The cutoff.** Derived memory is restricted to sessions that ended at or
   before `cutoff_session`: summaries by their end time, entries by their parent
   session's end time, and the history search window ends at that call. A later
   call never leaks backward.
2. **The start block.** With a fake clock at `eval_at`, the memories and the
   earlier-conversations section are compiled through the same composition a live
   start uses, and `required` and `forbidden` are checked there when
   `expect_in_start_block` is set. The store copy is not written; only a block is
   built.
3. **Retrieval.** The existing history reader (`server/domain/history-reader.ts`)
   runs on `query` and the top 5 hits are recorded. The reader answers at session
   granularity, so recall@5 is scored as the share of gold turns whose session a
   top-5 hit reached.
4. **The first answer.** When a runner is configured, the recorded answer's text
   is graded against `required` and `forbidden`, and `expect_search` demands that
   a search ran. A denial with no search is the `denial_before_search` miss. On
   base there is no live runner, so a golden item with no recorded answer reports
   `not_run: no_runner`.
5. **Class 7 restore.** The restore tool is not registered on base, so every
   class 7 item reports `not_run: tool_missing`.
6. **Latency.** Final audio to first audio is recorded when a runner supplied it,
   as p50 and p90.

## The bars

All constants live in `BARS` in `server/memory/eval-runner.ts`, so the owner
confirms them in one place.

| bar | value | meaning |
| --- | --- | --- |
| on-demand correctness, overall | 0.95 | share of scored first answers with no miss |
| on-demand correctness, per class | 0.90 | the same, per class with at least one scored item |
| start coverage | 0.90 | share of start-block items with no miss |
| clock and date errors | 0 | a class 3 item with a miss is a date error |
| false memory | 0 | any `forbidden` string present in a scored stage |
| corrections | all green | no miss among class 4 items |
| restore | all green | no miss among class 7 items |

A stage that reports `not_run` leaves the denominator; `--strict` turns it into a
miss instead.

## The synthetic fixture

`server/test/fixtures/memory-eval/` holds ten synthetic calls and twelve golden
items covering every class. Two defects are planted on purpose: the live-03
summary leaks a stale landline number into the start block, and the recorded
first answer to the plumber question denies before the search ran. The `clean`
variant repairs exactly those two, so one run must close the gate and name both
misses while the other passes every bar.

Nothing in the fixture is real: every name, number and address is invented. The
private golden set lives outside the repository and plugs in through `--golden`;
it is never committed.
