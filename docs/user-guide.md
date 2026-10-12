# Using Lux Didi

## Live with Naya

Open Lux Didi from the menu bar. Press **Start Live** to talk with Naya.
Press **Mute** to pause the microphone, then press it again to resume. Press
**Stop** to end Live. Live never starts just because you open the app.

Global shortcuts:

- Control Option Space: show or hide Didi.
- Control Option Shift L: show Didi and start Live.
- Control Option Shift M: mute or unmute Live.
- Escape while Didi is focused: stop recording and Live.

Use the menu if a shortcut is unavailable.

## Remembering and deleting

Say “Naya, remember that ...” during Live to ask Naya to save a memory.
Check the Memories list to confirm it was saved. Use **Delete memory** on a
memory you no longer want Didi to use. Deletion removes it from future memory
reads and future Live session context. The current live conversation keeps
information it has already received until it reconnects, so stop and restart
Live to discard that conversation context. Deletion does not erase an external
source, a transcript, or copies already shared elsewhere.

**Send to Naya** sends your typed text to the conversation. **Save note** in the
native draft area saves a local note instead; it does not send a chat message.

## What is left to set up

Choose **Getting started** in the menu bar. It opens automatically once after
this build, then only when you reopen it. It shows microphone and notification
permissions, Open at login, shortcuts, and connector status. Nothing requests
permission until you press a setup button. The page's Settings panel shows the
same connector next steps and is read-only.

For Google Calendar, open Terminal and run:

```sh
cd /Users/rob/GitHub/lux-cli && uv run --package lux-gcal gcal --auth
```

Finish the browser sign-in and consent, then restart Lux Didi. **Copy command**
copies only this command, not a credential.

For Mongoose, add the credential file at
`~/Library/Application Support/ai.peat.lux-didi/provider-38/mongoose-mcp.json`.
See **RUNBOOK-connectors.md** (RUNBOOK) for how to obtain and safely write it.
Do not paste credentials into Didi, chat, or diagnostics. Restart Lux Didi after
adding it. The runbook is the operator handoff at
`~/.lux/reports/lux-didi-night-A/RUNBOOK-connectors.md`.

A configured connector connects when Live needs it. If a connector fails, use
**Copy diagnostics** in the menu bar and paste that support snapshot for help.
It copies safe status information, not credential files or conversation text.
