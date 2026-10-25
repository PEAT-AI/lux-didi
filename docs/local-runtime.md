# Local runtime

The canonical host is a foreground Node process listening on loopback. It composes the persistent domain, text conversation, Live voice and host tools; it is not the old local-only prototype. The installed app supervises this host, while a developer can run it directly.

## Composition and one writer

`startHost` in `server/host/runtime.ts` opens the runtime and composes its owners. `hostMigrations` combines their migrations. `createDomainPort` supplies the domain facade; `Store` in `server/runtime/store.ts` owns SQLite and the writer lock. Another process must not open the same state as a competing writer, and a failed lock is not permission to reset the store.

The host forwards voice frames, but never opens audio hardware. The Mac's `AudioOwner` owns capture and playback. MCP is wired through `server/host/mcp.ts`; accepted tool access still requires connection and route authority. See [architecture.md](architecture.md) for the ownership map.

## Paths and identity

`defaultDataDir` in `server/host/runtime.ts` chooses the development host's platform data directory. The installed application uses its own selected state. Keep development experiments out of the installed application's records.

The host's private data includes its SQLite state, writer-lock database, `admin-credential`, runtime descriptor and logs. The descriptor `host-runtime.json` identifies the actual origin, process and store authority; it carries no bearer and may outlive its process. A file on disk is not proof that a host is alive.

`server/host/index.ts` owns explicit `--data-dir`, `--web-root`, `--port`, `--descriptor`, `--config-dir` and `--owner-profile` selection. [Local development](local-development.md) contains the foreground commands and environment precedence. [Mac installation](macos-install.md) owns the installed configuration selector.

## Browser pairing

`pairLocal` in `server/host/runtime.ts` reads the existing protected credential and verifies the current host identity before returning a pairing code. The browser uses the code, not the admin credential. Pairing a web session does not grant microphone, device-notification or arbitrary native authority. See [service.md](service.md) and [web-client.md](web-client.md).

## App-owned supervision

`supervise` in `server/host/supervision.ts` implements `--supervised`. The native supervisor starts the child with an anonymous stdin pipe and sends a bounded start frame with a nonce. The host emits its ready frame only after actual startup and keeps the pipe as its lifetime boundary. EOF shuts the owned host down; a nonce is rendezvous metadata, not an authentication secret.

`NativeServiceSupervisor` in `Sources/LuxDidi/NativeServiceSupervisor.swift` owns the native side. Keep the frame schema in those source owners rather than copying it into a second parser or this page. Ordinary foreground starts do not require the supervised handshake.

## Configured does not mean reachable

Providers and connectors report locally validated configuration separately from real availability. A missing or disabled provider must not be disguised as a working connected conversation. [Provider configuration](provider-configuration.md) and [MCP configuration](mcp-configuration.md) own their schemas and sign-in requirements.

Text acceptance, durable dispatch and restart recovery belong to `ChatService`; a process restart is not permission to repeat an uncertain turn. Live recovery belongs to `LiveSessionOwner`, with its own call-generation and authority checks. Do not copy one owner's retry policy into the other.

## Shutdown and evidence

Ctrl-C or SIGTERM stops a foreground host without deleting records. The app-owned child follows its supervisor lifetime. Keep a failed instance's evidence and diagnose the owning layer rather than deleting state until startup appears green.

[Checks](checks.md) describes the host, connected, package and native proofs. Browser proof is not installed-app or audio evidence; synthetic provider transport is not a real key or network check. [Debugging](debugging.md) and [diagnostic store](diagnostic-store.md) explain safe operational evidence.
