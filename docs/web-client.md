# Web interface

The web interface presents the canonical host's conversation, memory, Today and Settings surfaces. It is also the shared web content embedded by the native Mac app. It does not own the database, connector grants or microphone permission.

## Run against the real host

Use [local-development.md](local-development.md) to build and start the host, then pair the browser at the exact printed origin. The Vite development server is useful for presentation work, but is not proof of the host's production security headers, pairing or same-origin behavior.

A browser-only session is not a native audio test. Use [user-guide.md](user-guide.md) for the installed application's controls and [native-app.md](native-app.md) for its web-view boundary.

## Source map

| Concern | Source |
| --- | --- |
| Entry and surface composition | `web/src/main.ts` |
| API requests and authority lifetime | `request`, `clearAuthority`, `authorityVersion` in `web/src/api.ts` |
| Shared wire types | `web/src/protocol.ts` |
| Connected text conversation | `web/src/connected.ts`, `web/src/composer.ts` |
| Local memory list | `web/src/memory-list.ts` |
| Settings and source status | `web/src/settings-view.ts`, `web/src/connector-status.ts` |
| Native capability/state projection | `web/src/native-bridge.ts` |
| Live presentation | `web/src/live-view.ts` |
| Orb motion and states | `web/src/orb-motion.ts`, `web/src/orb-states.ts` |
| Layout and theme | `web/src/layout.ts`, `web/src/theme.ts` |

Read those owners before adding another local state machine or copying a server contract into a component. The orb's visual design is not an incidental part of a connector or lifecycle change.

## State is observed, not invented

API authority changes invalidate work from the old lifetime. A stale async result must not repopulate a logged-out or changed-authority surface. Browser storage used for presentation or resuming a selection is not a durable mutation queue or a provider/connector consent grant.

Text partials and step events are provisional. Render durable completion and tool outcomes from the host rather than inferring saves from assistant text. A disconnected service is not permission to manufacture successful offline edits. [Text chat](text-chat.md) owns the run lifecycle.

`connectionsMarkup` in `web/src/connector-status.ts` renders endpoint state, while host sign-in routes own the attempt. Mongoose buttons are per endpoint; Trello has its own sign-in. A status row must distinguish missing configuration, authentication, unavailable source and usable connection rather than presenting every empty answer as success.

## Rendering and native actions

`web/src/markdown.ts` owns rendered content. Retrieved markdown is untrusted data; it cannot become a new system instruction or arbitrary native command. Native open actions and allowed destinations remain host/native-owned, described in [tool-owner.md](tool-owner.md).

Closing the full native window is not the same as ending a Live call. The native owner controls capture, playback and presence. Do not implement a browser-local mute that merely changes an icon while the microphone stays open.

## Verification

Use the web and affected real-host producers in [checks.md](checks.md). Browser proofs require their declared Playwright and lease prerequisites, described in [local-development.md](local-development.md). A screenshot without wire/state evidence is not proof that sign-in, deletion or send worked; an HTTP success without the intended rendered state is not enough either.

Do not publish screenshots containing real owner messages or account data. Use synthetic fixtures and retained proof directories. [Debugging](debugging.md) explains safe diagnostics for an actual installation.
