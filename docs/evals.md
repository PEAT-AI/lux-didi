# Evals

Three tiers, by what they can catch and what they cost. Tier 1 is the live-boundary harness in the parallel
C-EVALS lane; this document covers tiers 2 and 3 and the honesty probes that keep all three honest.

Nothing in any tier makes a paid model call on its own. The default of every script is a dry run or a fake,
and the one mode that could spend money refuses to start without the owner's price confirmation.

## Tier 1: the live-boundary harness

Out of scope here and built in the C-EVALS lane: the harness that puts the real provider boundary under a
recorded conversation and the phrasing corpus that names what the assistant says. Read its own document.

## Tier 2: the release runner

`scripts/eval-release.sh` drives the production realtime adapter (`server/adapters/live-voice/openai.ts`) in text
mode against the eval harness's fake world and fake connectors (`server/eval/world.ts`, `server/eval/tool-map.json`),
with synthetic owner turns from a scenario file.

| Mode | What it does | Cost |
| --- | --- | --- |
| `--dry-run` | prints the call plan, the token estimate per scenario and the total price; opens no socket | nothing |
| `--fake-model` | replays the committed synthetic model turns through the real adapter over a loopback socket | nothing |
| `--real --confirm-price <usd>` | the owner's priced run against the provider | real money, gated |

A scenario is one conversation: `server/test/eval-release/scenarios/release.jsonl`, one JSON line each, with the
owner turns as the fragments a transcript delivers. Two fragments in one turn is a split final and is sent as one
ask, because that is what a transcript split means; a second turn is how a clarify answer arrives.

Scoring has two halves:

- Deterministic. The dispatched tool calls and their arguments must match the scenario's expectation, in order,
  with no extra call. A missing call, a wrong call, an argument mismatch, a forbidden spoken phrase or a missing
  required phrase each fail the scenario by name.
- The claims judge. `server/test/eval-release/judge-prompt.md` is the rubric: a claim of done, empty or sent with
  no matching receipt. `judge.ts` applies the same rubric by rule in the free modes, and `judgeRequest` is what the
  priced path sends a judge model.

### The price gate

`config/eval-rates.json` is the owner's rates table, and it ships with `UNSET` placeholders. `UNSET` is never read
as zero: while any rate is unset the estimate prints as `UNSET` with the field names to fill, and a real run
refuses. With rates filled, a real run also refuses unless `--confirm-price <usd>` is within 20 percent of the
estimate. `UNSET` is not a number, so no arithmetic can turn it into a cheap-looking total.

## Tier 2b: the synthetic audio probe

`scripts/eval-audio-probe.sh` feeds a short synthetic utterance through the same adapter's upload path and counts
the provider's spoken frames while dropping them. It opens no audio device and plays nothing.

- Dry run: the utterance, its size and rate, the chunk plan.
- `--fake-model`: uploads the utterance in chunks and replays a recorded synthetic provider turn.
- `--say`: builds the utterance with the macOS `say` command into a file under the git-ignored
  `server/eval-out/audio` and never plays it. The file is read as bare PCM16, with a WAV header skipped.

The default utterance is generated in code (a short tone at 24 kHz), so the probe needs no fixture and no voice.

## Tier 3: the post-call auto-review

`scripts/didi-postcall-review` and `server/trace/postcall.ts` review one finished call from metadata only:
`<dataDir>/logs/host.log`, whose events are already closed shapes (a tool name, a closed code, a count, a
duration).

| Finding | Where it comes from |
| --- | --- |
| refusal, by layer and code | `live_tool_refused` (host), `tool_call_outcome` refused or blocked (dispatch), `tool_classified_failure` (connector) |
| tool failure | `tool_call_outcome` with a failed, timeout, aborted or cancelled outcome |
| claim without a receipt | `live_claim_without_call` |
| dead air | `live_dead_air` over 4 s |
| reconnect | `live_recovery` |
| turn with no provider audio | `live_turn_open` |

For each class it finds, the review writes a draft synthetic fixture into a local, git-ignored folder
(`server/eval-out/postcall` by default, or `<dataDir>/postcall` from the host). A draft carries the class, the
tool name, the layer and code, a count and a timing value. It has no text field, so there is no field an owner's
words could arrive in, and the reader drops every key it does not recognise before it looks at an event.

The host calls the same review from the existing session-terminal hook, behind `DIDI_POSTCALL_REVIEW=1`. The
setting is unset by default: with it unset the hook returns immediately, and a review never fails a call that has
already ended.

## Honesty probes

An eval suite that cannot fail is worse than no suite. Three probes guard against that.

**Mutation probe (a).** `scripts/eval-mutation-probe.sh` applies one known mutation at a time from
`server/test/eval-release/mutations.json` to a temp copy of the compiled harness and asserts the eval self-test
fails for each: the schema normalizer skipped, the claim guard dropped, a claimed draft with nothing in the store,
a spoken frame routed to an audible sink, an unmapped tool dispatched instead of refused. A mutation whose anchor
no longer applies is a probe failure, never a pass, so the probe cannot go green because the guarded code moved.

**Red at base (b).** `scripts/red-at-base.sh --base <sha> --test <file>` copies a named test into a detached
worktree at the base commit, compiles it with that tree's own tsconfig and runs only that test. Green there means
the test proves nothing about this wagon, and the script says so. For a wagon of new modules the red is usually
that the module does not exist at base; the script prints that as the reason.

**Fixture immutability (c).** Fixtures under `server/test/fixtures/regressions/` carry a provenance header
(`source_finding`, `date`, and `synthetic`) and a sha256 in `provenance-manifest.json`. An edit that changes the
file without a `provenance.ruling` line fails the eval check, in `server/test/eval-release/regressions.test.ts`.

## Simulated, and unsupported

Simulated, faithfully:

- The provider wire. The fake provider speaks the provider's own frames over a loopback socket into the production
  adapter, so tool calls, continuations, transcript deltas and turn-taking are the real ones.
- The world. Dates, mail, chat, drive, transcripts, alarms and the tool map are the eval harness's fakes, and the
  alarm path runs the production scheduler on a virtual clock.
- Time. Scenarios pin `clock_T0` and a timezone, so "tomorrow" means one thing.

Unsupported, and never claimed:

- Native OS events. A microphone permission dialog, an audio route change (Bluetooth, headphones), device sleep or
  a system notification are outside the provider wire and the fake world. The audio probe proves the upload and
  playback-drop path, not that a real device opened. Tests that need a native event stay unsupported rather than
  simulated, because a fake of an OS callback would prove only the fake.
- Real network conditions. Latency, packet loss and provider rate limits are not modelled; the adapter's own
  timers are driven by a real clock in these runs.
- Model quality. The fake modes prove the harness, the gates and the scoring. They say nothing about how well the
  model answers, which is what the priced run and tier 1 are for.

## Running it

```sh
scripts/eval-release.sh --dry-run          # the plan and the price, no socket
scripts/eval-release.sh --fake-model       # the free end-to-end run
scripts/eval-audio-probe.sh                # the audio plan
scripts/eval-audio-probe.sh --fake-model   # the free audio run
scripts/didi-postcall-review --session <id>  # review one finished call by hand
scripts/eval-mutation-probe.sh             # every mutation must be caught
scripts/check-evals.sh                     # the eval check: self-test, release suite, post-call review, probes
```
