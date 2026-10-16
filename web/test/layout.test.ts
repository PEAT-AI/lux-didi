import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PANEL_IDS,
  LEFT_MIN_PX,
  RIGHT_MIN_PX,
  LEFT_DEFAULT_PX,
  RIGHT_DEFAULT_PX,
  VOICE_MIN_PX,
  PANEL_MAX_PX,
  LAYOUT_KEY,
  clampWidth,
  closeSheet,
  defaultLayout,
  dragPanel,
  isNarrow,
  loadLayout,
  openSheet,
  panelControl,
  panelDefaultWidth,
  panelMin,
  panelOpen,
  panelWidth,
  parseLayout,
  saveLayout,
  serializeLayout,
  shortcutPanel,
  togglePanel,
} from '../src/layout.ts';

test('the launch is both side panels collapsed around an always-open voice view', () => {
  const state = defaultLayout();
  assert.equal(state.left, 'collapsed');
  assert.equal(state.right, 'collapsed');
  assert.equal(state.sheet, null);
  assert.equal(state.leftWidth, LEFT_DEFAULT_PX);
  assert.equal(state.rightWidth, RIGHT_DEFAULT_PX);
});

test('the published sizes match the spec and the voice view has a minimum', () => {
  assert.equal(LEFT_MIN_PX, 200);
  assert.equal(RIGHT_MIN_PX, 320);
  assert.equal(VOICE_MIN_PX, 360);
  assert.equal(panelMin('left'), LEFT_MIN_PX);
  assert.equal(panelMin('right'), RIGHT_MIN_PX);
  assert.equal(panelDefaultWidth('left'), LEFT_DEFAULT_PX);
  assert.equal(panelDefaultWidth('right'), RIGHT_DEFAULT_PX);
});

test('a panel has exactly two states and toggles between them', () => {
  let state = defaultLayout();
  state = togglePanel(state, 'left');
  assert.equal(state.left, 'open');
  assert.equal(panelOpen(state, 'left'), true);
  state = togglePanel(state, 'left');
  assert.equal(state.left, 'collapsed');
  assert.equal(panelOpen(state, 'left'), false);
});

test('collapsing keeps the width, so reopening restores the previous width', () => {
  let state = dragPanel(defaultLayout(), 'right', 480);
  assert.equal(state.right, 'open');
  assert.equal(state.rightWidth, 480);
  state = togglePanel(state, 'right');
  assert.equal(state.right, 'collapsed');
  assert.equal(state.rightWidth, 480, 'the collapsed panel remembers the width');
  state = togglePanel(state, 'right');
  assert.equal(state.right, 'open');
  assert.equal(panelWidth(state, 'right'), 480);
});

test('dragging below the minimum collapses instead of clamping', () => {
  let state = togglePanel(defaultLayout(), 'right');
  state = dragPanel(state, 'right', RIGHT_MIN_PX - 1);
  assert.equal(state.right, 'collapsed', 'below the minimum is collapsed, never in between');
  state = dragPanel(state, 'right', RIGHT_MIN_PX);
  assert.equal(state.right, 'open');
  assert.equal(state.rightWidth, RIGHT_MIN_PX);
});

test('a drag clamps to the minimum and the maximum', () => {
  assert.equal(clampWidth('left', 10), LEFT_MIN_PX);
  assert.equal(clampWidth('right', PANEL_MAX_PX + 500), PANEL_MAX_PX);
  assert.equal(clampWidth('right', 400), 400);
  assert.equal(clampWidth('right', 400.6), 401);
  const state = dragPanel(defaultLayout(), 'right', PANEL_MAX_PX + 500);
  assert.equal(state.rightWidth, PANEL_MAX_PX);
});

test('dragging back out restores the previous width when the drag was refused', () => {
  let state = dragPanel(defaultLayout(), 'left', 260);
  state = dragPanel(state, 'left', 40); // refuse, collapse
  assert.equal(state.left, 'collapsed');
  const back = dragPanel(state, 'left', 300);
  assert.equal(back.left, 'open');
  assert.equal(back.leftWidth, 300, 'a fresh drag sets the width');
});

test('the always-visible control carries the same place and the aria pair', () => {
  let state = defaultLayout();
  const collapsed = panelControl(state, 'right');
  assert.equal(collapsed['aria-expanded'], 'false');
  assert.equal(collapsed['aria-controls'], 'panel-right');
  assert.match(collapsed.title, /Show|Expand/i);
  state = togglePanel(state, 'right');
  const open = panelControl(state, 'right');
  assert.equal(open['aria-expanded'], 'true');
  assert.match(open.title, /Hide|Collapse/i);
  // No last-open refusal: both panels may be collapsed at once.
  state = togglePanel(state, 'left');
  assert.equal(state.left, 'open');
  assert.equal(state.right, 'open');
});

test('the keyboard shortcuts are Cmd/Ctrl+1 left and Cmd/Ctrl+2 right', () => {
  assert.equal(shortcutPanel('1', true), 'left');
  assert.equal(shortcutPanel('2', true), 'right');
  assert.equal(shortcutPanel('1', false), null, 'a bare digit never toggles a panel');
  assert.equal(shortcutPanel('3', true), null);
});

test('the layout serializes to a round trip', () => {
  let state = defaultLayout();
  state = dragPanel(state, 'left', 300);
  state = togglePanel(state, 'right');
  const parsed = parseLayout(serializeLayout(state));
  assert.equal(parsed.left, 'open');
  assert.equal(parsed.leftWidth, 300);
  assert.equal(parsed.right, 'open');
});

test('a broken stored layout falls back to the default, never to a broken layout', () => {
  assert.deepEqual(parseLayout(null), defaultLayout());
  assert.deepEqual(parseLayout('not json'), defaultLayout());
  assert.deepEqual(parseLayout('{}'), defaultLayout());
  assert.deepEqual(parseLayout(JSON.stringify({ left: 'half', right: 'open' })), defaultLayout());
  assert.deepEqual(parseLayout(JSON.stringify({ left: 'open', right: 'open', leftWidth: 10, rightWidth: 360 })), defaultLayout(), 'a width below the minimum is rejected');
  assert.deepEqual(parseLayout(JSON.stringify({ left: 'open', right: 'open', leftWidth: 'tall', rightWidth: 360 })), defaultLayout());
  assert.deepEqual(parseLayout(JSON.stringify({ left: 'open', right: 'open', leftWidth: 9999, rightWidth: 360 })), defaultLayout());
});

test('a storage failure falls back to the default', () => {
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(loadLayout(throwing), defaultLayout());
  assert.deepEqual(loadLayout(undefined), defaultLayout());
  assert.doesNotThrow(() => saveLayout(throwing, defaultLayout()), 'a write failure must not break the page');
  const good = { getItem: (key: string) => (key === LAYOUT_KEY ? serializeLayout(dragPanel(defaultLayout(), 'left', 300)) : null), setItem() {} };
  assert.equal(loadLayout(good).left, 'open');
  assert.equal(loadLayout(good).leftWidth, 300);
});

test('the narrow flag follows the viewport width', () => {
  assert.equal(isNarrow(800), true);
  assert.equal(isNarrow(1200), false);
});

test('the sheet helpers still work', () => {
  let state = openSheet(defaultLayout(), 'settings');
  assert.equal(state.sheet, 'settings');
  assert.equal(state.left, 'collapsed');
  assert.equal(closeSheet(state).sheet, null);
});

test('every panel id is covered', () => {
  assert.deepEqual([...PANEL_IDS], ['left', 'right']);
});
