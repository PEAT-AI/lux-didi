# Using Lux Didi

## Live with Naya

Open Naya from the Dock or the menu bar. Press **Start Live** to talk with Naya.
Press **Mute** to pause the microphone, then press it again to resume. Press
**Stop** to end Live. Live never starts just because you open the app.

Global shortcuts:

- Control Option Space: show or hide the mini orb. Showing it starts Live when Live is not already running; hiding it stops Live.
- Control Option Shift Space: show or hide the full Naya window (Live keeps running when the window hides).
- Control Option Shift L: show Naya and start Live.
- Control Option Shift M: mute or unmute Live.
- Escape while the mini orb is focused: hide the orb and stop Live. Escape while the window is focused: hide the window; Live keeps running.

Click the orb in the mini view to expand to the full window; Live keeps running.

Naya has two modes and only one is ever on screen. The full window has a **mini**
button in its header (its accessible label is "Show the mini orb") that moves the
app to the floating orb. The orb shows only listening, thinking and talking and
never takes focus; it can be dragged anywhere, and Naya remembers where you put it.
Closing the window with Cmd+W while Live is running switches to the orb and keeps
the session; closing it while Live is off just hides the window. A click on the
Dock icon always brings the full window back.

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

## Connector setup

Installation does not create provider or connector configuration, install connector
servers, sign in to accounts, or grant network access. Without configuration,
local notes and memory remain available; connected chat and Live are unconfigured.

Create an owner-only configuration directory outside the application bundle,
then select it with the installed executable:

```sh
"$HOME/Applications/Lux Didi.app/Contents/MacOS/LuxDidi" --configure --config-dir /absolute/path/to/your/config-directory
```

Replace the example directory with your existing absolute directory. This command
selects a directory; it does not generate profiles or credentials. See
[protected operator configuration](macos-install.md#protected-operator-configuration)
for permissions and validation, [provider configuration](provider-configuration.md)
for connected chat, [Live configuration](provider-configuration.md#live-profile-livejson-and-the-local-persona-overlay)
for Live, and [MCP configuration](mcp-configuration.md) for connector endpoints,
classification and explicit network approval.

Use the connector server's own documented account sign-in procedure. Lux Didi
ships no universal Calendar sign-in command. Endpoint commands, account identities
and credential references must match the connector you installed. Credential files
belong in the selected directory with owner-only permissions. Do not paste secrets
into Didi, chat or diagnostics. Restart Lux Didi after changing configuration.
Existing owner configuration is preserved during installation, including symlinks;
configuration loaders still enforce their own stricter validation rules.

A configured connector connects when Live needs it. If a connector fails, use
**Copy diagnostics** in the menu bar and paste that support snapshot for help.
It copies safe status information, not credential files or conversation text.

If Live cannot start, its message now distinguishes a missing microphone, unavailable audio format, voice-processing failure, or audio-engine startup failure. Check the microphone and output device in System Settings, Sound, then try Live again; the local diagnostic records a numeric audio error when available, not a device label. Voice processing stays enabled, and Live never silently starts without it.
