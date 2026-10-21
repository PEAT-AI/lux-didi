# Using Lux Didi

## Live with Naya

Open Naya from the Dock or the menu bar. Press **Start Live** to talk with Naya.
Press **Mute** to pause the microphone, then press it again to resume. Press
**Stop** to end Live. Live never starts just because you open the app.

Global shortcuts:

- Control Option Space: switch between the full app and mini orb. Opening the orb starts Live when idle; returning to the full app keeps the session.
- Control Option Shift Space: show or hide the full Naya window (Live keeps running when the window hides).
- Control Option Shift L: show Naya and start Live.
- Control Option Shift M: mute or unmute Live.
- Escape while the mini orb is focused: hide the orb and stop Live. Escape while the window is focused: hide the window; Live keeps running.

Click the mini orb to start, mute or unmute Live. Right-click it and choose **Open full interface** to return to the app without changing Live.

Naya opens in the full app. Its **Mini** buttons in the header and Settings switch to the floating orb without starting or stopping Live. The 220-point orb has transparent edges, no caption and no capsule. Drag it to move it; Naya remembers its position and keeps it inside a connected display. The orb never takes focus. Its state changes ease smoothly, with a dim cold state and a brighter live state.

Closing the full window with Cmd+W during Live switches to the orb and keeps the session. Closing while idle hides the app until an explicit reveal. Clicking the Dock icon or choosing **Open full interface** in the orb's context menu returns to the full app. App/Mini switching preserves the conversation and tool results.

### The single key

Turn on **Right Command tap** in the menu bar menu (it is on by default), then use the
right Command key as the one switch over Naya:

- **Tap** it to start her, and tap it again to mute her. The orb turns **purple** while she
  is muted: she does not hear you and she does not speak by herself, she waits. Tap once
  more and she listens again; the orb shows the connecting look until she is ready.
- The mute lasts as long as you want it to, so muting her and coming back an hour later
  only needs one tap.
- **Hold** it, or press it with another key (Cmd, Option, Shift), and nothing happens: only
  the bare tap counts. Muting Naya never touches your microphone, your speakers, another
  app, or Superwhisper's Right Option.
- The first time, macOS asks for **Input Monitoring** for Naya. Until that is on, the menu
  bar shows **Right Command is off: allow Input Monitoring for Naya**: choose it, flip the
  switch in the pane it opens, and the key starts working without a restart. The
  Control Option Space chord works with or without it.

The key ignores itself while you are using it in a chord such as Cmd+C, so ordinary
Command shortcuts keep working, and a chord pressed during a hold ends that hold there
and then: the microphone closes as you press it, so no shortcut leaves it listening.
**Mute** stays on the app's mic button and on
Control Option Shift M, not on the key. The first time you launch Naya by hand, macOS
asks for Accessibility (or Input Monitoring) permission with a one-line
explanation, and asks again once after each update, because macOS can drop the grant
when the app is replaced; the chord keeps working whether or not you allow it, and
the settings page and the menu bar say when the key is inactive and why. Right Option belongs to SuperWhisper, so
Naya never uses it.

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

## Stable signing

A Lux Didi install keeps the same code requirement across rebuilds, so macOS
keeps the Accessibility grant you gave it. An ad-hoc build has no certificate:
macOS describes it by a `cdhash` that changes on every build, so it discards the
grant on every install. A local signing identity fixes that once.

Create it, once, on your own machine:

```bash
scripts/create-signing-identity.sh
```

That makes a self-signed code-signing certificate named **Lux Didi Local
Signing** in your login keychain and prints one `security add-trusted-cert`
command. Run that command and enter your login keychain password; nothing else
is needed. `scripts/create-signing-identity.sh --dry-run` prints the plan and
changes nothing. Running it again when the identity exists does nothing.

The build and the install then both report the designated requirement.
`identifier "ai.peat.lux-didi" and certificate ... = H"..."` is the stable
shape; a bare `cdhash H"..."` means the identity was not used, and the build
says so in a warning. With the identity configured, the install refuses an
ad-hoc build instead of installing one that would drop your grant again.

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

Mongoose is the one connector Lux Didi can sign in to for you. Run the host once,
then restart Lux Didi:

```sh
node /path/to/your/install/server/dist/host/index.js --mongoose-login
```

Your default browser opens the Mongoose consent page, where you sign in with
Google. To keep the current window focused, add `--no-browser`; the command
prints a sign-in URL for you to open yourself. The complete attempt expires five
minutes after it starts. After sign-in, the callback page confirms receipt and
can be closed; no token is ever copied, pasted or printed. The session refreshes itself while you use it. If it ever
goes stale, the connector next step says **Mongoose session expired, reconnect
Mongoose** with the same command.

Use the connector server's own documented account sign-in procedure for every
other connector. Lux Didi ships no universal Calendar sign-in command. Endpoint commands, account identities
and credential references must match the connector you installed. Credential files
belong in the selected directory with owner-only permissions. Do not paste secrets
into Didi, chat or diagnostics. Restart Lux Didi after changing configuration.
Existing owner configuration is preserved during installation, including symlinks;
configuration loaders still enforce their own stricter validation rules.

A configured connector connects when Live needs it. If a connector fails, use
**Copy diagnostics** in the menu bar and paste that support snapshot for help.
It copies safe status information, not credential files or conversation text.

If Live cannot start, its message now distinguishes a missing microphone, unavailable audio format, voice-processing failure, or audio-engine startup failure. Check the microphone and output device in System Settings, Sound, then try Live again; the local diagnostic records a numeric audio error when available, not a device label. Voice processing stays enabled, and Live never silently starts without it.
