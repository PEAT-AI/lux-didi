# Using Lux Didi

## Live with Naya

Open Naya from the Dock or the menu bar. Press **Start Live** to talk with Naya.
Press **Mute** to pause the microphone, then press it again to resume. Press
**Stop** to end Live. Live never starts just because you open the app.

Global shortcuts:

- Control Option Space: show or hide the pill. Showing it starts Live when Live is not already running; hiding it stops Live.
- Control Option Shift Space: show or hide the full Naya window (Live keeps running when the window hides).
- Control Option Shift L: show Naya and start Live.
- Control Option Shift M: mute or unmute Live.
- Escape while the mini orb is focused: hide the orb and stop Live. Escape while the window is focused: hide the window; Live keeps running.

Click the pill to expand to the full window; Live keeps running.

Naya has two modes and only one is ever on screen. The second mode is the **pill**:
a small capsule, about 64 by 26 points, that sits top-center just below the menu bar
(or below the notch on a notched display). Inside it a tiny orb and a five-bar level
meter show the state and nothing else, because there is no text in the pill:
listening breathes and follows the microphone, thinking shimmers slowly, speaking
pulses, muted dims to one flat bar, and connecting shows a spinner ring. The pill
never takes focus. Drag it anywhere and Naya remembers where you put it, and a
display that disappears never strands it off-screen.
The full window has a **mini** button in its header (its accessible label is
"Show the mini orb") that moves the app to the pill. Closing the window with Cmd+W
while Live is running switches to the pill and keeps the session; closing it while
Live is off just hides the window. A click on the Dock icon always brings the full
window back, and clicking the pill opens the full window.

### The single key

If you prefer one key to the chord, turn on **Right Command tap** in the menu bar
menu (it is on by default). A short tap of the right Command key starts or stops
Naya exactly like Control Option Space: it ignores the key while you are using it in
a chord such as Cmd+C, and it ignores a press held longer than 300 milliseconds, so
ordinary typing never triggers it. The first time you launch Naya by hand, macOS
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
Google. The window closes when the session is saved; no token is ever copied,
pasted or printed. The session refreshes itself while you use it. If it ever
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
