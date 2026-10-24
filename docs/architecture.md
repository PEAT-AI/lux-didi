# Architecture

How Lux Didi works at release 7. File names are given so each claim can be checked; a line number is not, because they move.

## The shape in one picture

```text
              voice provider (OpenAI GPT-Live or Gemini Live, over the internet)
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
 | Mac app (Swift, Sources/LuxDidi) |  hosts  | Web UI (web/, TypeScript) |
 |  presence machine, menu bar,     +-------->|  orb, conversation,       |
 |  orb panel, window, audio owner, | web view|  memory, settings         |
 |  hotkeys, host supervisor        |         +---------------------------+
 +----------------------------------+
```

Rules that hold everywhere:

- Everything between app, host and web UI is loopback. The host is the only writer of the database (`state.sqlite`); the app and the web UI keep no private records.
- The app owns the microphone and the speaker. The host never touches audio devices. Audio crosses the local socket as frames.
- The web UI is one codebase shown in two places: the full window and the orb panel. There is no second native UI for business screens.
- The host prints nothing on stdout except the supervision protocol (`writeProtocolFrame` in `server/host/index.ts`); `scripts/check-host.sh` fails on any `console.log` in server source.

## Native layer: `Sources/LuxDidi`

| Part | Files | Job |
| --- | --- | --- |
| Launch kind | `SingleInstanceGuard.swift` | Decides what a start may do. `interactive` (owner opened the app): shows the orb and connects once, by itself. `loginItem`: shows the orb, never connects. `installRelaunch` (`--install-relaunch`): shows the orb, never connects. `installedProof`, `selfCheck`, `uiProof`, `verification`: proof launches that host a window and never connect. A second instance yields. |
| Presence machine | `NativePresence.swift` | One state machine for "is Naya listening", shared by Right Command, the orb click and the window's mic control. See states below. |
| Surfaces | `PresentationCoordinator.swift`, `NativeMiniOrb.swift`, `LuxDidiApp.swift` | The orb (MINI) and the window (FULL) are independent and can be shown at the same time. The orb is the resting surface and defaults to the top right under the menu bar clock; its saved position is clamped back onto a connected screen. The window is created the first time it is asked for, from the menu or a shortcut. Switching surfaces never starts or ends a call. |
| Keys | `SingleKeyTrigger.swift`, `NativeShortcuts.swift` | Right Command bare tap drives the presence machine (held or chorded presses do nothing; needs the Input Monitoring grant). Global hotkeys (Carbon): Control Option Space and Control Option Shift Space both toggle the full window, Control Option Shift L starts Live, Control Option Shift M mutes. `NativeShortcuts.swift` also registers a second Control Option Space for the orb pill; the first registration (`GlobalHotkey` in `LuxDidiApp.swift`) wins, so that second one is expected to report unavailable. Not verified at runtime. |
| Audio | `AudioOwner.swift`, `NativeLiveAudioDevice.swift`, `NativeMicMode.swift`, `NativeVoice.swift` | The single owner of capture and playback. Mute closes the capture fence immediately and drops queued speech. Voice processing is always on; the app reports the macOS Mic Mode. |
| Live client | `LiveSessionCoordinator.swift`, `LiveSocketTransport.swift`, `NativeLiveConversation.swift`, `NativeLiveJournal.swift` | Opens the local Live socket, sends mic frames, plays the reply, keeps a content-free journal of the call. |
| Host supervision | `NativeServiceSupervisor.swift`, `NativeServiceRecovery.swift`, `InstalledRuntime.swift`, `CompanionClient.swift` | Starts the bundled Node host with `--supervised`, reads its ready frame, restarts it if it dies, and talks to it with the private credential file. State lives in `Library/Application Support/ai.peat.lux-didi` in the user's home. |
| Bridge | `NativeBridge.swift`, `CompanionWeb.swift` | The narrow message channel between the web view and the app (presence, Mic Mode, native actions). It cannot grant authority. |
| Setup | `OperatorSettings.swift`, `NativeGettingStarted.swift`, `NativeNextSteps.swift`, `NativeLoginItem.swift`, `NativeNotifications.swift` | `--configure`, the Getting started page, Open at login, notifications. |

Sound: a soft pad while connecting, a rising chime on arrival, the pad again while a dropped call reconnects, and a short goodbye when a voice stop ends the call.

### Presence states

| State | Meaning | Orb |
| --- | --- | --- |
| `cold` | No call. The orb is still there. A tap starts one. | grey, dim, silent |
| `connecting` | A call is opening. Nothing is captured until the provider is ready. A tap cancels. | grey with the connecting look and pad |
| `live` | Microphone open, conversation running. A tap mutes. | colour follows her state |
| `hotMuted` | Call stays open, capture closed, queued speech dropped. The idle clock is suspended. A tap resumes. | purple |

A trigger names what moved the machine: `hotkey`, `click`, `app`, `timer`, `sleep`, `error` or `voice` (the owner's own stop phrase). Every move leaves a receipt in `host.log`.

## Host layer: `server/`

Entry and wiring: `host/index.ts` parses flags (`--data-dir`, `--web-root`, `--port`, `--descriptor`, `--config-dir`, `--owner-profile`, `--supervised`, `pair`, `--mongoose-login`, `--no-browser`, `--help`), opens the store, composes everything and serves the web UI and API from `http/`.

| Area | Where | Job |
| --- | --- | --- |
| Store | `runtime/`, `domain/` | SQLite via `node:sqlite`. Notes, memory, commitments, the trace tables, the call journal. Single writer, private `0700` directory. |
| Text chat | `chat/` | The connected text conversation: consent, steps and partial answers, selected memory. |
| Live call core | `live/` | One call at a time: lifecycle, journal of finalized transcripts, timers, reconnect with resumption, mute handling, the stop-phrase gate (`stop-phrase.ts`), warm context (`warm-context.ts`), tool-result cache (`tool-cache.ts`). |
| Voice providers | `adapters/live-voice/` | `openai.ts` (GPT-Live) and `gemini.ts`. The provider is a setting; both speak the same host port. |
| Prompt | `prompt/` | Public persona, runtime context (clock, timezone, connected groups), opening options drawn from the stored record only. Content ships like code and is covered by `check-prompt.sh`. |
| Tools and research | `tools/` | What the voice model can call; see the research layer. |
| Connectors | `connectors/`, `adapters/mcp/` | Read-only access to outside systems through MCP; see below. |
| Config | `config/` | Protected configuration files (`live.json` for voice, provider and MCP catalogs) read from the selected config directory. Restart to apply edits. |
| Trace and logs | `trace/`, `host/log.ts` | Content-free `host.log` and the joinable trace tables. See [debugging.md](debugging.md). |

### Call lifecycle

1. **Start.** A tap (or the one auto-connect of an interactive launch) moves presence `cold` to `connecting`. The app asks the host for a Live session; the host builds the instruction (persona, runtime context, memory, the last session's summary, opening options) and opens the provider socket. Warm context is assembled while Naya is silent so the start is fast.
2. **Opening.** Naya opens every new call with one short line of her own, drawn from the last session and not from the calendar twice in a row. The opening directive is never recorded as the owner's speech.
3. **Conversation.** The app streams mic frames up; the host forwards them to the provider and streams audio and transcripts back. Only finalized owner transcripts and the model's audio count as conversational activity. The model may call tools (below); results return to the provider and the journal.
4. **Mute.** `live` to `hotMuted`: capture stops at once, the response watchdog and idle clock are suspended, speech that arrives is held.
5. **Reconnect.** If the provider drops, the host retries with backoff (0, 2, 4, 8, then 8 s) and resumes with the provider's handle, inside the call's own deadlines. The pad plays while it does.
6. **End.** One path for every cause: the Stop button or menu item, a voice stop phrase, the idle timeout (5 minutes without conversational activity), the provider session limit (1 hour by default), the call limit (4 hours), or a fatal error. A voice stop is decided by the host on the owner's finalized sentence: Naya's name at the start or end, one of the end phrases, at most 8 words, no question words, and never from typed text or an old session. The uplink stops at the match, the goodbye sounds, and the call closes exactly like the Stop button.
7. **After.** The host distils the finished call into a private summary off the request path (`services/summarize.ts`). The journal keeps finalized transcripts and boundary facts, not audio or the model's thoughts.

Defaults for the timers are in `adapters/live-voice/types.ts` and `live/config.ts`; the owner's `live.json` can change them.

### The research layer (`tools/research.ts`)

The voice model asks one question in plain words; the host decides which sources to read.

- **Topic argument.** Only the topic reaches a search, never the model's instruction prose, and no dates the owner did not say. "Last meeting with X" returns the newest note first.
- **Routing words.** Words like email, Gmail, message, DM, calendar, weekday names and dates route the ask to mail, chat or calendar; memory and "what needs my attention" asks have their own route. Calendar reads list attendees, understand "tomorrow" and weekdays, and keep full titles.
- **Triage scans.** "Anything important in mail?" runs a fixed read of the unread inbox of the last 2 days, newest first, with sender and date, one page. "Anything urgent on Mattermost?" reads mentions and replies of the last 7 days, newest first. An empty window says so and never says "nothing urgent". When both a triage ask and a topic apply, the triage ask wins.
- **Budgets.** At most two tool rounds per run (the parallel first round plus one continuation) and at most four lookups at once. Each source has a deadline (12 s for connector reads, 8 s for memory, a longer one for weather and news); the whole call is bounded by the slowest source plus 2 s. The first answer point is 4.5 s: she answers with what has arrived and reports late sources once.
- **Reply cap.** The answer a voice model receives is at most 2,500 characters including the envelope. A long knowledge hit is clipped, not dropped; the "more available" note is true; her own earlier answers never come back as evidence.
- **Knowledge confidence** travels as a field, never as raw ranker text. A weak match is voiced as "nothing matched".
- Other tools: typed intent tools (`search`, `mail`, `calendar`, `chat`, `attention`, `brief`), memory search and history, `remember`, vault save, web search, and the open tools (`open_source`, `open_home`, `open_file`, `open_app`). Open tools act only when the owner asked in that turn, check the item is the kind asked for, and never type, click or send.

### Connectors

All connectors are optional, read-only MCP connections declared in the protected config directory, with an explicit endpoint, account identity and credential reference. A missing one shows a next step in Settings and the call still works with the rest.

| Connector | Reads | Notes |
| --- | --- | --- |
| Lux Knowledge | `search_knowledge`, `get_insight`; vault note via `save_insight` on "save to my vault" | `connectors/lux-knowledge.ts`, `tools/vault-write.ts` |
| Gmail and Google Calendar | search, read, list calendars and events | `connectors/google.ts`; two families (gmail, calendar), each its own stdio MCP endpoint |
| Mattermost | search, channel and thread reads, attention scan | via the `mattermost-mcp` server (stdio); sign in once with its own login tool |
| Mongoose | company knowledge reads | HTTP MCP with OAuth; `server/dist/host/index.js --mongoose-login` signs in, the session refreshes itself |

Credentials live in owner-only files in the config directory, never in argv, logs, chat or this repository.

## Web layer: `web/`

Vite and TypeScript, no framework. `src/main.ts` holds the tabs (Conversation, Today, Memory, Settings). `src/live-view.ts` renders the call; `src/settings-view.ts` renders Settings; `src/connected.ts` the text conversation.

The orb: `orb-classic.ts` draws it, `orb-states.ts` maps presence and call state to a look, and `orb-motion.ts` holds the single motion coordinator that both orbs use. Her voice level moves the body and her state sets the colour, so thinking to speaking does not flicker. The orb's visual design is frozen (see [CLAUDE.md](../CLAUDE.md)). The mini page (`mini.ts`) is orb-only and shows one glance state. The page reads presence pushed by the app (`window.didiPresence`), and the app reads nothing private back.

The browser keeps no private records, token or queue in persistent storage, and makes no external font, analytics or CDN request.

## Where the data is

| Path | Holds |
| --- | --- |
| `Library/Application Support/ai.peat.lux-didi/` in the user's home | Installed app state: `state.sqlite`, `logs/host.log`, `logs/native-live.log`, `logs/audio.log`, host credential file |
| `Library/Application Support/ai.peat.lux-didi-operator/settings.json` in the user's home | The selected config directory (`--configure`) |
| the selected config directory | `live.json`, MCP catalog, credentials (owner-only) |

A development host started by hand uses `--data-dir` or `DIDI_STATE_DIR`, else `Library/Application Support/Lux Didi` in the user's home.
