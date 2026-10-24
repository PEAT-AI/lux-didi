# Implementation status

State of the source tree at release 10 (main 225dcd15, 2026-10-24). It describes the source, not proof that a given installation contains every change: a bundle's `didi-runtime.json` `releaseCommit` names its source. A green build alone proves neither working accounts, voice hardware nor a healthy installed app.

## What works today

- **Voice calls with Naya** over OpenAI GPT-Live or Gemini Live, chosen in Settings. Full duplex, interruptible, with mute, reconnect with resumption, a short opening line, voice stop phrases and an idle timeout.
- **The orb.** Naya starts as the floating orb in the top right. One motion coordinator drives both orbs; her voice moves the body and her state sets the colour.
- **Research layer** over memory, Lux Knowledge, Gmail, Google Calendar, Mattermost, Mongoose and the web, with triage scans for mail and chat, bounded rounds and a 2,500 character reply cap.
- **Memory.** Local notes ("Naya, remember that ..."), a private summary of each finished call, imported standing memory, and vault notes to Lux Knowledge.
- **Text chat and the web UI** (Conversation, Today, Memory, Settings) in the full window.
- **Build and install** of a self-signed Mac app with bundled Node, which preserves the previous app and the owner's configuration.
- **Diagnostics.** Content-free `host.log`, the joinable trace tables, `naya-logs`, `didi-timeline`, and Copy diagnostics in the menu.

## Release history

| Release | Date | What it added |
| --- | --- | --- |
| 3 series | 2026-10-17 to 10-19 | Right Command single key, the always-there presence model, mini orb, custom voices, Mongoose sign-in, steadier calls on weak connections, research receipts |
| fix release 2 and retrieval | 2026-10-22 to 10-23 | Right sources and fewer round trips, calls survive blips, instant unmute, connecting ring, connector recovery, meeting notes found, search text holds content words only |
| 4 | 2026-10-23 | Orb shows live at once, mute frees the microphone, follow-up searches use content words, vault notes by voice |
| 5 | 2026-10-23 | Naya opens each call with her own short line, research capped in rounds, long mail pages trimmed, lighter calls |
| 6 | 2026-10-24 | Orb first (start top right, auto-connect only on an interactive launch, window only from the menu), one motion engine, soft connecting and reconnecting sounds, opener from the last session, reply cap 2,500 characters, calendar attendees and weekdays |
| 7 | 2026-10-24 | Voice stop ("Naya, stop listening"), 5 minute idle timeout, honest mail and chat triage, topic-only searches, confidence as a field, `--install-relaunch` never connects |
| 8 | 2026-10-24 | Keeps every note, asks about an old open loop, stays quiet after background speech |
| 9 | 2026-10-24 | The spoken stop matches inside any sentence with a 3 second name grace and a bare "stop listening" ends the call, Mattermost triage and parallel chat searches, mail triage reads human threads first, three-word mail searches with one wider retry, web results never dropped |
| 10 | 2026-10-24 | A stop stays stopped and a call's state is never guessed, a Dock click shows the orb only, the opener waits for the calendar, Mongoose knowledge, data and crm on three sign-ins, memory recall reads earlier conversations only, every lookup answer opens with what was searched, and no lookup leaves dead air |

Each release is one squash-merged pull request; its body lists the checks run at the head commit and the issues it closes.

## Setup and authority

The installer creates no provider or connector configuration and changes no existing configuration files or symlinks. An owner selects a protected directory with `--configure --config-dir` and supplies the voice profile (`live.json`), the connector catalog and credentials. A missing profile or connector is a healthy unconfigured state: local notes and memory still work, and nothing gets authority automatically. Connector access is read-only, per explicit endpoint, account and credential reference.

Live limits come from the validated profile. When it omits them the defaults are a 1 hour provider session, a 5 minute idle limit and a 4 hour call limit (`adapters/live-voice/types.ts`, `live/config.ts`).

## Known limits

- Local ad-hoc or self-signed signing does not prove acceptance on another Mac. There is no notarization, no clean-machine install test and no Windows or Linux package.
- Deleting a memory removes it from future reads and future call context. A call already running keeps what it has received until it reconnects, and stored answers may quote a deleted memory.
- Voice, microphone, Google, Mattermost and Mongoose behaviour is proven by fixtures in checks and by owner use. No check talks to a real provider or account; `scripts/smoke.sh` is the one real-path run, after an install.
- The orb chord (Control Option Space) and the window chord (Control Option Shift Space) are separate registrations; either can be taken by another app, and the menu then reports the shortcut unavailable. Unverified at runtime.
- Cloud placement, mobile pairing, harness control and broad computer control are designs only; see the historical [roadmap](roadmap.md) and [cloud-deployment](history/cloud-deployment.md).

See the [user guide](user-guide.md), [Mac installation](macos-install.md), [provider configuration](provider-configuration.md), [MCP configuration](mcp-configuration.md) and [Mac experience](mac-experience.md).
