# Implementation status

This describes the current source tree, not proof that a published release or an
owner installation contains every change. A bundle's `didi-runtime.json`
`releaseCommit` identifies its source. Build success alone does not prove usable
accounts, voice hardware or a healthy installed application.

## Implemented surfaces

- A loopback-only TypeScript service with a single SQLite writer, durable local
  notes, source-backed memory, commitments, correction history and Today.
- Connected text conversations with explicit consent and provider configuration;
  MCP tool composition with endpoint classification, approval and tool evidence.
- Live session ownership, Gemini transport, native microphone capture and audio
  playback, mute/stop controls, transcript projection and local memory tools.
- A shared same-origin web client with pairing, connected conversations, memory
  filters/deletion, origin/kind labels, Settings and connector next steps.
- A regular Mac app named Naya (Dock icon, app icon, FULL window and MINI
  floating orb) with service supervision, native web view, native Save note and
  Send to Naya, Getting started, permission buttons, shortcuts, login item
  control, notifications and safe diagnostics.
- Canonical producers for a bundled-Node app, signature validation, installation,
  preservation of a prior app and restoration on failed post-swap verification.

## Setup and authority

The installer creates no provider or connector configuration and changes no
existing configuration files or symlinks. An owner selects a protected directory
with the existing native `--configure --config-dir` mechanism and supplies the
profiles, endpoint catalog and credentials described in the public guides.
Missing profiles are a healthy unconfigured state. Local notes and memory still
work; no unconfigured provider or connector receives automatic authority.

The host retains a compatibility migration for an existing default
`provider-config` catalog into a selected directory when its catalog is absent.
It copies existing MCP/Live catalogs only, never credentials. A fresh installation
has no such catalog to migrate. Configured endpoints can grant trusted reads only
when the owner has explicitly supplied that catalog and its approval mode.

Live limits come from the effective validated profile. When its optional limits
are omitted, the core supplies a 15 minute session and 1 minute idle limit.
Installation no longer chooses a different timer profile.

## Verification limits

Canonical scripts include packaging, host, provider, MCP, Live, native and web
checks. Synthetic fixtures exercise boundaries without a real account or voice
provider. A final release still requires the exact committed tree's applicable
checks, installed identity and signature proof, companion proof, meaningful
real-account tool/chat/memory results and a built-in microphone/audio smoke.

Local ad-hoc signing and same-Mac relocation do not prove cross-Mac Gatekeeper
acceptance. Paid signing, notarization and clean-machine installation remain
unverified. Strict whole-app Keychain API modernization remains separate work.
Linux is unverified, Windows has no package, and cloud/mobile synchronization,
harness control and broad computer autonomy remain roadmap work.

Deletion excludes memories from future reads and session context. An active
provider session retains context already sent until reconnect or stop, and stored
conversation answers may retain quoted memory. These are explicit current limits.

See [user guide](user-guide.md), [Mac installation](macos-install.md),
[provider configuration](provider-configuration.md),
[MCP configuration](mcp-configuration.md) and [Mac experience](mac-experience.md).
