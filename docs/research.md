# Research: sources, options and evidence limits

Status: public summary of the research base for the plan. Access date for every source below is 2026-10-09, the planning date. This page separates what a source says from what was observed and from what is still an assumption. Nothing here was measured by running a product, because no product exists.

## Evidence classes

- OBSERVED: seen on a live system or in source code during planning, within the stated scope.
- SOURCE CLAIM: stated by documentation or a primary source of record, not exercised.
- PROPOSED: design intent for a later implementation issue to build and falsify.
- UNKNOWN: not established, and not to be asserted as either true or false.

## Host and runtime

Options compared: a native Swift and SwiftUI menu-bar host with a local sidecar process; a Tauri v2 shell; an Electron shell; a web or progressive web shell. The distinguishing requirements are a global hotkey without Accessibility permission, hardware voice processing for echo cancellation and barge-in, on-device streaming speech recognition, and sleep and wake hooks. The native stack exposes all of them as first-class APIs; Tauri is a genuine lighter second choice that loses control of the audio graph; Electron works but ships a full browser runtime; a web shell cannot register a system-wide hotkey.

Primary sources:

- Apple, SpeechAnalyzer: https://developer.apple.com/documentation/speech/speechanalyzer
- Apple, AVAudioIONode and voice processing: https://developer.apple.com/documentation/avfaudio/avaudioionode
- Apple, sleep notification: https://developer.apple.com/documentation/appkit/nsworkspace/willsleepnotification
- Apple, audio input entitlement: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.device.audio-input
- Apple, notification interruption levels: https://developer.apple.com/documentation/usernotifications/unnotificationinterruptionlevel
- Apple, critical alerts entitlement and request form: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.usernotifications.critical-alerts and https://developer.apple.com/contact/request/notifications-critical-alerts-entitlement/
- Apple, code signing requirements: https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements
- Tauri, global shortcut and updater: https://v2.tauri.app/plugin/global-shortcut/ and https://v2.tauri.app/plugin/updater/
- Tauri, macOS hotkey implementation: https://raw.githubusercontent.com/tauri-apps/global-hotkey/dev/src/platform_impl/macos/mod.rs
- Electron, global shortcut, updater and power monitor: https://www.electronjs.org/docs/latest/api/global-shortcut, https://www.electronjs.org/docs/latest/api/auto-updater, https://www.electronjs.org/docs/latest/api/power-monitor
- MDN, Keyboard Lock: https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock
- OpenClaw public documentation, used as a design reference for a bounded host plus gateway and companion model: https://docs.openclaw.ai/ and https://openclaw.ai
- OpenClaw repository and releases, for the gated pinned comparison: https://github.com/openclaw/openclaw and https://api.github.com/repos/openclaw/openclaw/releases

A gated comparison of a thin native host against integrating the current pinned OpenClaw release as a host or plugin carrier is assigned to issue A01. Feature count is not a defect in itself; the comparison selects on working seams and maintenance burden. No fork is mandated, and no configuration may be claimed workable without evidence.

## Voice transport

Gemini Live is preferred for duplex voice, with the model and provider replaceable. The documented shape at planning time: `gemini-3.8-live`, a fifteen minute audio-only session ceiling, session resumption with a validity window, input and output transcription, function calling with non-blocking scheduling, and interruption semantics that discard the model turn and cancel pending function calls. Those properties are SOURCE CLAIM from the primary documentation:

- https://ai.google.dev/gemini-api/docs/live-api
- https://ai.google.dev/gemini-api/docs/live-api/session-management
- https://ai.google.dev/gemini-api/docs/live-api/capabilities
- https://ai.google.dev/gemini-api/docs/live-api/tools
- https://ai.google.dev/gemini-api/docs/live-api/best-practices
- https://ai.google.dev/gemini-api/docs/live-api/thinking
- https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens

OpenAI Realtime documentation was fetched but its page text is produced by client script and could not be read, so this plan makes no claim about that provider, positive or negative. A fallback speech path (speech to text, text to speech) is planned as issue F05 and is not assumed to support duplex behavior.

## Identity, credentials and egress

Primary sources:

- Google, OAuth 2.0 for native apps: https://developers.google.com/identity/protocols/oauth2/native-app
- Google, OAuth application policies (publishing status, testing and production, the 100-user cap for unverified apps): https://developers.google.com/identity/protocols/oauth2/policies
- Model Context Protocol specification, revision 2026-07-28, including its statement that a stdio client and server share one trust domain and that binding to a loopback address is not an authentication boundary: https://modelcontextprotocol.io
- Apple Platform Security guide, for Keychain and TCC behavior: https://support.apple.com/guide/security/welcome/web

Consequences recorded in the plan: the installed-app flow with a loopback redirect and PKCE is the per-account mechanism; a personal install can publish unverified in the user's own Cloud project, which shows an unverified-app warning and caps lifetime new users at 100, while a wider install needs brand verification and, for restricted scopes, possibly an annual third-party security assessment. The plan treats the local delivery model as not by itself settling where restricted-scope content may be forwarded; the forwarding route is assessed on its own terms. These are a mix of SOURCE CLAIM and recorded policy positions; no verification outcome is claimed from Google.

## Mobile companion and prior art

- OpenClaw companion documentation, for gateway-owned pairing, separate observer and actor roles, and revocation: https://docs.openclaw.ai/platforms/ios and https://docs.openclaw.ai/gateway/pairing
- Android notification and background limits, for the companion notification design: https://developer.android.com/develop/ui/views/notifications and https://developer.android.com/develop/background-work
- Public prior art considered and not reused: Muse (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), Grok bot (https://docs.x.ai/grok-bot/overview), Khoj (https://github.com/khoj-ai/khoj) and Letta (https://github.com/letta-ai/letta).

The companion cannot be the runtime. One Mac is the authority while it is awake. While it sleeps, closed or offline, nothing executes and nothing is sent, and the companion queues with an honest message.

## Licence boundary

An earlier internal draft overstated the licence position as "no obligation beyond attribution". That was corrected. MIT is permissive, not attribution-only: it requires retaining the copyright and permission notices in copies or substantial portions, and it disclaims warranty. The licence file of a reused component must be pinned to the release actually copied, because notice holders change between release lines. Component-level review is required before reuse, not after; Khoj is AGPL-3.0, which carries network source-availability obligations, and Letta is Apache-2.0 with notice retention requirements. Practical rule: no component is retained on a licence assumption, and licence and notice review is part of the same decision as the seam and maintenance review. The public repository is not a licence grant for any pre-existing private code; reuse of private voice or prompt assets needs an explicit clearance decision first.

## Evidence limits

- No capability listed in this page was exercised for this product. Nothing was installed, launched, paired, authorized or measured.
- No end-to-end latency or energy figure was measured. The numbers in [acceptance.md](acceptance.md) are proposed targets for later measurement.
- Bundle size and memory ratios between shells are widely reported, not measurements.
- Apple entitlement behavior (critical alerts, audio input entitlement, Accessibility and Automation prompts) is read from documentation, not exercised on this machine.
- Whether a local notification scheduled by an agent app is delivered during sleep is not verified.
- The private baseline for existing internal systems is intentionally not linked or quoted. Where a planning issue depends on it, the issue says the baseline is non-public and states what must be re-verified against real interfaces at implementation time.
- Provider data protection arrangements are not verified by this project. The product states that the operator verifies their own agreement and never claims an arrangement on the user's behalf.
