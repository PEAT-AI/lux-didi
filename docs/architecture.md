# Architecture

How Lux Didi works at release 10. File names are given so each claim can be checked; line numbers are not, because they move. This page describes today's behaviour only; the planning documents are under [history/](history/README.md).

## Shape

```text
              voice provider (OpenAI GPT-Live by default, Gemini Live by choice)
                         ^
                         | one audio-and-text socket per call, opened by the host
                         |
 +-----------------------+------------------------------------------+
 | Host (Node 26, server/)   loopback only, single SQLite writer     |
 |  live/ call core + journal      tools/ research layer, open, vault |
 |  chat/ text conversation        connectors/ Lux Knowledge, Gmail,  |
 |  domain/ + runtime/ store       Calendar, Mattermost, Mongoose     |
 |  prompt/ persona + context      host/ wiring, logs, supervision    |
 +-----------------------+------------------------------------------+
        ^ HTTP + one WebSocket (loopback, private credential)    ^ serves
        |                                                        |
 +------+------------------------+          +--------------------+---+
 | Mac app (Swift, Sources/LuxDidi) |          | Web UI (TypeScript, web/) |
 |  orb, window, mic, speaker, keys |          |  orb, conversation,      |
 |  presence machine, host watcher  |          |  memory, settings        |
 +---------------------------------+          +--------------------------+
```

Three ownership rules explain most of the code:

1. **The host is the single writer.** Every record (notes, memory, commitments, the call journal, the trace) is written by the host through one SQLite connection with one writer lock. Neither the app nor the web UI writes a record.
2. **The app owns audio.** `AudioOwner.swift` is the only place that opens the microphone or the speaker. The host never touches audio hardware and the web UI never plays.
3. **The web UI is presentation.** It renders state the host publishes and posts intents the host validates. It holds no records and survives a reload with nothing lost.

## Processes at runtime

1. macOS starts the app through LaunchServices. `SingleInstanceGuard.swift` decides the launch kind: `interactive` (the owner opened it, maybe from the Dock), `loginItem`, `installRelaunch`, `reopen` (a Dock click while running), and the proof kinds. Only `interactive` brings the app to the front and only it connects by itself.
2. The app starts the host as its own child through `NativeServiceSupervisor.swift`: the bundled node binary, `server/dist/host/index.js --supervised`, with the app's environment.
3. The supervisor writes one bounded JSON line on the child's stdin (`type: start`, a nonce, the schema version). The host answers with exactly one ready frame (`type`, `schemaVersion`, `nonce`, `pid`, `origin`, `authorityEpoch`, `assistantId`); any other byte, or a second line, fails the start. The nonce is how the app knows the host it talks to is the one it started.
4. The supervisor reads `admin-credential`, the owner-only file the host writes in its data directory on first start, and from then on every request carries it. The credential never appears in a command line, an environment variable or a log line.
5. The host closes when its stdin reaches EOF, so the app's exit is the host's exit. There is no orphan daemon.
6. A host started by hand (`node server/dist/host/index.js`, or `bash scripts/run-local.sh`) is the same program without the supervised contract: it prints its origin and runs in the foreground.

## The host

Entry and flags: `host/index.ts`. `--data-dir`, `--web-root`, `--port`, `--descriptor`, `--config-dir`, `--owner-profile`, `--supervised`, and the `pair` and `--mongoose-login` subcommands. The environment mirrors three of them (`DIDI_STATE_DIR`, `DIDI_WEB_ROOT`, `DIDI_PORT`); every other setting is a flag or a file.

| Area | Where | Job |
| --- | --- | --- |
| Store | `runtime/`, `domain/` | SQLite through `node:sqlite`. Notes, memory, commitments, the trace spine, the call journal. One writer, private files. Migrations are owned per domain, and [domain-contract.md](domain-contract.md) lists the tables. |
| Text chat | `chat/` | The connected text conversation: consent, steps, partial answers, selected memory. See [text-chat.md](text-chat.md). |
| Live call core | `live/` | One call at a time: lifecycle, the journal of finalized transcripts, timers, reconnect with resumption, mute, the stop gate, the debt clock. See [live-call.md](live-call.md). |
| Voice providers | `adapters/live-voice/` | `openai.ts` (GPT-Live, the default) and `gemini.ts`. Both implement one `LiveVoicePort`; the checked union is `liveVoiceProviders`. |
| Prompt | `prompt/` | The public persona, the runtime context (clock, timezone, connected sources), the opening line, and the composition of the instruction sections. See [prompt-composition.md](prompt-composition.md). |
| Tools and research | `tools/` | What the model may call, and the research layer that answers one ask in one turn. See [tool-owner.md](tool-owner.md). |
| Connectors | `connectors/` | Lux Knowledge, Google (Gmail and Calendar), Mattermost and Mongoose, each a descriptor over MCP. Mongoose is three separate endpoints (knowledge, data, CRM) with three separate sign-ins, and the admin endpoint is never connected. See [connectors.md](connectors.md). |
| Host wiring | `host/` | Flags, supervision, the local HTTP server, the WebSocket upgrade, the logs, the config mounts. |
| Config | `config/` | The protected profile: `live.json`, the MCP profile, credentials, route classes. See [provider-configuration.md](provider-configuration.md) and [mcp-configuration.md](mcp-configuration.md). |

## One call, end to end

1. **Start.** A tap of the orb, a bare Right Command tap, the menu's Start Live, or the one auto-connect of an interactive launch moves presence from `cold` to `connecting`. The app asks the host for a Live session; the host composes the session grant: provider, model, voice, key reference, permitted data classes and the chosen input class (`live_grants`).
2. **Grants.** The tool table for the session is composed from the definitions the tool owner accepts for this session's connection ids and allowed data classes, and the acceptance is frozen with a sha256 (`snapshotRun`). The model is advertised only the tools that grant allows; a calendar read is never advertised when the connection grants only the calendar-list sibling.
3. **Opening.** Naya opens every new call with one short line of her own, drawn from the stored record (the last session's opening, not the calendar twice in a row). The opener is composed before the first audio and does not wait on a connector beyond its bound.
4. **Conversation.** The app streams microphone frames up; the host forwards them to the provider and streams audio and transcripts back. Only finalized owner turns reach the journal; interim transcription is used for the stop gate and dropped.
5. **The stop gate.** Every transcription fragment, interim or final, is normalized and matched against the stop phrases (`live/stop-phrase.ts`) inside a ten-word rolling window that resets after three seconds of no input. A phrase inside a sentence matches; a bare "stop" needs one of her names in the same window; a negated or quoted phrase ("do not stop listening", "she said stop now") does not. Her names have a three second grace, so a name and a phrase split across a pause still match. The German phrases match the same way.
6. **The priority terminal frame.** A matched voice stop (`voice_stop`) and an owner stop (`user_stop`) are the only two terminals that outrank queued output: the socket closes at once and queued speech is dropped. Every other terminal drains the queue first and is sent after it, because a settled answer is worth more than a fast close. GPT-Live has no `response.cancel`, so the stop purges held playback and closes the provider session instead of cancelling a response.
7. **Mute.** `live` to `hotMuted`: capture stops at once, and the response watchdog and the idle clock are suspended. An answer that arrives while muted is never played; its audio is dropped and the unmute offers it in one sentence, and a response that began under the mute is dropped until its turn ends. A tap resumes.
8. **Reconnect.** If the provider drops, the host retries with backoff (0, 2, 4, 8, then 8 s) and resumes with the provider's handle, inside the call's own generation, so a stale attempt can never speak into a newer call.
9. **Dead air.** A tool output creates a debt: the model owes an answer. The audible debt clock is non-sliding. It starts when the write for the answer succeeds, when a continuation is sent, or when the owner's turn closes with no call pending; it stops when audio becomes audible. It is not reset by progress that the owner cannot hear, which is the point: the receipt (`live_dead_air`) names the turn's age, whether any audio arrived, and the inaudible milliseconds.
10. **End.** One path for every cause: the menu or the orb's Stop, a voice stop, the idle limit, the call limit, a provider-terminal error, or app exit. The microphone stops, the provider session closes, the journal stores the terminal reason, and presence returns to `cold`. The orb stays.
11. **After.** The host distils the finished call into a private conversation summary off the request path. The journal keeps finalized transcripts; the summary is what a later call reads first.

Timer defaults live in `adapters/live-voice/types.ts` and `live/config.ts`, and the owner's `live.json` may change them: a 1 hour provider session, a 5 minute idle limit and a 4 hour call limit unless the profile says otherwise.

## One question, end to end

1. The model calls a typed tool (`search`, a mail or calendar read, a chat read, an attention scan, a brief, memory search, remember, vault save, a web read, open). The tool layer validates the argument shape at the boundary and refuses an unusable one with a one-try guidance line.
2. The research layer routes the ask to the sources that can answer it (`tools/research.ts`) and runs those reads in parallel. One table owns every bound: 12 s for a connector read (knowledge, mail, calendar, chat, Mongoose), 8 s for the in-process memory read, 4 s for a web read, and a whole call of the slowest source it reads plus slack, never past its cap. At 4.5 s the host answers with what it has while the slow readers keep running to their own deadlines, and each one that settles later is reported once. A progress line keeps dead air under 3 s.
3. Every reply opens with a coverage header, always: one line that says, per source, what came back and what did not, with a status word for each (completed with findings, completed with nothing relevant, not configured, unavailable, refused). The header sits outside the prose envelope and has its own budget, so the trim that keeps a reply inside its limit can never take away the line that says what was searched.
4. The reply is allocated in two passes. The floor first: one whole finding line per source that returned a hit, so a capped reply never hides a source. Then proportional fill, which takes from the source furthest above its share of the room. Only when even the floor overruns is a line clipped, at a word boundary.
5. A triage ask ("anything important in mail?", "what came in?") is not a keyword search. It runs one fixed read per source: the unread inbox of the last two days, newest first, with promotions, social and forum mail excluded; the chat read covers mentions and replies of the last seven days; the calendar read covers the day named in the ask. When a triage ask and a topic both apply, the triage ask wins, and an empty window says so instead of "nothing matched".
6. The evidence freeze: the result the model sees is the locally accepted projection of the accepted result (`tools/<id>.ts`), never raw MCP content. A weak knowledge match travels as a confidence field and is voiced as "nothing matched", never as raw ranker text.
7. The journal keeps the run: which sources were searched, what each returned, what was dropped and why. The debugger reads the same record through [debugging.md](debugging.md).

## Presence

Four states, one machine (`NativePresence.swift`), shared by Right Command, the orb click and the window's mic control:

| State | Meaning | Orb |
| --- | --- | --- |
| `cold` | No call. The orb is still there. A tap starts one. | grey, dim, silent |
| `connecting` | A call is opening. Nothing is captured until the provider is ready. A tap cancels. | grey with motion |
| `live` | Microphone open, conversation running. A tap mutes. | colour follows her state |
| `hotMuted` | Call stays open, capture closed, queued speech dropped. A tap resumes. | purple |

A trigger names what moved the machine: `hotkey`, `click`, `app`, `timer`, `sleep`, `error`, `voice`. Every move leaves a content-free presence receipt (state, trigger, source) in the host log, so a missing orb can be explained after the fact.

## Where the data is

| Path | Holds |
| --- | --- |
| `~/Library/Application Support/ai.peat.lux-didi/` | The installed app's state: `state.sqlite`, `admin-credential` (owner-only), `logs/host.log`, `logs/native-live.log`, `logs/audio.log` |
| `~/Library/Application Support/ai.peat.lux-didi-operator/settings.json` | The selected config directory (`--configure`) |
| the selected config directory | `live.json`, the MCP profile, the credential records (owner-only) |
| `~/Library/Application Support/Lux Didi/` | A host started by hand without `--data-dir`, the same layout |

`--data-dir` or `DIDI_STATE_DIR` overrides the development directory. [debugging.md](debugging.md) says what each file holds and how to read it; [diagnostic-store.md](diagnostic-store.md) has the query recipes.

## The boundaries

What the code deliberately does not do:

- No writing into a connected account. Every connector is read only, and the only write outside her own store is a vault note the owner dictated.
- No background reading. A source is read inside a turn the owner started; nothing polls an account.
- No audio outside `AudioOwner`. The host forwards frames; it never opens a device.
- No credentials in the repository, in a log line, in a command line or in an environment variable. Credentials live in owner-only records and are redacted by construction in the log layer: enums, counts and timings only.
- No silent failure. A source that could not be read says so in the coverage header; a check that cannot run prints a blocked line and exits non-zero.
- No hosted CI, no notarization, no multi-user support. It is one owner on one Mac.

## Reading order

| You are touching | Read first |
| --- | --- |
| the local service, its wire contract or its packaging | [service.md](service.md) |
| the text conversation | [text-chat.md](text-chat.md) |
| a live call or a voice provider | [live-call.md](live-call.md), then [provider-configuration.md](provider-configuration.md) |
| the Swift app | [native-app.md](native-app.md), then [mac-experience.md](mac-experience.md) |
| the store or the tables | [domain-contract.md](domain-contract.md) |
| selected memory | [selected-memory.md](selected-memory.md) |
| the prompt or the persona | [prompt-composition.md](prompt-composition.md), [tool-owner.md](tool-owner.md) |
| a source of data | [connectors.md](connectors.md), [mcp-configuration.md](mcp-configuration.md) |
| the checks or a release | [checks.md](checks.md), [releases.md](releases.md) |
