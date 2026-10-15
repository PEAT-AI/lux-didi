import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NARROW_BREAKPOINT,
  RAIL_COLLAPSED_PX,
  RAIL_EXPANDED_PX,
  LANE_STRIP_PX,
  VOICE_HEADER_PX,
  ORB_PX,
  canCollapseLane,
  closeSheet,
  collapseControl,
  defaultLayout,
  focusTargetAfterCollapse,
  isNarrow,
  openSheet,
  selectSegment,
  toggleLane,
  toggleRail,
  visibleLanes,
  withViewport,
} from '../src/layout.ts';

test('launch is rail collapsed, Voice and Chat open, no sheet', () => {
  const state = defaultLayout();
  assert.equal(state.rail, 'collapsed');
  assert.equal(state.voice, 'open');
  assert.equal(state.chat, 'open');
  assert.equal(state.sheet, null);
});

test('the published sizes match the spec', () => {
  assert.equal(NARROW_BREAKPOINT, 880);
  assert.equal(RAIL_COLLAPSED_PX, 80);
  assert.equal(RAIL_EXPANDED_PX, 220);
  assert.equal(LANE_STRIP_PX, 56);
  assert.equal(VOICE_HEADER_PX, 96);
  assert.equal(ORB_PX, 56);
});

test('both lanes are visible at 1440 and one at 800', () => {
  const wide = withViewport(defaultLayout(), 1440);
  assert.deepEqual(visibleLanes(wide), ['voice', 'chat']);
  const narrow = withViewport(defaultLayout(), 800);
  assert.equal(narrow.narrow, true);
  assert.deepEqual(visibleLanes(narrow), ['voice']);
  assert.equal(isNarrow(879), true);
  assert.equal(isNarrow(880), false);
});

test('collapsing Voice then trying to collapse Chat is refused and focus moves to the other lane', () => {
  let state = defaultLayout();
  state = toggleLane(state, 'voice');
  assert.equal(state.voice, 'collapsed');
  assert.equal(canCollapseLane(state, 'chat'), false);
  const next = toggleLane(state, 'chat');
  assert.equal(next, state, 'a refused collapse returns the same state');
  assert.equal(next.chat, 'open');
  assert.equal(focusTargetAfterCollapse('voice'), 'lane-chat-primary');
  assert.equal(focusTargetAfterCollapse('chat'), 'lane-voice-primary');
});

test('the last open lane control is aria-disabled, the collapsed lane is aria-expanded false', () => {
  let state = defaultLayout();
  const voiceOpen = collapseControl(state, 'voice');
  assert.equal(voiceOpen['aria-expanded'], 'true');
  assert.equal(voiceOpen['aria-controls'], 'lane-voice');
  assert.equal(voiceOpen['aria-disabled'], undefined, 'with two lanes open nothing is a last-lane refusal');

  state = toggleLane(state, 'voice');
  const chatLast = collapseControl(state, 'chat');
  assert.equal(chatLast['aria-expanded'], 'true');
  assert.equal(chatLast['aria-disabled'], 'true');
  assert.match(chatLast.title, /one conversation stays open/);
  const voiceCollapsed = collapseControl(state, 'voice');
  assert.equal(voiceCollapsed['aria-expanded'], 'false');
  assert.equal(voiceCollapsed['aria-disabled'], undefined, 'collapsed lanes can always reopen');
});

test('a collapsed lane reopens', () => {
  let state = toggleLane(defaultLayout(), 'chat');
  assert.equal(state.chat, 'collapsed');
  state = toggleLane(state, 'chat');
  assert.equal(state.chat, 'open');
});

test('the rail toggles between collapsed and expanded', () => {
  const expanded = toggleRail(defaultLayout());
  assert.equal(expanded.rail, 'expanded');
  assert.equal(toggleRail(expanded).rail, 'collapsed');
});

test('the narrow segment can switch lanes and widths fold in', () => {
  let state = selectSegment(withViewport(defaultLayout(), 800), 'chat');
  assert.deepEqual(visibleLanes(state), ['chat']);
  state = withViewport(state, 1200);
  assert.equal(state.narrow, false);
  assert.deepEqual(visibleLanes(state), ['voice', 'chat']);
});

test('sheets open one at a time and close, and never move a lane', () => {
  let state = openSheet(defaultLayout(), 'settings');
  assert.equal(state.sheet, 'settings');
  assert.equal(state.voice, 'open');
  state = openSheet(state, 'today');
  assert.equal(state.sheet, 'today');
  assert.equal(closeSheet(state).sheet, null);
  assert.equal(closeSheet(closeSheet(state)), closeSheet(state), 'closing twice is stable');
});
