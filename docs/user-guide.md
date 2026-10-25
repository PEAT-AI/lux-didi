# Using Lux Didi

Lux Didi is the Mac application; Naya is the assistant you talk or type to. Start with a local installation and one voice provider. Add connected accounts only when you want their data available. Nothing in the installer signs in to an account or grants new network authority.

## 1. Install on a Mac

You need an Apple silicon Mac running macOS 26 or newer, the Xcode Command Line Tools, Node 26 or newer and npm. From a clean, committed checkout:

```sh
npm --prefix server ci
npm --prefix web ci
bash scripts/build-asset-bundle.sh /tmp/didi-assets
bash scripts/build-macos-app.sh "/tmp/build/Lux Didi.app" --assets /tmp/didi-assets
bash scripts/install-macos-app.sh "/tmp/build/Lux Didi.app" --to "$HOME/Applications"
```

Use new output paths that do not hold unrelated files. The installed app bundles Node. The installer preserves existing data/configuration and keeps a rollback copy of the previous app; it does not install connector helpers.

For stable local signing across rebuilds, run `bash scripts/create-signing-identity.sh --dry-run`, then review the actual script and run it without `--dry-run`. It creates a local signing identity and prints the owner trust step. Ad-hoc signing can invalidate permission grants after a rebuild. This is local installation, not notarized cross-Mac distribution.

## 2. Configure a first voice provider

An existing installation may already have protected configuration. Do not overwrite it. For a new installation, choose a private directory outside the app and repository:

```sh
umask 077
mkdir -p "$HOME/.config/lux-didi"
chmod 700 "$HOME/.config/lux-didi"
```

Use a local editor to create `live.json` there with this minimal first-call example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "openai",
  "dataClasses": ["ordinary"],
  "preferences": {
    "dataClass": "ordinary", "language": "en",
    "register": "plain", "humor": "off", "verbosity": "brief"
  }
}
```

Then create `openai-primary.json` in the same directory. Replace the key and nonsecret account label locally; never put the real key in a terminal command, chat or issue:

```json
{
  "schemaVersion": 2,
  "keyReference": "openai-primary",
  "key": "REPLACE_LOCALLY_WITH_YOUR_KEY",
  "configuredAccount": "my-openai-account",
  "routeScope": {
    "provider": "openai", "modelId": "gpt-live-1",
    "endpoint": "https://api.openai.com/v1", "apiVersion": "v1",
    "keyReference": "openai-primary", "allowedClasses": ["ordinary"]
  },
  "bindingGeneration": "my-first-voice-binding"
}
```

These are onboarding examples for the current source, not the complete configuration schema. The voice model/voice defaults come from `providerSlots` in `server/config/index.ts`. The configured model must be available to your key; syntactic acceptance cannot prove availability. The account label is your assertion, not a remote identity check. Start with non-sensitive speech under this ordinary-only route; do not misclassify private material to bypass a refusal.

Protect both files and select the directory:

```sh
chmod 600 "$HOME/.config/lux-didi/live.json" "$HOME/.config/lux-didi/openai-primary.json"
"$HOME/Applications/Lux Didi.app/Contents/MacOS/LuxDidi" --configure \
  --config-dir "$HOME/.config/lux-didi"
```

The selector validates paths, not the API key's remote validity. Restart the app deliberately after editing files. Text chat uses a separately configured Gemini text profile/key; selecting OpenAI voice does not configure text chat. [Provider configuration](provider-configuration.md) covers the operator CLI, Gemini setup, binding changes and other supported voice choices.

## 3. Make the first call

Open Lux Didi from Finder. An interactive launch attempts one call automatically. Allow microphone access when asked; if configuration or permission is missing, read the visible reason rather than repeatedly reopening the app.

Try a non-sensitive greeting. Confirm that you hear Naya, can mute/resume and can stop the call. This verifies more than a locally accepted profile: it exercises the provider and your actual microphone/playback path. Use Stop or say **"Naya, stop listening"** when finished.

Login and installer relaunches do not automatically connect. In those cases, tap the orb to start. **Getting started** in the menu shows permission and connection next steps. Microphone permission and **Input Monitoring** for Right Command are different macOS grants.

## Everyday controls

| Action | Control |
| --- | --- |
| Start, mute, resume | Tap the orb or bare Right Command |
| End the call | Stop, or "Naya, stop listening" |
| Open the full window | **Open Naya app** in the menu; Control Option Shift Space |
| Show/hide the orb | Control Option Space |
| Start Live / mute by chord | Control Option Shift L / Control Option Shift M |
| Configure the single key | **Right Command tap** in the menu; allow Input Monitoring if requested |
| Inspect settings or safe support state | Settings / **Copy diagnostics** |

Only a bare Right Command tap counts; holding it or using a normal Command chord must not steal other apps' shortcuts. Muting Naya does not change system input/output or another application's audio. Closing the full window does not end the call. [Mac experience](mac-experience.md) explains the native ownership.

## 4. Add connected accounts

A sign-in requires a configured endpoint/helper, its own account authorization and host approval. Install the appropriate connector server first; Didi does not ship every service's server or a universal account wizard. Keep its private account/token configuration outside this repository. Settings reports what is missing; a visible row alone is not proof of a usable read grant.

### Mongoose

Configure knowledge, data and CRM as separate resources. In Settings, use **Sign in to Mongoose knowledge**, **Sign in to Mongoose data** or **Sign in to Mongoose CRM** on that endpoint's row, then finish in the browser. One button signs in only that resource. The row shows progress and reconnects after successful saving.

For a terminal flow using the installed runtime:

```sh
"$HOME/Applications/Lux Didi.app/Contents/MacOS/node" \
  "$HOME/Applications/Lux Didi.app/Contents/Resources/server/node_modules/@lux-didi/service/dist/host/index.js" \
  --mongoose-login knowledge --config-dir "$HOME/.config/lux-didi"
```

Replace `knowledge` with `data` or `crm`. `--no-browser` prints an authorization URL for manual opening. No token needs copying or pasting. Data additionally needs the owner's Lightdash token connected in Mongoose settings; CRM requires the service's team admission. A refusal on one endpoint does not grant or invalidate another. The admin endpoint is not supported.

### Trello

Privately create `trello-board.json` beside the sign-in record, mode `0600`, containing `{"board":"Your board name"}` with your actual board name. Do not publish it. In Settings choose **Sign in to Trello**, select the workspace containing that board and approve the requested access in the browser. No `mcp.json` Trello entry is needed.

Then ask for the board overview, overdue cards or a named list. Naya can make granted card changes on that board: create/update, comment, checklist, due date, move/done, label and archive. She cannot administer arbitrary boards/lists, change members or permanently delete cards. Ambiguous targets require clarification. A due date is not a promise that Naya will call you back.

### Gmail, Calendar and Drive

Install and configure the Google helper with the selected account and token path. Use its authorization command for each family: `lux-google-mcp authorize --family gmail`, `--family calendar` or `--family drive`, supplying the additional account/token options shown by that installed helper's `--help`. Use the configured helper executable, not an unrelated copy found on PATH.

Drive needs its own read consent and endpoint; Gmail access does not imply Drive access. After changing helper/catalog files, restart Didi deliberately. Ask for a small read first, such as upcoming events or a named document, and verify that the answer identifies what was actually searched. A sign-in-needed result is not an empty mailbox or calendar.

### Mattermost and Lux Knowledge

Use the installed Mattermost archive helper's account flow; a missing session reports `mattermost_login` as the next step. Person/group/channel reads depend on the child's published and approved capabilities. A missing capability must be reported rather than replaced by a guessed person.

Lux Knowledge uses its configured endpoint/account credentials and read approval. Searching it does not grant permission to write notes back. [MCP configuration](mcp-configuration.md) owns catalog schemas, helper environments, source classes and approval modes. If a private source is refused by the first-call ordinary-only route, review the route/source classification explicitly; do not relabel it ordinary to make it work.

## What to try next

- **Read and open:** ask a source-backed question, then ask to open the found email, event or document. Native web destinations prefer Chrome, with the default browser as fallback. A spoken "opened" claim must follow a real open result.
- **Text:** once the Gemini text profile is configured, start a connected conversation in the full window, review the provider disclosure and send. Partial text is provisional; check the saved final outcome before retrying a failed turn.
- **Local memory:** say "Naya, remember that ..." and inspect Memory. A local note is not a remote source edit. **Save note** in the native draft saves locally; **Send to Naya** starts conversation work.
- **Dictated Lux note:** explicitly ask to save the dictated note. Success is a write receipt, not a model's intention.
- **Composed Lux note:** this optional flow defaults **off** (`features.composedNotes` in `live.json`). If explicitly enabled, ask Naya to compose a note, listen to the host readback and confirm it. Staging is not saving. It creates a note, not arbitrary edits/deletes in Lux Knowledge.

The notes exporter is a separate feature from composed notes and local prompt selection; `features.notesExport` has its own switch. Review [selected-memory.md](selected-memory.md) and [tool-owner.md](tool-owner.md) before changing export policy.

## Deletion, privacy and failures

Deleting a memory excludes that local note from future reads and later rebuilt context. An already open provider connection can still hold it; stop and restart Live to discard that context. Deletion does not erase remote originals, quoted conversation history, backups or provider-held bytes.

Local-first does not mean offline inference: approved providers receive accepted context/audio, and connectors contact their services. Read [privacy-and-authority.md](privacy-and-authority.md) before broadening routes or enabling writes.

If a call or connector fails, preserve its visible reason and use **Copy diagnostics**. Never paste credential files, a database dump or private transcript content into a public issue. A transient service failure may work on a later explicit request; missing consent or credentials need setup, not repeated asks. Do not alter another app's audio routing or delete state to hide the failure. [Debugging](debugging.md) gives the next evidence steps.
