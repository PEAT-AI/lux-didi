/** MINI2: the pill, the MINI surface at 64x26 pt.
 *
 * Reuses the authorized Canvas renderer (orb.ts) at 18 pt, so there is one
 * renderer and one voice surface. The mini route is the same built page with
 * `?view=mini`; main.ts renders this markup instead of the full window shell.
 * The pill carries no text at all: an orb and a 5-bar level meter.
 */
import type { VoiceState } from './orb.ts';
import { breathe, createOrbStateMachine, publishOrbVisual, type MiniVisualState, type OrbVisual } from './orb-states.ts';
import type { LiveActivity } from './live-view.ts';

export type MiniState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'connecting' | 'tool' | 'error';

/** The compact route is a query on the one built page, so the loopback static
 * handler and the same compiled assets serve it unchanged. */
export function isMiniRoute(search: string): boolean {
  return new URLSearchParams(search).get('view') === 'mini';
}

/** The one glance state for the pill: listening, thinking, speaking, muted,
 * connecting, a running tool, or error. Muted and connecting are their own
 * states so the pill can dim or spin instead of borrowing the thinking shimmer,
 * and tool activity outranks the quieter voice states so a long call stays
 * visible under the orb. */
export function miniState(voice: VoiceState, activity: LiveActivity | undefined, muted = false): MiniState {
  if (voice === 'ERROR' || voice === 'DISCONNECTED' || voice === 'INTERRUPTED') return 'error';
  if (activity?.kind === 'tools' || activity?.kind === 'failed') return 'tool';
  // The live projection carries mute beside the voice state, not inside it.
  if (muted) return 'muted';
  if (voice === 'CONNECTING') return 'connecting';
  if (voice === 'SPEAKING') return 'speaking';
  if (voice === 'LISTENING') return 'listening';
  if (voice === 'PROCESSING' || activity?.kind === 'thinking') return 'thinking';
  return 'idle';
}

/** The pill's markup: the orb canvas and five level bars, and no text. The
 * caption parameter is kept so the caller needs no change; the pill ignores it,
 * because the decision file says no text in the pill. */
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
  const bars = Array.from({ length: 5 }, (_, index) => `<i data-bar="${index + 1}"></i>`).join('');
  return `<section class="mini-stage mini-pill" data-mini-state="${state}" aria-label="${miniAriaLabel(state)}">`
    + `<div class="presence-glow" aria-hidden="true"></div>`
    + `<canvas id="didi-orb" width="72" height="72" aria-hidden="true"></canvas>`
    + `<div class="mini-level" aria-hidden="true">${bars}</div></section>`;
}

/** Each bar's share of the stage height for one input level (0...1), so the
 * meter is a measured function and not only a keyframe (review B5). Pure, so the
 * curve is tested without a DOM. */
export function miniBarHeights(level: number): number[] {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  return [1, 0.78, 1.12, 0.84, 1.04].map(share => Math.max(0.06, Math.min(1, clamped * share)));
}

/** Writes one level onto the pill: the CSS variables the five bars scale by, and
 * the flag that tells the stylesheet a native push is live. */
export function miniMeter(stage: Element | null, level: number): void {
  if (!stage) return;
  const heights = miniBarHeights(level);
  stage.querySelectorAll<HTMLElement>('.mini-level i').forEach((bar, index) => {
    bar.style.height = `${(heights[index] ?? 0) * 100}%`;
  });
  stage.classList.add('has-level');
}

/** The global the native app evaluates in the pill's web view, the same shape the
 * full route's renderer already reads. Installed once, when the module loads, so
 * the pill meters without a second round of wiring. */
export interface PillLevelHost { didiPillLevel?: (level: number) => void }

/** The last microphone level a native push delivered, and the visual gate over it: a
 *  pill that is thinking, using a tool, muted or off never reacts to the microphone. */
let pillMic = 0;

export function installMiniMeter(host: PillLevelHost = globalThis as PillLevelHost): void {
  host.didiPillLevel = (level: number) => {
    // A preview or a test has no document; the hook is still installed and inert.
    if (typeof document === 'undefined') return;
    // M3: the level is remembered, never painted here, so the pill's own state decides
    // whether the microphone may move the bars at all.
    pillMic = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  };
}
installMiniMeter();

/** The FULL window's one mode control (#311): a visible button with an
 * accessible label that asks the native app for the mini orb. Only the native
 * app can move a surface, so a browser shell renders no button at all. */
export function miniModeButtonMarkup(native: boolean): string {
  return native
    ? '<button id="mini-mode" class="quiet mini-mode" aria-label="Show the mini orb" title="Mini orb (Control-Option-Space)">mini</button>'
    : '';
}

/** M3: which visual a pill state shows. `connecting` and `error` are not visuals of
 *  their own: the pill is dim until there is something to say, and the CSS spinner
 *  still marks the connecting moment. */
export function visualState(state: MiniState): MiniVisualState {
  switch (state) {
    case 'listening': case 'thinking': case 'tool': case 'speaking': return state;
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
    return clickStep(pillState(document.querySelector('.mini-pill')));
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
 *  amplitude; the level bars follow the same gate, so a thinking or muted pill never
 *  reacts to the microphone. Returns the stop function. */
export function startMiniOrbVisuals(scope: MiniOrbScope = {}): () => void {
  const doc = scope.doc ?? (typeof document === 'undefined' ? undefined : document);
  const frame = scope.frame ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined);
  const cancel = scope.cancel ?? (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : undefined);
  if (!doc || !frame) return () => {};
  const now = scope.now ?? (() => (typeof performance === 'undefined' ? Date.now() : performance.now()));
  const reducedMotion = scope.reducedMotion ?? (() => (typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)').matches : false));
  const machine = createOrbStateMachine('cold', { reducedMotion: reducedMotion() });
  let handle: number | undefined;
  let stopped = false;
  const step = () => {
    if (stopped) return;
    const at = now();
    const stage = doc.querySelector('.mini-pill');
    machine.request(visualState(pillState(stage)), at);
    const visual = machine.visual(at);
    const canvas = stage?.querySelector('canvas') as HTMLCanvasElement | null | undefined;
    if (canvas) (scope.publish ?? publishOrbVisual)(canvas, visual);
    // The opacity and the grey are the state machine's numbers, painted as CSS variables
    // so the stylesheet owns the drawing and the breath stays a pure function of the clock.
    const element = stage as HTMLElement | null | undefined;
    element?.style?.setProperty('--mini-orb-opacity', breathe(visual.opacity, visual.breatheMs, at).toFixed(3));
    element?.style?.setProperty('--mini-orb-grey', visual.grey.toFixed(3));
    miniMeter(stage ?? null, visual.followsMic ? pillMic : 0);
    handle = frame?.(step);
  };
  handle = frame(step);
  return () => {
    stopped = true;
    if (handle !== undefined) cancel?.(handle);
  };
}

// M3: the pill is its own route, so the loop runs only there. A browser preview of the
// full window pays nothing for it.
if (typeof location !== 'undefined' && isMiniRoute(location.search)) startMiniOrbVisuals();
