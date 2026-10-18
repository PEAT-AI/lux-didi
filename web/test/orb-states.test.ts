import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  breathe, createOrbStateMachine, createStateDebounce, DEBOUNCE_MS, easeInOut, mixVisual, ORB_VISUALS, TRANSITION_MS,
  type MiniVisualState,
} from '../src/orb-states.ts';

const STATES: MiniVisualState[] = ['cold', 'connecting', 'listening', 'thinking', 'tool', 'speaking', 'hot-muted'];
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

/** One palette token's value, so the visuals are checked against the stylesheet itself. */
function token(name: string): string {
  const found = new RegExp(`--${name}:#([0-9a-f]{6})`, 'i').exec(css);
  assert.ok(found, `style.css defines --${name}`);
  return `#${found[1]!}`;
}

/** A colour's HSL hue in degrees, the unit the renderer takes. */
function hueOf(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

test('every state has one visual, and the colours are the mini palette tokens', () => {
  assert.deepEqual(Object.keys(ORB_VISUALS).sort(), [...STATES].sort(), 'one visual per state');
  const near = (state: MiniVisualState, name: string) => assert.ok(
    Math.abs(ORB_VISUALS[state].hue - hueOf(token(name))) <= 1,
    `${state} uses --${name} (${token(name)}): ${ORB_VISUALS[state].hue} vs ${hueOf(token(name)).toFixed(1)}`);
  near('listening', 'mini-mark');          // the listening teal
  near('thinking', 'accent-warm');         // M3-R4: the amber at full strength, not a blend
  near('tool', 'accent-warm');
  near('speaking', 'teal');
  near('cold', 'mini-stage-1');
  // Thinking and tool are the same amber hue, so no screen can read either as the
  // listening teal; motion is what separates them.
  assert.equal(ORB_VISUALS.thinking.hue, ORB_VISUALS.tool.hue);
  assert.ok(Math.abs(ORB_VISUALS.thinking.hue - ORB_VISUALS.listening.hue) > 60,
    'the amber is far from the listening teal');
  // Cold and hot-muted share the quiet colour; hot-muted is the slightly more opaque
  // grey, and cold breathes the slowest of every state.
  assert.equal(ORB_VISUALS['hot-muted'].hue, ORB_VISUALS.cold.hue);
  assert.ok(Math.abs(ORB_VISUALS.cold.opacity - 0.35) <= 0.02, `cold is about 35 percent, got ${ORB_VISUALS.cold.opacity}`);
  assert.ok(ORB_VISUALS['hot-muted'].opacity > ORB_VISUALS.cold.opacity, 'hot-muted is slightly more opaque');
  assert.ok(ORB_VISUALS.cold.breatheMs >= 9000, 'cold breathes very slowly');
  assert.ok(ORB_VISUALS['hot-muted'].breatheMs < ORB_VISUALS.cold.breatheMs, 'hot-muted breathes faster than cold');
  assert.deepEqual([ORB_VISUALS.cold.posture, ORB_VISUALS['hot-muted'].posture], ['quiet', 'quiet'], 'a slow breathe, not a swirl');
  assert.ok(ORB_VISUALS.cold.grey > 0.9 && ORB_VISUALS['hot-muted'].grey === 1, 'both are grey');
  assert.equal(ORB_VISUALS.listening.followsMic, true, 'listening reacts to the owner');
  assert.equal(ORB_VISUALS.speaking.followsOutput, true, 'speaking reacts to Naya');
  for (const state of ['cold', 'connecting', 'thinking', 'tool', 'hot-muted'] as MiniVisualState[]) {
    assert.deepEqual([ORB_VISUALS[state].followsMic, ORB_VISUALS[state].followsOutput], [false, false],
      `${state} never reacts to a level`);
  }
});

test('the transition is 450 to 600 ms on an ease-in-out curve', () => {
  assert.ok(TRANSITION_MS >= 450 && TRANSITION_MS <= 600, `the transition is ${TRANSITION_MS} ms`);
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.ok(Math.abs(easeInOut(0.5) - 0.5) < 1e-9, 'the midpoint is the halfway colour');
  assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9, 'eased at both ends');
  const half = mixVisual(ORB_VISUALS.listening, ORB_VISUALS.tool, 0.5);
  // M3-R6: no halfway hue exists, because a walked hue between teal and amber is lime.
  assert.equal(half.hue, ORB_VISUALS.tool.hue);
  // easeInOut(0.5) is exactly 0.5, so the crossfade is half way.
  assert.equal(half.mixing?.from, ORB_VISUALS.listening.hue);
  assert.equal(half.mixing?.to, ORB_VISUALS.tool.hue);
  assert.ok(Math.abs((half.mixing?.t ?? 0) - 0.5) < 1e-9);
  assert.equal(half.posture, ORB_VISUALS.tool.posture, 'the motion character switches at the commit');
});

test('a committed change eases colour, glow and amplitude, never jumps', () => {
  const machine = createOrbStateMachine('cold');
  assert.equal(machine.visual(0).hue, ORB_VISUALS.cold.hue);
  machine.request('listening', 0);
  assert.equal(machine.visual(DEBOUNCE_MS - 1).hue, ORB_VISUALS.cold.hue, 'nothing moves before the debounce');
  assert.equal(machine.state(DEBOUNCE_MS), 'cold');
  // The debounce ends at 250 and the 500 ms ease starts there.
  const start = DEBOUNCE_MS;
  const at = (offset: number) => machine.visual(start + offset).hue;
  const mid = machine.visual(start + TRANSITION_MS / 2);
  assert.equal(at(0), ORB_VISUALS.cold.hue, 'the ease starts where the old state was');
  // M3-R6: the colour is a crossfade of two layers, never one hue walked through the wheel.
  assert.equal(mid.hue, ORB_VISUALS.listening.hue, 'the incoming layer is the target');
  assert.deepEqual({ from: mid.mixing?.from, to: mid.mixing?.to }, { from: ORB_VISUALS.cold.hue, to: ORB_VISUALS.listening.hue });
  assert.ok(Math.abs((mid.mixing?.t ?? 0) - 0.5) < 1e-9, 'half way at half time');
  const glow = mid.glow;
  assert.ok(glow > ORB_VISUALS.cold.glow && glow < ORB_VISUALS.listening.glow, 'glow eases too');
  const amplitude = mid.amplitude;
  assert.ok(amplitude > ORB_VISUALS.cold.amplitude && amplitude < ORB_VISUALS.listening.amplitude, 'amplitude eases too');
  // The crossfade only grows, never overshoots, and finishes exactly at the bound.
  // From the first frame inside the fade (the commit frame is still the old layer) to just
  // under the bound.
  const trail = [1, 60, 120, 180, 240, 300, 360, 420, 480].map(offset => machine.visual(start + offset).mixing?.t ?? 1);
  for (let i = 1; i < trail.length; i += 1) assert.ok(trail[i]! >= trail[i - 1]!, 'the fade only grows');
  assert.ok(trail.at(-1)! < 1 && trail.at(-1)! > 0.9, 'almost there just under the bound');
  assert.equal(at(TRANSITION_MS), ORB_VISUALS.listening.hue, 'the ease lands exactly on the new state');
  assert.equal(machine.state(start + TRANSITION_MS), 'listening');
});

test('a state that lasts under 250 ms is a flicker and never shows', () => {
  const machine = createOrbStateMachine('cold');
  machine.request('thinking', 1000);
  machine.request('cold', 1100);                       // back again inside the window
  assert.equal(machine.state(5000), 'cold', 'a flicker leaves the state alone');
  machine.request('thinking', 6000);
  machine.request('tool', 6100);                      // replaced before it ever lasted
  machine.visual(6100 + DEBOUNCE_MS - 1);
  assert.equal(machine.state(6100 + DEBOUNCE_MS - 1), 'cold', 'the first candidate never commits');
  machine.visual(6100 + DEBOUNCE_MS);
  assert.equal(machine.state(6100 + DEBOUNCE_MS), 'tool', 'the state that lasts commits');
});

test('a new request mid-transition crossfades in from the layer on screen', () => {
  const machine = createOrbStateMachine('cold');
  machine.request('listening', 0);
  const changedAt = DEBOUNCE_MS + TRANSITION_MS * 0.3;
  const running = machine.visual(changedAt);
  assert.ok(running.mixing && running.mixing.t > 0 && running.mixing.t < 1, 'the first crossfade was in flight');
  machine.request('tool', changedAt);
  const commit = changedAt + DEBOUNCE_MS;
  const before = machine.visual(commit - 1);
  const after = machine.visual(commit + 1);
  // No jump: the new crossfade fades in the layer the old one was arriving at.
  assert.ok(after.mixing && after.mixing.t < 0.05, 'the new crossfade starts from nothing');
  assert.equal(after.mixing?.to, ORB_VISUALS.tool.hue);
  assert.equal(after.mixing?.from, before.mixing?.to, 'it fades in from the layer that was arriving');
  assert.equal(after.mixing?.from, ORB_VISUALS.listening.hue);
});

test('reduced motion keeps the colour change and drops the motion', () => {
  const machine = createOrbStateMachine('cold', { reducedMotion: true });
  machine.request('listening', 0);
  assert.equal(machine.visual(DEBOUNCE_MS).hue, ORB_VISUALS.listening.hue, 'the colour still changes');
  assert.equal(machine.state(DEBOUNCE_MS), 'listening');
  assert.equal(machine.visual(DEBOUNCE_MS + TRANSITION_MS / 2).hue, ORB_VISUALS.listening.hue, 'and does not animate');
});

test('the opacity breathe is a slow sine on the clock', () => {
  assert.equal(breathe(0.35, 9000, 0), 0.35, 'no breathe at zero');
  assert.ok(breathe(0.35, 9000, 9000 / 4) > 0.35, 'a quarter period later it is fuller');
  assert.ok(breathe(0.35, 9000, (9000 * 3) / 4) < 0.35, 'and then quieter');
  assert.equal(breathe(1, 0, 1234), 1, 'a state without a breathe period holds its opacity');
});

test('D6: the full-window orb debounces a between-sentence blip, with explicit transition timestamps', () => {
  const orb = createStateDebounce<string>('CONNECTED');
  orb.request('SPEAKING', 1_000);
  assert.equal(orb.dueAt(), 1_000 + DEBOUNCE_MS, 'a request carries its own commit time');
  assert.equal(orb.settled(1_249), 'CONNECTED', 'nothing paints before the debounce');
  assert.equal(orb.settled(1_250), 'SPEAKING', 'speaking commits after it');
  // Speaking, listening, speaking inside 600 ms: one flicker, so the orb stays on speaking.
  orb.request('LISTENING', 1_300);
  orb.request('SPEAKING', 1_600);
  assert.equal(orb.settled(1_800), 'SPEAKING', 'the blip never paints');
  assert.equal(orb.dueAt(), undefined, 'a reverted blip leaves nothing pending');
  // A blip that outlasts the debounce is a real state.
  orb.request('LISTENING', 2_000);
  assert.equal(orb.settled(2_250), 'LISTENING', 'a held listening state commits');
});
