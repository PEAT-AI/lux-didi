/** M3: the mini orb's visual state machine.
 *
 * The pill says everything with motion and colour, so each state is one visual:
 * off, listening, thinking, tool, speaking, muted. The numbers here are the
 * renderer's own units (HSL hue, a 0..1 glow and a 0..1 amplitude multiplier)
 * and the hues come from the mini palette tokens in style.css, so the orb and
 * the pill agree on one colour story.
 *
 * Two rules make the changes readable: a state that does not last DEBOUNCE_MS
 * never shows at all (a flicker is not a state), and every committed change
 * eases from the visual on screen to the new one over TRANSITION_MS with an
 * ease-in-out curve, so colour, glow and amplitude never jump.
 */
import type { OrbPosture } from './orb-level.ts';

export type MiniVisualState = 'cold' | 'listening' | 'thinking' | 'tool' | 'speaking' | 'hot-muted';

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
  /** How grey the canvas is, 0..1. Only the cold and hot-muted states take any colour out. */
  grey: number;
  /** The breathe period in ms for the opacity, 0 for a state that only breathes with its own motion. */
  breatheMs: number;
  /** The renderer's motion character for this state. */
  posture: OrbPosture;
  /** Listening follows the owner's microphone; speaking follows Naya's output. */
  followsMic: boolean;
  followsOutput: boolean;
}

/** The one visual per state. `off` and `muted` share the quiet posture (a slow
 *  six second breathe) and differ only in glow and amplitude; `thinking` sits
 *  between the listening teal and the tool amber, so a shift toward amber is
 *  visible before the tool itself. */
/** The one visual per state. `cold` is the pill with no session: 35 percent grey and a
 *  very slow nine second breathe. `hot-muted` is the same orb with the microphone off:
 *  grey, slightly more opaque, a six second breathe. `thinking` sits between the
 *  listening teal and the tool amber, so a shift toward amber shows before the tool. */
export const ORB_VISUALS: Readonly<Record<MiniVisualState, OrbVisual>> = {
  cold: { state: 'cold', hue: 216, glow: 0.1, amplitude: 0.45, opacity: 0.35, grey: 0.95, breatheMs: 9000, posture: 'quiet', followsMic: false, followsOutput: false },
  listening: { state: 'listening', hue: 167, glow: 0.4, amplitude: 0.9, opacity: 1, grey: 0, breatheMs: 0, posture: 'listening', followsMic: true, followsOutput: false },
  thinking: { state: 'thinking', hue: 74, glow: 0.32, amplitude: 0.8, opacity: 1, grey: 0, breatheMs: 0, posture: 'thinking', followsMic: false, followsOutput: false },
  tool: { state: 'tool', hue: 36, glow: 0.44, amplitude: 0.78, opacity: 1, grey: 0, breatheMs: 0, posture: 'thinking', followsMic: false, followsOutput: false },
  speaking: { state: 'speaking', hue: 173, glow: 0.45, amplitude: 1, opacity: 1, grey: 0, breatheMs: 0, posture: 'speaking', followsMic: false, followsOutput: true },
  'hot-muted': { state: 'hot-muted', hue: 216, glow: 0.12, amplitude: 0.5, opacity: 0.5, grey: 1, breatheMs: 6000, posture: 'quiet', followsMic: false, followsOutput: false },
};

/** Every change interpolates over half a second, inside the owner's 450 to 600 ms. */
export const TRANSITION_MS = 500;
/** Anything shorter than a quarter second is a flicker, not a state. */
export const DEBOUNCE_MS = 250;

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

/** Linear between two visuals. Posture and the level source switch at the
 *  commit, because the renderer already eases its own motion character. */
export function mixVisual(from: OrbVisual, to: OrbVisual, t: number): OrbVisual {
  const k = easeInOut(t);
  const at = (a: number, b: number) => a + (b - a) * k;
  return {
    ...to,
    hue: at(from.hue, to.hue),
    glow: at(from.glow, to.glow),
    amplitude: at(from.amplitude, to.amplitude),
    opacity: at(from.opacity, to.opacity),
    grey: at(from.grey, to.grey),
  };
}

export interface OrbStateMachine {
  /** The last state that survived the debounce. */
  state(at: number): MiniVisualState;
  /** Ask for a state. Asking twice for different states inside DEBOUNCE_MS is a flicker. */
  request(state: MiniVisualState, at: number): void;
  /** The visual on screen at this instant, eased. */
  visual(at: number): OrbVisual;
}

interface Pending { state: MiniVisualState; since: number }
interface Running { from: OrbVisual; to: OrbVisual; start: number }

/** The state machine, driven by an injected clock so the timing is testable
 *  without waiting. `reducedMotion` keeps the colour changes and drops the
 *  easing, so nothing moves on screen. */
export function createOrbStateMachine(
  initial: MiniVisualState = 'cold',
  options: { reducedMotion?: boolean } = {},
): OrbStateMachine {
  let current: MiniVisualState = initial;
  let pending: Pending | undefined;
  let running: Running | undefined;

  const commit = (at: number, state: MiniVisualState) => {
    const from = eased(at);
    current = state;
    pending = undefined;
    running = options.reducedMotion ? undefined : { from, to: ORB_VISUALS[state], start: at };
  };

  const eased = (at: number): OrbVisual => {
    if (options.reducedMotion || !running) return ORB_VISUALS[current];
    const t = (at - running.start) / TRANSITION_MS;
    if (t >= 1) return ORB_VISUALS[current];
    if (t <= 0) return running.from;
    return mixVisual(running.from, running.to, t);
  };

  return {
    state: () => current,
    request(state, at) {
      if (state === current) { pending = undefined; return; }
      if (pending?.state === state) return;
      pending = { state, since: at };
    },
    visual(at) {
      if (pending && at - pending.since >= DEBOUNCE_MS) commit(pending.since + DEBOUNCE_MS, pending.state);
      else if (running && at - running.start >= TRANSITION_MS) running = undefined;
      return eased(at);
    },
  };
}
