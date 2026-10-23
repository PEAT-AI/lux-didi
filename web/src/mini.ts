/** The transparent floating orb reuses the canonical renderer at 220 CSS pixels. */
import type { VoiceState } from './orb.ts';
import { createOrbVisualBlend, presenceMuted, publishOrbVisual, type MiniVisualState, type OrbVisual } from './orb-states.ts';
import type { LiveActivity } from './live-view.ts';

export type MiniState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'connecting' | 'tool' | 'error';

/** The compact route is a query on the one built page, so the loopback static
 * handler and the same compiled assets serve it unchanged. */
export function isMiniRoute(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'mini';
}

/** #1021: muted is the owner's word, and it outlives the session (the provider is closed at the
 *  mute), so the pill is purple for the live mute and for the native push alike. */
export function pillMuted(liveMuted: boolean, presence: unknown = (globalThis as { didiPresence?: unknown }).didiPresence): boolean {
  return liveMuted || presenceMuted(presence);
}

/** The one glance state for the pill: listening, thinking, speaking, muted,
 * connecting, a running tool, or error. Muted and connecting are their own
 * states so the pill can dim or spin instead of borrowing the thinking shimmer,
 * and tool activity outranks the quieter voice states so a long call stays
 * visible under the orb. */
export function miniState(voice: VoiceState, activity: LiveActivity | undefined, muted = false): MiniState {
  if (voice === 'ERROR' || voice === 'DISCONNECTED' || voice === 'INTERRUPTED') return 'error';
  if (muted) return 'muted';
  if (voice === 'CONNECTING') return 'connecting';
  if (activity?.kind === 'tools' || activity?.kind === 'failed') return 'tool';
  if (voice === 'SPEAKING') return 'speaking';
  if (voice === 'LISTENING') return 'listening';
  if (voice === 'PROCESSING' || activity?.kind === 'thinking') return 'thinking';
  return 'idle';
}

/** The floating surface contains the canonical orb and an accessible state label. */
/** The state in words for a screen reader only: no visible text lives in the pill. */
const MINI_ARIA: Readonly<Record<MiniState, string>> = {
  idle: 'Naya is off',
  listening: 'Naya is listening',
  thinking: 'Naya is thinking',
  speaking: 'Naya is speaking',
  muted: 'Naya is muted',
  connecting: 'Naya is connecting',
  tool: 'Naya is using a tool',
  error: 'Naya could not start',
};

export function miniAriaLabel(state: MiniState): string {
  return MINI_ARIA[state];
}

export function miniMarkup(state: MiniState, _caption = ''): string {
  return '<div class="mini-pill">'
    + `<section class="mini-stage" data-mini-state="${state}" aria-label="${miniAriaLabel(state)}">`
    + '<canvas id="didi-orb" width="440" height="440" aria-hidden="true"></canvas></section></div>';
}

/** The FULL window's one mode control (#311): a visible button with an
 * accessible label that asks the native app for the mini orb. Only the native
 * app can move a surface, so a browser shell renders no button at all. */
export function miniModeButtonMarkup(native: boolean, id = 'mini-mode'): string {
  return native
    ? `<button id="${id}" data-mini-mode class="quiet mini-mode" aria-label="Show the mini orb" title="Mini interface (Control-Option-Space)">Mini</button>`
    : '';
}

/** M3: which visual a state shows. M3-R5 gives the orb a visual for the connecting
 *  moment; `error` stays on the dim cold orb. */
export function visualState(state: MiniState): MiniVisualState {
  switch (state) {
    case 'listening': case 'thinking': case 'tool': case 'speaking': case 'connecting': return state;
    // M3-R2: the owner's words for the two quiet states. Muted is hot-muted, because
    // the microphone is live and switched off; everything else is cold.
    case 'muted': return 'hot-muted';
    default: return 'cold';
  }
}

/** M3-R2: the click on the orb and the Right Command tap are one press, and the press
 *  has three steps: nothing live connects, a live orb mutes the microphone hot, a hot
 *  muted orb brings the microphone back. The pill answers with the step; the app owns
 *  the one native toggle. */
export type PresenceStep = 'connect' | 'hot-mute' | 'live';

export function clickStep(state: MiniState): PresenceStep {
  if (state === 'idle' || state === 'error' || state === 'connecting') return 'connect';
  if (state === 'muted') return 'live';
  return 'hot-mute';
}

/** The visual the loop last painted, so a strip can prove a transition moved the colour
 *  without anyone opening an image. */
let painted: OrbVisual | undefined;
let refreshVisuals: (() => void) | undefined;
export function refreshMiniVisuals(): void { refreshVisuals?.(); }

export interface PillVisualHost { didiOrbVisual?: () => OrbVisual | undefined }

export function installMiniVisuals(host: PillVisualHost = globalThis as PillVisualHost): void {
  host.didiOrbVisual = () => painted;
}
installMiniVisuals();

/** The stage's state, or the cold state when there is no stage yet. */
export function pillState(stage: Element | null | undefined): MiniState {
  const value = stage?.getAttribute('data-mini-state');
  return value === 'listening' || value === 'thinking' || value === 'tool' || value === 'speaking'
    || value === 'muted' || value === 'connecting' || value === 'error' ? value : 'idle';
}

/** M3-R2: the native press asks the page which of the three steps it means, because the
 *  page owns the state it paints; the app then runs its one native toggle. */
export interface PillClickHost { didiClickStep?: () => PresenceStep }

export function installMiniClick(host: PillClickHost = globalThis as PillClickHost): void {
  host.didiClickStep = () => {
    if (typeof document === 'undefined') return 'connect';
    return clickStep(pillState(document.querySelector('.mini-stage')));
  };
}
installMiniClick();

/** The pill's one animation loop, and the seams a test needs to run it without a browser. */
export interface MiniOrbScope {
  doc?: Pick<Document, 'querySelector'>;
  now?: () => number;
  reducedMotion?: () => boolean;
  frame?: (tick: () => void) => number;
  cancel?: (handle: number) => void;
  publish?: (canvas: HTMLCanvasElement, visual: OrbVisual) => void;
}

/** M3: one loop for the pill. It reads the state main.ts already paints on the stage,
 *  eases it through the state machine and hands the renderer the colour, glow and
 *  amplitude. A thinking or muted orb never reacts to the microphone. Returns its cleanup. */
export function startMiniOrbVisuals(scope: MiniOrbScope = {}): () => void {
  const doc = scope.doc ?? (typeof document === 'undefined' ? undefined : document);
  const frame = scope.frame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined);
  const cancel = scope.cancel ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined);
  if (!doc || !frame) return () => {};
  const now = scope.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
  const reducedMotion = scope.reducedMotion ?? (() => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false));
  const machine = createOrbVisualBlend('cold', { reducedMotion: reducedMotion() });
  let handle: number | undefined;
  let stopped = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  const visible = () => typeof document === 'undefined'
    || (!document.hidden && (globalThis as { didiNativeSurfaceVisible?: boolean }).didiNativeSurfaceVisible !== false);
  const paint = () => {
    const at = now();
    const stage = doc.querySelector('.mini-stage');
    machine.request(visualState(pillState(stage)), at);
    const visual = machine.visual(at);
    painted = visual;
    const canvas = stage?.querySelector('canvas') as HTMLCanvasElement | null | undefined;
    if (canvas) (scope.publish ?? publishOrbVisual)(canvas, visual);
    // The opacity, the grey and the wash are the state machine's numbers, painted as CSS
    // variables so the stylesheet owns the drawing and the breath stays a pure function of
    // the clock. The wash lives on the pill, outside the stage.
    const element = stage as HTMLElement | null | undefined;
    element?.style?.setProperty('--mini-orb-opacity', visual.opacity.toFixed(3));
    element?.style?.setProperty('--mini-orb-grey', visual.grey.toFixed(3));
    element?.style?.setProperty('--mini-orb-bright', visual.bright.toFixed(3));
    // The wash is drawn by the stage, so it scales with the orb (M3-R6).
    element?.style?.setProperty('--mini-wash', visual.glow.toFixed(3));
  };
  const step = () => {
    handle = undefined;
    if (stopped || !visible()) return;
    paint();
    if (!reducedMotion()) handle = frame(step);
  };
  const refresh = () => {
    if (handle !== undefined) cancel?.(handle);
    handle = undefined;
    if (settle !== undefined) clearTimeout(settle);
    if (!visible()) return;
    paint();
    if (reducedMotion()) settle = setTimeout(() => { if (!stopped && visible()) paint(); }, 260);
    else handle = frame(step);
  };
  refreshVisuals = paint;
  if (typeof window !== 'undefined') window.addEventListener('didi-surface-visibility', refresh);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', refresh);
  handle = frame(step);
  return () => {
    stopped = true;
    if (handle !== undefined) cancel?.(handle);
    if (settle !== undefined) clearTimeout(settle);
    if (refreshVisuals === paint) refreshVisuals = undefined;
    if (typeof window !== 'undefined') window.removeEventListener('didi-surface-visibility', refresh);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', refresh);
  };
}

// M3: the pill is its own route, so the loop runs only there. A browser preview of the
// full window pays nothing for it.
if (typeof location !== 'undefined' && isMiniRoute(location.search)) startMiniOrbVisuals();
