// Native-to-web bridge, exactly per reports/lux-didi-stability-1015/BRIDGE.md (V1 native shell, V2 web lanes).
// Transport: web -> native via window.webkit.messageHandlers.didi.postMessage; native -> web via window.didiNative.receive.
// The web installs window.didiNative before it posts ready. Unknown type on either side is logged (type name only) and
// ignored. When window.webkit is absent (browser preview, tests) a fake native simulates hydrate and liveState so the
// preview and tests run headless.

export type NativeLiveState = 'idle' | 'starting' | 'live' | 'muted' | 'stopping' | 'error';
export type NativeLiveError = 'micDenied' | 'deviceUnavailable' | 'providerError' | 'ended';
export type MicStatus = 'granted' | 'denied' | 'undetermined';
export type ThemeMode = 'dark' | 'light';

export interface Route {
  input: string;
  output: string;
  voiceProcessing: boolean;
}

export interface NativeLiveProjection {
  state: NativeLiveState;
  error?: NativeLiveError;
  reason?: string;
}

export interface HydrateMessage {
  type: 'hydrate';
  consent: boolean;
  mic: MicStatus;
  live: NativeLiveProjection;
  route: Route | null;
  theme: ThemeMode;
  lastSessionEndedAt: string | null;
  /** #352: the read-only Mic Mode row; a reload never shows the line. */
  micMode?: Omit<MicModeMessage, 'type'> | null;
}

export interface LiveStateMessage extends NativeLiveProjection {
  type: 'liveState';
}

/** #352: the Mac's Mic Mode. Read-only names, and whether the full app may show its one quiet line. */
export interface MicModeMessage {
  type: 'micMode';
  preferred: string;
  active: string;
  prompt: boolean;
}

export interface RequestMessage {
  type: 'requestStart' | 'requestStop';
}

export interface RouteMessage extends Route {
  type: 'route';
}

export interface LevelsMessage {
  type: 'levels';
  input: number[];
  output: number[];
}

export type NativeToWeb =
  | HydrateMessage
  | LiveStateMessage
  | MicModeMessage
  | RequestMessage
  | RouteMessage
  | LevelsMessage;

export type WebToNative =
  | { type: 'ready' }
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'consentGranted' }
  | { type: 'mini' }
  | { type: 'showMicrophoneModes' }
  | { type: 'theme'; mode: ThemeMode }
  | { type: 'openExternal'; url: string };

const INBOUND_TYPES: ReadonlySet<string> = new Set([
  'hydrate',
  'liveState',
  'micMode',
  'requestStart',
  'requestStop',
  'route',
  'levels',
]);

/** Diagnostic sink: the host log or native-live.log, type name only, never a payload. */
export type BridgeLog = (kind: 'inbound' | 'outbound', type: string) => void;

export interface Bridge {
  /** Route the next outbound message to native (a real transport, or the fake). */
  useTransport(post: (message: WebToNative) => void): void;
  /** Install window.didiNative.receive. Call before posting ready. */
  install(target: { didiNative?: { receive(message: unknown): void } }): void;
  send(message: WebToNative): void;
  receive(raw: unknown): void;
  onNative(handler: (message: NativeToWeb) => void): () => void;
}

/** Validate one native -> web message; an unknown or malformed type is logged and dropped. */
function parseInbound(raw: unknown, log: BridgeLog): NativeToWeb | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== 'string') return undefined;
  if (!INBOUND_TYPES.has(type)) {
    log('inbound', type);
    return undefined;
  }
  return raw as NativeToWeb;
}

export function createBridge(log: BridgeLog = () => {}): Bridge {
  let transport: (message: WebToNative) => void = () => {};
  const handlers = new Set<(message: NativeToWeb) => void>();
  const bridge: Bridge = {
    useTransport(post) {
      transport = post;
    },
    install(target) {
      target.didiNative = { receive: (message: unknown) => bridge.receive(message) };
    },
    send(message) {
      transport(message);
    },
    receive(raw) {
      const message = parseInbound(raw, log);
      if (!message) return;
      for (const handler of handlers) handler(message);
    },
    onNative(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return bridge;
}

/** The real native transport, or undefined when running in a plain browser. */
export function nativeTransport(win: unknown): ((message: WebToNative) => void) | undefined {
  const handler = (win as { webkit?: { messageHandlers?: { didi?: { postMessage?: unknown } } } })
    ?.webkit?.messageHandlers?.didi;
  if (handler && typeof handler.postMessage === 'function') {
    return (message) => (handler.postMessage as (m: WebToNative) => void)(message);
  }
  return undefined;
}

export interface FakeSeed {
  consent?: boolean;
  mic?: MicStatus;
  live?: NativeLiveProjection;
  route?: Route | null;
  theme?: ThemeMode;
  lastSessionEndedAt?: string | null;
}

export interface FakeNative {
  /** The simulated native state, mutated by the web's outbound messages. */
  readonly state: Required<Omit<FakeSeed, 'route'>> & { route: Route | null };
  /** The native side of the bridge: feed it every web -> native message. */
  handle(message: WebToNative): void;
  /** Simulate a native menu or shortcut asking the web state machine to start or stop. */
  requestStart(): void;
  requestStop(): void;
  /** Simulate a batched levels message (at most 20 per second, never per audio buffer). */
  levels(input: number[], output: number[]): void;
}

/**
 * The in-process native double. It answers `ready` with `hydrate`, mirrors `liveState`, persists consent, records the
 * theme choice and can raise `requestStart`/`requestStop`/`levels` exactly like the real shell.
 */
export function createFakeNative(deliver: (message: NativeToWeb) => void, seed: FakeSeed = {}): FakeNative {
  const state = {
    consent: seed.consent ?? false,
    mic: seed.mic ?? 'undetermined',
    live: { ...(seed.live ?? { state: 'idle' }) } as NativeLiveProjection,
    route: seed.route ?? null,
    theme: seed.theme ?? 'dark',
    lastSessionEndedAt: seed.lastSessionEndedAt ?? null,
  };
  const emit = (message: NativeToWeb) => deliver(message);
  const setLive = (next: NativeLiveProjection) => {
    state.live = next;
    emit({ type: 'liveState', ...next });
  };
  return {
    state,
    handle(message) {
      if (!message || typeof message.type !== 'string') return;
      switch (message.type) {
        case 'ready':
          emit({
            type: 'hydrate',
            consent: state.consent,
            mic: state.mic,
            live: { ...state.live },
            route: state.route,
            theme: state.theme,
            lastSessionEndedAt: state.lastSessionEndedAt,
          });
          if (state.live.state !== 'idle') emit({ type: 'liveState', ...state.live });
          break;
        case 'start':
          if (state.mic === 'denied') {
            setLive({ state: 'error', error: 'micDenied' });
            break;
          }
          setLive({ state: 'starting' });
          setLive({ state: 'live' });
          break;
        case 'stop':
          setLive({ state: 'stopping' });
          setLive({ state: 'idle' });
          break;
        case 'mute':
          if (state.live.state === 'live') setLive({ state: 'muted' });
          break;
        case 'unmute':
          if (state.live.state === 'muted') setLive({ state: 'live' });
          break;
        case 'consentGranted':
          state.consent = true;
          break;
        case 'theme':
          state.theme = message.mode;
          break;
        case 'openExternal':
          break;
        default:
          break;
      }
    },
    requestStart() {
      emit({ type: 'requestStart' });
    },
    requestStop() {
      emit({ type: 'requestStop' });
    },
    levels(input, output) {
      emit({ type: 'levels', input, output });
    },
  };
}

/**
 * Install the bridge on a window. Real transport when window.webkit.messageHandlers.didi exists, otherwise the fake.
 * window.didiNative is installed first, so the subsequent `ready` post may be answered without loss.
 */
export function installNativeBridge(
  win: Record<string, unknown>,
  log: BridgeLog = () => {},
  seed: FakeSeed = {},
): { bridge: Bridge; fake?: FakeNative } {
  const bridge = createBridge(log);
  const real = nativeTransport(win);
  let fake: FakeNative | undefined;
  if (real) {
    bridge.useTransport(real);
  } else {
    fake = createFakeNative((message) => bridge.receive(message), seed);
    bridge.useTransport((message) => fake!.handle(message));
  }
  bridge.install(win as { didiNative?: { receive(message: unknown): void } });
  return { bridge, fake };
}
