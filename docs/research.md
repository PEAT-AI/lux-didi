# Research: sources, options and evidence limits

Status: public summary of the research base for the plan. Access date for every source below is 2026-10-09, the planning date. This page separates what a source says from what was observed and from what is still an assumption. Nothing here was measured by running a product, because no product exists.

## Evidence classes

- OBSERVED: seen on a live system or in source code during planning, within the stated scope.
- SOURCE CLAIM: stated by documentation or a primary source of record, not exercised.
- PROPOSED: design intent for a later implementation issue to build and falsify.
- UNKNOWN: not established, and not to be asserted as either true or false.

## Host and runtime

Options compared: a native Swift and SwiftUI menu-bar host with a local sidecar process; a Tauri v2 shell; an Electron shell; a web or progressive web shell. The distinguishing requirements are a global hotkey without Accessibility permission, a native voice-processing API for echo cancellation and barge-in (the documentation describes an OS audio capability; this report does not claim a hardware-only path), on-device streaming speech recognition, and sleep and wake hooks. The native stack exposes all of them as first-class APIs; that is a source claim, not a measurement. Tauri is a genuine lighter second choice that loses control of the audio graph; Electron works but ships a full browser runtime; a web shell cannot register a system-wide hotkey.

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
- OpenClaw public documentation, used as a design reference for a bounded host plus gateway and companion model: gateway pairing and access control https://docs.openclaw.ai/gateway/pairing; the pinned comparison was consumed by the A01 service-stack decision record and no capability is assumed.
- OpenClaw repository and releases, for the gated pinned comparison: https://github.com/openclaw/openclaw and https://api.github.com/repos/openclaw/openclaw/releases

A gated comparison of a thin native host against integrating the current pinned OpenClaw release as a host or plugin carrier is assigned to issue A01. Feature count is not a defect in itself; the comparison selects on working seams and maintenance burden. No fork is mandated, and no configuration may be claimed workable without evidence.

## Runtime and deployment stack decision (PLAN-R1)

The comparison earlier on this page was a source comparison, not a measurement. The council round
b9bdda79 and the architect ruling PLAN-R1 closed it: one authoritative service written in TypeScript
on Node with a SQLite store, a Swift companion for the native surfaces, and a responsive progressive
web application as the portable client, with the same process running on loopback now and on a Linux
virtual machine later. The native framework advantages the comparison names (global hotkey, control
of the audio processing graph, on-device streaming speech, sleep and wake hooks) are preserved by
keeping those surfaces in the companion rather than by making the companion the core. The earlier
Swift runtime and domain prototype is superseded as a product core; its findings remain evidence for
companion audio, permission and wake behaviour, and it is recorded as superseded in A01.

No deployment claim follows from this section. No host was provisioned, no image was built, no
measurement was taken, and the operational runbook is planned work in E11.

## Voice transport

Gemini Live is preferred for duplex voice, with the model and provider replaceable. The documented shape at planning time: `gemini-3.8-live`, a fifteen minute audio-only session limit without compression (the current documented value, not a permanent protocol ceiling), session resumption with a validity window, input and output transcription, function calling with non-blocking scheduling, and interruption semantics that discard the model turn and cancel pending function calls. Those properties are SOURCE CLAIM from the primary documentation; none of them was exercised here:

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

- Google, OAuth 2.0 for native apps, including the loopback redirect, PKCE and the required token audience: https://developers.google.com/identity/protocols/oauth2/native-app
- Google, OAuth application policies: publishing status In production versus Testing, and the 100-new-user lifetime cap for unverified apps: https://developers.google.com/identity/protocols/oauth2/policies
- Google, restricted-scope verification for Gmail and Drive, including when an assessment is triggered: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Model Context Protocol specification, revision 2026-07-28. Authorization and token audience: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization. Local-server security, including the statement that a stdio client and server share one trust domain and that binding to a loopback address is not an authentication boundary: https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices
- Apple Platform Security guide, for Keychain and TCC behavior: https://support.apple.com/guide/security/welcome/web

Consequences recorded in the plan: the installed-app flow with a loopback redirect and PKCE is the per-account mechanism; a personal pilot can use a per-installation client in the user's own Cloud project, where the publishing status and the 100-user cap are policy of the chosen distribution rather than a preselected universal exemption; a wider install needs brand verification and, for restricted scopes, possibly an annual third-party security assessment. The plan treats the local delivery model as not by itself settling where restricted-scope content may be forwarded; the forwarding route is assessed on its own terms. These are a mix of SOURCE CLAIM and recorded policy positions; no verification outcome is claimed from Google.

Policy corrections carried from the product review: an unconfigured install makes no external calls, while an approved and configured cloud route is designed behavior; revocation prevents future dispatch and future use but cannot undo a request already started at a provider; raw audio defaults to discard after bounded transcription processing with a user-controlled retention and export choice; Developer ID signing and notarization are a distribution choice, not a prerequisite for using local permission-gated features on one's own machine; configurable product preferences are distinct from provider policy, organization restrictions and operating-system authority, which the product does not override.

## Mobile companion and prior art

- OpenClaw companion documentation, for gateway-owned pairing, separate observer and actor roles, and revocation: https://docs.openclaw.ai/platforms/ios and https://docs.openclaw.ai/gateway/pairing
- Android notification and background limits, for the companion notification design: https://developer.android.com/develop/ui/views/notifications and https://developer.android.com/develop/background-work
- Public prior art considered and not reused: Muse (https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), Grok bot (https://docs.x.ai/grok-bot/overview), Khoj (https://github.com/khoj-ai/khoj) and Letta (https://github.com/letta-ai/letta).

The companion cannot be the runtime. One Mac is the authority while it is awake. While it sleeps, closed or offline, nothing executes and nothing is sent, and the companion queues with an honest message.

## Licence boundary

An earlier internal draft overstated the licence position as "no obligation beyond attribution". That was corrected. MIT is permissive, not attribution-only: it requires retaining the copyright and permission notices in copies or substantial portions, and it disclaims warranty. The licence file of a reused component must be pinned to the release actually copied, because notice holders change between release lines. Component-level review is required before reuse, not after; Khoj is AGPL-3.0, which carries network source-availability obligations, and Letta is Apache-2.0 with notice retention requirements. Practical rule: no component is retained on a licence assumption, and licence and notice review is part of the same decision as the seam and maintenance review. That is a per-component review requirement, not legal clearance and not automatic permission to reuse; retention happens only after the review records the licence and notice basis.

## Evidence limits

- No capability listed in this page was exercised for this product. Every comparison here is a source claim: nothing was installed, launched, paired, authorized or measured.
- No end-to-end latency or energy figure was measured. The numbers in [acceptance.md](acceptance.md) are proposed targets for later measurement.
- Bundle size and memory ratios between shells are widely reported, not measurements.
- Apple entitlement behavior (critical alerts, audio input entitlement, Accessibility and Automation prompts) is read from documentation, not exercised on this machine.
- Whether a local notification scheduled by an agent app is delivered during sleep is not verified.
- The private baseline for existing internal systems is intentionally not linked or quoted. Where a planning issue depends on it, the issue says the baseline is non-public and states what must be re-verified against real interfaces at implementation time.
- Provider data protection arrangements are not verified by this project. The product states that the operator verifies their own agreement and never claims an arrangement on the user's behalf.
