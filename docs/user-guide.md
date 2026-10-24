# Using Lux Didi

## Starting Naya

Open Lux Didi like any app. Naya appears as a small floating orb in the top right corner of the screen, just below the menu bar clock. Opening the app by hand also starts a call by itself, once. If that start fails (no microphone permission, no voice provider configured) she stays quiet and the menu bar says why; she does not retry in a loop.

Naya does not connect when macOS starts her at login, when an install relaunches her, or during any check. In those cases you only see the orb, and a tap starts the call.

The full window is separate and optional. It opens only when you ask: **Open Naya app** in the menu bar, **Open Naya app** in the Dock icon's right-click menu (a plain click shows the orb), or a shortcut. The orb and the window can be on screen together. Closing the window never ends a call.

## Talking with her

- **Start, mute, resume.** Tap the orb, or tap the Right Command key (see below). The first tap starts a call, the next one mutes, the next one lets her listen again. While she is muted the orb is purple; she does not hear you and does not speak by herself.
- **Stop the call.** Say "Naya, stop listening", "Naya, shut down", "Naya stop", "Naya stop now" or "Naya stop, please". The existing call-ending phrases ("end the call", "hang up", "goodbye", "good night", "turn off", "switch off", "Naya aus", "Naya, hör auf zuzuhören") also work with polite fillers. The host checks every speech fragment using the last 10 words: Naya (also recognized as Naja, Nayah, Naia, Nia, Nayla or Nayer) must be within 4 words before or 2 words after the phrase; a name at a fragment edge stays available for 3 seconds. Earlier room speech does not hide the command. The name is optional for "stop listening", "shut down", "stop now" and the German forms when the phrase ends the speech fragment or is followed only by polite fillers or "to me". The bare word "stop" still needs her name directly next to it. Quoted, negated, typed or echoed assistant speech does not stop the call; an object such as "stop listening to podcasts" also does not. The microphone stops, a short goodbye plays, and the call ends; the menu bar **Stop** remains available.
- **If you say nothing.** An unattended call ends after 5 minutes without conversation. Background noise does not count as conversation. Muting suspends the clock. A single provider session lasts at most an hour by default and a whole call at most four hours. When a provider session has to be replaced and the switch came from background speech with nothing from you since her last words, she stays quiet: no chime and no "I am back". After your own speech she greets you as before.
- **Her first line.** Every new call opens with one short line of her own, based on the last session. An open loop she has not seen confirmed in the last day reaches you as a question ("is that done?"), never as a fact she states.
- **Ask for things.** For example: "anything important in mail?" (unread mail from the last 2 days, bulk mail set aside, human threads first), "anything urgent on Mattermost?" (mentions and replies of the last 7 days), "what is on tomorrow?", "what did we decide about X?", "weather in Lisbon". She says plainly when a source returned nothing or is not connected. An empty triage window is voiced with its own words and its own window ("nothing unread in the last two days"), never as "nothing urgent"; a trimmed mail list carries the count of lines left out, so a short list is never mistaken for an empty one. She opens a mail, event, thread, file or app only when you ask her to.

## Shortcuts and the menu

- Right Command, bare tap: start, mute, resume (the single key, below).
- Control Option Space and Control Option Shift Space: show or hide the full window.
- Control Option Shift L: start Live. Control Option Shift M: mute.
- Escape: closes the window if it is open, otherwise hides the orb.
- Menu bar: Start Live, Mute, Stop, Open at login, Getting started, Open Naya app, Settings, Right Command tap, Show mini orb, Always show Naya, Reveal logs, Copy diagnostics, Quit Naya. The menu shows each shortcut and says if another app already holds it.

Drag the orb to move it. Naya remembers its position and puts it back on a connected screen if a monitor goes away. Clicks beside the orb pass through to the app underneath.

### The single key

Turn on **Right Command tap** in the menu bar menu (on by default). Then the right Command key is the one switch over Naya:

- **Tap** it to start her, tap again to mute, tap once more to resume. After a resume the orb shows the connecting look until she is ready.
- **Hold** it, or press it together with another key (Cmd, Option, Shift), and nothing happens. Only a bare tap counts, so Cmd+C and friends keep working.
- Muting never touches your microphone settings, speakers or another app. The right Option key is left alone for dictation apps.
- The first time, macOS asks for **Input Monitoring** for Naya. Until you allow it the menu says "Right Command is off: allow Input Monitoring for Naya"; choose it, flip the switch, and the key works without a restart. The window shortcuts work with or without it. macOS can drop the grant when the app is replaced; see Stable signing below.

## Remembering and deleting

Say “Naya, remember that ...” during Live to ask Naya to save a memory.
Each note is kept on its own, so two different notes said in the same stretch
of talk are both saved; only the same note said twice is refused.
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
permission until you press a setup button. Settings in the full window shows the
same connector next steps; the connector rows are read-only, while the Live voice provider, voice, accent, speaking pace and theme can be changed there and apply from the next call.

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

Mongoose is the one connector Lux Didi can sign in to for you. Run the bundled host
once with the same configuration directory you selected above, then restart Lux Didi:

```sh
"$HOME/Applications/Lux Didi.app/Contents/MacOS/node" \
  "$HOME/Applications/Lux Didi.app/Contents/Resources/server/node_modules/@lux-didi/service/dist/host/index.js" \
  --mongoose-login --config-dir /absolute/path/to/your/config-directory
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
