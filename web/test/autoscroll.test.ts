import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { PIN_SLACK_PX, distanceFromBottom, isPinned, jumpVisible, nextPinned } from '../src/autoscroll.ts';

const list = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight });

test('the pin rule follows the newest line only within the 48 px slack of the bottom', () => {
  assert.equal(PIN_SLACK_PX, 48);
  assert.equal(distanceFromBottom(list(600)), 0, 'at the bottom there is nothing below');
  assert.equal(isPinned(list(600)), true, 'exactly at the bottom is pinned');
  assert.equal(isPinned(list(552)), true, '48 px above the bottom is still pinned');
  assert.equal(isPinned(list(551)), false, 'past the slack the reader owns the view');
});

test('a pinned list keeps following new lines; a reader who scrolled up keeps their place', () => {
  assert.equal(nextPinned(true, list(200)), true, 'a pinned view follows the bottom even after growth');
  assert.equal(nextPinned(false, list(560)), true, 'scrolling back to the bottom re-pins the view');
  assert.equal(nextPinned(false, list(200)), false, 'an unpinned reader is never dragged');
});

test('the jump pill is offered exactly while the view is away from the bottom', () => {
  assert.equal(jumpVisible(true, list(600)), false);
  assert.equal(jumpVisible(false, list(600)), false, 'at the bottom there is nothing to jump to');
  assert.equal(jumpVisible(false, list(300)), true);
  assert.equal(jumpVisible(true, list(300)), false, 'a pinned view follows by itself, so no pill');
});

test('FE1 a poll that grows the feed never re-pins a reader who scrolled up; a new session does', () => {
  const grown = list(200, 1400, 400);
  assert.equal(nextPinned(false, grown), false, 'growth alone never drags a reader back to the bottom');
  // A new session starts pinned: the binder re-settles to the newest line until the reader takes over.
  assert.equal(nextPinned(true, grown), true);
  assert.equal(jumpVisible(false, grown), true, 'Jump to latest is offered while the reader is away from the bottom');
});

test('UI3b the voice transcript follows the newest line under one rule, the pin on #transcript alone', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/attachPin\(/g)?.length, 1, 'exactly one scroll mechanism is bound in the page');
  assert.doesNotMatch(source, /\.live-transcript/, 'the dead second anchor never returns');
  assert.match(source, /attachPin\(list, pill\)/, 'the pin owns the transcript container');
  assert.match(source, /id="transcript-jump"[^>]*hidden>Jump to latest</, 'the jump-to-latest pill starts hidden');
});

test('UI3b a reader who scrolled up sees the jump pill; a reader at the bottom does not', () => {
  const bottom = list(600);
  const scrolledUp = list(0);
  assert.equal(jumpVisible(true, bottom), false);
  assert.equal(jumpVisible(false, scrolledUp), true);
  // The pill is the reader's way back: the pin itself never drags them down while they are away.
  assert.equal(nextPinned(false, scrolledUp), false);
});
