/** Shared semantic status debounce, palette and status-only colour blending. */
import type { OrbPosture } from './orb-level.ts';

export type MiniVisualState = 'cold' | 'connecting' | 'listening' | 'thinking' | 'tool' | 'speaking' | 'hot-muted';

/** A hue change is a crossfade of the two state layers, never a hue number walked
 *  through the colour wheel: teal 167 to amber 34 walked through the wheel passes
 *  saturated lime, which is why M3-R6 forbids it. */
export interface HueMix {
  from: number;
  to: number;
  /** The eased crossfade, 0 for the old layer only, 1 for the new one only. */
  t: number;
}

export interface OrbVisual {
  state: MiniVisualState;
  /** HSL degrees, the same unit orb.ts hands the classic renderer. */
  hue: number;
  /** Presence glow the renderer draws, 0..1. */
  glow: number;
  /** Multiplier on the renderer's resting activity, 0..1. */
  amplitude: number;
  /** The canvas opacity at the middle of this state's breathe, 0..1. */
  opacity: number;
  /** How grey the canvas is, 0..1. Only the cold state takes any colour out. */
  grey: number;
  /** How bright the canvas is, 0..1. The quiet states are dimmer as well as greyer. */
  bright: number;
  /** The breathe period in ms for the opacity, 0 for a state that only breathes with its own motion. */
  breatheMs: number;
  /** The renderer's motion character for this state. */
  posture: OrbPosture;
  /** Listening follows the owner's microphone; speaking follows Naya's output. */
  followsMic: boolean;
  followsOutput: boolean;
  /** Present while two states are crossfading. `hue` is always the layer being faded in. */
  mixing?: HueMix;
}

/** The one visual per state. `off` and `muted` share the quiet posture (a slow
 *  six second breathe) and differ only in glow and amplitude; `thinking` sits
 *  between the listening teal and the tool amber, so a shift toward amber is
 *  visible before the tool itself. */
/** The one visual per state. `cold` is the pill with no session: 35 percent grey and a
 *  very slow nine second breathe. `hot-muted` is the same orb with the owner's mute on:
 *  purple, a six second breathe, so muted can never be read as cold. M3-R4: thinking and tool are both the
 *  palette's amber at full strength, so neither can be read as the listening teal; the two
 *  are told apart by motion, the thinking swirl and the tool's steady orbiting highlight. */
export const ORB_VISUALS: Readonly<Record<MiniVisualState, OrbVisual>> = {
  cold: { state: 'cold', hue: 216, glow: 0.1, amplitude: 0.45, opacity: 0.30, grey: 0.95, bright: 0.8, breatheMs: 9000, posture: 'quiet', followsMic: false, followsOutput: false },
  // M3-R5: the orb renders the connecting moment too, dimmer than listening and with the
  // thinking rotation, so a session coming up is visible on the orb itself.
  connecting: { state: 'connecting', hue: 216, glow: 0.18, amplitude: 0.6, opacity: 0.50, grey: 0.7, bright: 0.9, breatheMs: 6000, posture: 'thinking', followsMic: false, followsOutput: false },
  listening: { state: 'listening', hue: 167, glow: 0.4, amplitude: 0.9, opacity: 0.92, grey: 0, bright: 1, breatheMs: 0, posture: 'listening', followsMic: true, followsOutput: false },
  thinking: { state: 'thinking', hue: 34, glow: 0.32, amplitude: 0.8, opacity: 0.92, grey: 0, bright: 1, breatheMs: 0, posture: 'thinking', followsMic: false, followsOutput: false },
  tool: { state: 'tool', hue: 34, glow: 0.44, amplitude: 0.78, opacity: 0.92, grey: 0, bright: 1, breatheMs: 0, posture: 'thinking', followsMic: false, followsOutput: false },
  speaking: { state: 'speaking', hue: 173, glow: 0.45, amplitude: 1, opacity: 0.92, grey: 0, bright: 1, breatheMs: 0, posture: 'speaking', followsMic: false, followsOutput: true },
  'hot-muted': { state: 'hot-muted', hue: 278, glow: 0.3, amplitude: 0.5, opacity: 0.55, grey: 0, bright: 0.95, breatheMs: 6000, posture: 'quiet', followsMic: false, followsOutput: false },
};

/** #1021: the owner's mute, as the native app pushes it (`window.didiPresence.muted`). It is the
 *  owner's own word and it outlives the session: the provider is closed at the mute, so no live
 *  state is left to carry it, and the orb is purple until the next tap. */
export function presenceMuted(source: unknown = (globalThis as { didiPresence?: unknown }).didiPresence): boolean {
  return typeof source === 'object' && source !== null && (source as { muted?: unknown }).muted === true;
}

/** M3: the mini route's state machine eases the numbers itself and hands them to the one
 *  renderer through this store, so the pill needs no second renderer. The full window
 *  publishes nothing and keeps its own posture and hue rules, with the mute as the one
 *  exception it now shares. */
export interface OrbVisualOverride {
  hue?: number;
  glow?: number;
  amplitude?: number;
  posture?: OrbPosture;
  /** The crossfading layers, when a state change is in flight. */
  mixing?: HueMix;
}

const published = new WeakMap<HTMLCanvasElement, OrbVisualOverride>();
const refreshers = new WeakMap<HTMLCanvasElement, () => void>();

/** Hand the renderer on this canvas the numbers to draw with. `undefined` clears them. */
export function publishOrbVisual(canvas: HTMLCanvasElement, visual: OrbVisual | OrbVisualOverride | undefined): void {
  if (visual) published.set(canvas, visual); else published.delete(canvas);
  // A reduced-motion pill never runs the frame loop, so ask for the one still frame
  // that shows the new colour.
  refreshers.get(canvas)?.();
}

export function orbVisualOf(canvas: HTMLCanvasElement): OrbVisualOverride | undefined {
  return published.get(canvas);
}

/** The renderer offers one still frame; the store calls it when the loop cannot. */
export function registerOrbRenderer(canvas: HTMLCanvasElement, refresh: () => void): void {
  refreshers.set(canvas, refresh);
}

/** Every change interpolates over half a second, inside the owner's 450 to 600 ms. */
export const TRANSITION_MS = 500;
/** Anything shorter than a quarter second is a flicker, not a state. */
export const DEBOUNCE_MS = 250;

/** D6: the same flicker rule the mini pill applies, for any state word a surface paints. A request only
 *  commits once its state has lasted DEBOUNCE_MS, so speaking, listening, speaking inside one blink leaves
 *  the surface on speaking. Presentation only: lifecycle events are never debounced this way (amendment D). */
export interface StateDebounce<S extends string> {
  state(): S;
  request(state: S, at: number): void;
  /** The state visible at `at`, committing a pending change once it has lasted the debounce. */
  settled(at: number): S;
  /** When the pending change commits, or undefined when nothing is pending. */
  dueAt(): number | undefined;
}

export function createStateDebounce<S extends string>(initial: S, ms = DEBOUNCE_MS): StateDebounce<S> {
  let current = initial;
  let pending: { state: S; since: number } | undefined;
  return {
    state: () => current,
    request(state, at) {
      if (state === current) { pending = undefined; return; }
      if (pending?.state === state) return;
      pending = { state, since: at };
    },
    settled(at) {
      if (pending && at - pending.since >= ms) { current = pending.state; pending = undefined; }
      return current;
    },
    dueAt() { return pending === undefined ? undefined : pending.since + ms; },
  };
}

/** The breathe on the opacity: one slow sine at the state's period, so the orb is alive
 *  without a level. Pure in the clock, so the curve is testable. */
export function breathe(base: number, breatheMs: number, at: number, depth = 0.05): number {
  if (!breatheMs) return base;
  return Math.max(0, Math.min(1, base + depth * Math.sin((2 * Math.PI * at) / breatheMs)));
}

/** Ease-in-out (sinusoidal): zero slope at both ends, so a transition never starts or stops hard. */
export function easeInOut(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return (1 - Math.cos(Math.PI * c)) / 2;
}

/** Between two visuals: the scalars interpolate, and the colour is handed over as the
 *  two layers plus the crossfade, so no hue number is ever walked through the wheel.
 *  Posture and the level source switch at the commit, because the renderer already eases
 *  its own motion character. */
export function mixVisual(from: OrbVisual, to: OrbVisual, t: number): OrbVisual {
  const k = easeInOut(t);
  const at = (a: number, b: number) => a + (b - a) * k;
  return {
    ...to,
    glow: at(from.glow, to.glow),
    amplitude: at(from.amplitude, to.amplitude),
    opacity: at(from.opacity, to.opacity),
    grey: at(from.grey, to.grey),
    bright: at(from.bright, to.bright),
    mixing: { from: from.hue, to: to.hue, t: k },
  };
}

export interface OrbVisualBlend {
  request(state: MiniVisualState, at: number): void;
  visual(at: number): OrbVisual;
}

/** Blend already-settled status colours only; body motion belongs to MotionCoordinator. */
export function createOrbVisualBlend(
  initial: MiniVisualState = 'cold',
  options: { reducedMotion?: boolean } = {},
): OrbVisualBlend {
  let target = ORB_VISUALS[initial];
  let from = target;
  let start = -Infinity;
  const visual = (at: number): OrbVisual => options.reducedMotion
    ? target : mixVisual(from, target, Math.min(1, Math.max(0, (at - start) / TRANSITION_MS)));
  return {
    request(state, at) {
      if (target.state === state) return;
      from = visual(at);
      target = ORB_VISUALS[state];
      start = at;
    },
    visual,
  };
}
