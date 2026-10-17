import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  createOrbStateMachine, DEBOUNCE_MS, easeInOut, mixVisual, ORB_VISUALS, TRANSITION_MS,
  type MiniVisualState,
} from '../src/orb-states.ts';

const STATES: MiniVisualState[] = ['off', 'listening', 'thinking', 'tool', 'speaking', 'muted'];
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
  near('tool', 'mini-thinking-warm');      // the tool amber
  near('speaking', 'teal');
  near('off', 'mini-stage-1');
  // Thinking sits between the listening teal and the tool amber: a shift toward amber
  // before the amber itself, which is the owner's word.
  const [teal, amber, thinking] = [ORB_VISUALS.listening.hue, ORB_VISUALS.tool.hue, ORB_VISUALS.thinking.hue];
  assert.ok(thinking < teal && thinking > amber, `thinking (${thinking}) is between ${teal} and ${amber}`);
  // Off and muted share the quiet colour and differ by glow and amplitude, so muted
  // reads as the same orb with the life taken out of it.
  assert.equal(ORB_VISUALS.muted.hue, ORB_VISUALS.off.hue);
  assert.ok(ORB_VISUALS.muted.amplitude < ORB_VISUALS.off.amplitude);
  assert.deepEqual([ORB_VISUALS.off.posture, ORB_VISUALS.muted.posture], ['quiet', 'quiet'], 'a slow six second breathe');
  assert.equal(ORB_VISUALS.listening.followsMic, true, 'listening reacts to the owner');
  assert.equal(ORB_VISUALS.speaking.followsOutput, true, 'speaking reacts to Naya');
  for (const state of ['off', 'thinking', 'tool', 'muted'] as MiniVisualState[]) {
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
  assert.ok(Math.abs(half.hue - (ORB_VISUALS.listening.hue + ORB_VISUALS.tool.hue) / 2) < 1e-9);
  assert.equal(half.posture, ORB_VISUALS.tool.posture, 'the motion character switches at the commit');
});

test('a committed change eases colour, glow and amplitude, never jumps', () => {
  const machine = createOrbStateMachine('off');
  assert.equal(machine.visual(0).hue, ORB_VISUALS.off.hue);
  machine.request('listening', 0);
  assert.equal(machine.visual(DEBOUNCE_MS - 1).hue, ORB_VISUALS.off.hue, 'nothing moves before the debounce');
  assert.equal(machine.state(DEBOUNCE_MS), 'off');
  // The debounce ends at 250 and the 500 ms ease starts there.
  const start = DEBOUNCE_MS;
  const at = (offset: number) => machine.visual(start + offset).hue;
  assert.equal(at(0), ORB_VISUALS.off.hue, 'the ease starts where the old state was');
  assert.equal(at(TRANSITION_MS / 2), (ORB_VISUALS.off.hue + ORB_VISUALS.listening.hue) / 2, 'half way at half time');
  assert.equal(at(TRANSITION_MS), ORB_VISUALS.listening.hue, 'the ease lands exactly on the new state');
  const trail = [0, 60, 120, 180, 240, 300, 360, 420, 480, 540].map(at);
  // The hue travels from the off blue down to the listening teal, one way, no overshoot.
  for (let i = 1; i < trail.length; i += 1) assert.ok(trail[i]! <= trail[i - 1]!, 'one way, no overshoot');
  assert.equal(machine.state(start + TRANSITION_MS), 'listening');
  const glow = machine.visual(start + TRANSITION_MS / 2).glow;
  assert.ok(glow > ORB_VISUALS.off.glow && glow < ORB_VISUALS.listening.glow, 'glow eases too');
  const amplitude = machine.visual(start + TRANSITION_MS / 2).amplitude;
  assert.ok(amplitude > ORB_VISUALS.off.amplitude && amplitude < ORB_VISUALS.listening.amplitude, 'amplitude eases too');
});

test('a state that lasts under 250 ms is a flicker and never shows', () => {
  const machine = createOrbStateMachine('off');
  machine.request('thinking', 1000);
  machine.request('off', 1100);                       // back again inside the window
  assert.equal(machine.visual(5000).state, 'off', 'a flicker leaves the state alone');
  machine.request('thinking', 6000);
  machine.request('tool', 6100);                      // replaced before it ever lasted
  assert.equal(machine.visual(6100 + DEBOUNCE_MS - 1).state, 'off', 'the first candidate never commits');
  assert.equal(machine.visual(6100 + DEBOUNCE_MS).state, 'tool', 'the state that lasts commits');
});

test('a new request mid-transition starts from the colour on screen', () => {
  const machine = createOrbStateMachine('off');
  machine.request('listening', 0);
  const mid = DEBOUNCE_MS + TRANSITION_MS / 2;
  machine.visual(mid);
  machine.request('tool', mid);
  const commit = mid + DEBOUNCE_MS;
  const before = machine.visual(commit - 1).hue;
  const after = machine.visual(commit + 1).hue;
  assert.ok(Math.abs(after - before) < 1, `no jump at the commit: ${before} then ${after}`);
});

test('reduced motion keeps the colour change and drops the motion', () => {
  const machine = createOrbStateMachine('off', { reducedMotion: true });
  machine.request('listening', 0);
  assert.equal(machine.visual(DEBOUNCE_MS).hue, ORB_VISUALS.listening.hue, 'the colour still changes');
  assert.equal(machine.visual(DEBOUNCE_MS).state, 'listening');
  assert.equal(machine.visual(DEBOUNCE_MS + TRANSITION_MS / 2).hue, ORB_VISUALS.listening.hue, 'and does not animate');
});
