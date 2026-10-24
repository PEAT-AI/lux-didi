import type {
  LiveVoiceCapabilities, LiveVoiceControl, LiveVoiceEvent, LiveVoiceOutcome, LiveVoicePort,
  LiveVoiceRequest, LiveVoiceSession, LiveToolResponse, LiveToolSendOutcome,
} from '../../adapters/live-voice/index.js';

/** A test-only port whose capabilities differ from the Gemini adapter, so the host cannot key on a model name. */
export type FakeLiveVoiceEvent =
  | { type: 'audio'; pcm: Uint8Array; rate: number; audible?: boolean; rmsDbfs?: number }
  | { type: 'modelTurnStarted' }
  | { type: 'generationComplete' } | { type: 'turnComplete' } | { type: 'interrupted' }
  | { type: 'resumptionHandle'; handle: string }
  | { type: 'goAway'; timeLeftMs: number }
  | { type: 'inputTranscription' | 'outputTranscription'; text: string; finished?: boolean; finalOrigin?: string }
  | { type: 'modelText'; text: string; thought: boolean };
export interface FakeLiveVoice {
  readonly port: LiveVoicePort;
  readonly requests: LiveVoiceRequest[];
  readonly toolResponses: LiveToolResponse[][];
  /** Every text input the host pushed, so a test can see the dead-air nudge itself (#538). */
  readonly texts: string[];
  /** How many provider sessions the host closed, so a test can tell a nudge from a recreate (#538). */
  readonly closes: number;
  /** Push one event into the open session (a no-op before the first open). */
  emit(event: FakeLiveVoiceEvent): void;
  readonly sessionsOpened: number;
}

export function fakeLiveVoicePort(overrides: Partial<LiveVoiceCapabilities> = {}): FakeLiveVoice {
  const capabilities: LiveVoiceCapabilities = Object.freeze({
    provider: 'gemini',
    supportsResumption: false,
    supportsGoAway: false,
    supportsInterruption: false,
    supportsServerVadConfig: false,
    inputRates: Object.freeze([8000]),
    outputRates: Object.freeze([24000]),
    outputModalities: Object.freeze(['audio', 'text'] as const),
    thinking: 'provider_default',
    supportsToolScheduling: false,
    toleratesEmptyReadyLifecycle: false,
    ...overrides,
  });
  const requests: LiveVoiceRequest[] = [];
  const toolResponses: LiveToolResponse[][] = [];
  const texts: string[] = [];
  let closes = 0;
  let sessionsOpened = 0;
  let emit: (event: FakeLiveVoiceEvent) => void = () => {};

  const port: LiveVoicePort = {
    capabilities,
    open(request: LiveVoiceRequest, control: LiveVoiceControl): LiveVoiceSession {
      sessionsOpened += 1;
      requests.push(request);
      let closed = false;
      let resolveDone: (value: LiveVoiceOutcome) => void = () => {};
      const done = new Promise<LiveVoiceOutcome>(resolve => { resolveDone = resolve; });
      const pending: LiveVoiceEvent[] = [];
      let waiter: (() => void) | undefined;
      const wake = () => { const waiting = waiter; waiter = undefined; if (waiting) waiting(); };
      let sequence = 0;
      emit = event => { pending.push({ ...event, sequence: ++sequence } as LiveVoiceEvent); wake(); };
      control.signal.addEventListener('abort', () => {
        if (closed) return;
        closed = true; wake(); resolveDone({ status: 'cancelled', code: 'cancelled' });
      }, { once: true });
      let readySeen = false;
      const events: AsyncIterable<LiveVoiceEvent> = {
        async *[Symbol.asyncIterator]() {
          while (!closed) {
            if (!readySeen) { readySeen = true; yield { sequence: ++sequence, type: 'ready' }; continue; }
            if (!pending.length) { await new Promise<void>(resolve => { waiter = resolve; }); continue; }
            yield pending.shift()!;
          }
        },
      };
      return {
        ready: Promise.resolve(),
        events,
        done,
        sendToolResponse(input: { responses: LiveToolResponse[] }): LiveToolSendOutcome { toolResponses.push(input.responses); return 'sent'; },
        sendAudio(): void {}, sendText(input: { text: string }): void { texts.push(input.text); }, endAudioStream(): void {},
        close(): void { if (closed) return; closed = true; closes += 1; wake(); resolveDone({ status: 'closed', code: 'closed' }); },
      };
    },
  };
  return { port, requests, toolResponses, texts, emit: event => emit(event),
    get sessionsOpened() { return sessionsOpened; }, get closes() { return closes; } };
}
