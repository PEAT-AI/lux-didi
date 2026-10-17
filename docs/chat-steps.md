# Chat steps and partial answers

Text chat runs in two phases under one run budget (90 s):

- **ACQUIRE** (ends at 70 s, or after 4 model-to-tool rounds): the model calls tools, each call
  bounded by its own 15 s timeout. A call that outlives it is aborted and returns
  `{ status: 'failed', code: 'timeout' }`; it never hangs the round.
- **ANSWER**: at the fence every in-flight call is aborted and the evidence gathered so far is
  frozen. One tool-free model call answers from that evidence and says plainly what was not
  reached. If that call fails, the server writes the answer itself from the same evidence.

Gathered evidence is never discarded: it is persisted in `chat_runs.trace.toolEvidence` before
every model request, and the answer phase reads only that frozen copy.

## Step events

Step events are published on the existing chat subscription, one pair per tool call. They carry a
label and counts only, never tool content, and never the model's text.

```
{ type: "chat_step", runId, stepId, tool, phase: "start" | "end", label, resultCount?, ok?, ms? }
```

| field | meaning |
| --- | --- |
| `stepId` | stable id for one call, `${runId}:${n}`; the `end` event repeats it |
| `tool` | the tool name as the model called it |
| `phase` | `start` when the call begins, `end` when it settles |
| `label` | short human phrase from the server map in `server/chat/tools.ts` (`listed mail`) |
| `resultCount` | number of results, when known; omitted rather than guessed |
| `ok` | on `end` only: whether the call completed |
| `ms` | on `end` only: wall time of the call |

The final snapshot event of a run that hit the fence carries `partial: true` and
`notReached: [label, ...]` naming the calls the fence cut, so a client can show the answer as
provisional and list what was not reached.

## Timing receipts

`host.log` records one `chat_timing` receipt per run that answered or was fenced, validated by
`server/host/log.ts`, milliseconds and counts only and never text:

```
{ event: "chat_timing", runId, outcome: "answered" | "fenced",
  rounds: [modelMs, ...], tools: [{ tool, ok, ms }, ...],
  fenceMs, acquireMs, answerMs }
```

`fenceMs` is the wall time from run start to the end of acquisition; `acquireMs` and `answerMs` are the
budgets the run was given, so a receipt shows whether the fence cut the run early or the budget did.

## resultCount

Every `end` event carries `resultCount`: the number of result cards the tool's response yields, the
same `sourceCards` projection the owner evidence uses. A call that failed, was cut by the fence, or
whose response was refused by the result gate carries `0`.

## Intent surface (composition only, not yet declared)

`chatIntentTools` in `server/chat/tools.ts` composes the same five coarse intent declarations the Live
session declares (`INTENT_TOOL_NAMES`) from the shared `planIntent`, `intentResponse` and
`IntentDeclaration` helpers, runs each plan phase through a caller-supplied sub runner, and completes
one shaped digest under the intent's own journaled call, so one model call both searches and shapes.

It is not yet added to the chat declaration set. One instrumented run of the wired declaration ends the
run at status `error` with zero connector executions, and the root cause is outside this change's files:
the tools owner journals every call under exactly one connection scope, so a tool whose account and
resource belong to no connection cannot be journaled (`server/tools/index.ts:148`,
`if (matches.length !== 1) throw Error('intent_scope_mismatch')`, reached from
`journal.intent` inside `runToolCalls`). The Live session never hits this because it answers intent calls
in a host-side loop outside `runToolCalls` (`server/live/index.ts:1382`). Declaring the chat intent tools
therefore needs an owner-level synthetic scope for intent tools, or pre-journal interception in
`server/adapters/model/loop.ts`; both are outside this wagon's file scope. The builder's contract (five
names, one digest per call, fail closed when no intent is journaled) is covered by
`server/test/chat-tools.test.ts`.
