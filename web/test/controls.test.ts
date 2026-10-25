import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { LiveMachine } from '../src/live-view.ts';

// The controls that must do what they say (#650): each assertion names one owner-visible promise the
// markup alone cannot keep, so a markup edit that drops the guard is a red test, not a green walk.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../src/native-bridge.ts', import.meta.url), 'utf8');
const swift = readFileSync(new URL('../../Sources/LuxDidi/NativeBridge.swift', import.meta.url), 'utf8');
const lane = readFileSync(new URL('../src/connected.ts', import.meta.url), 'utf8');

const section = (from: string, to: string): string => source.slice(source.indexOf(from), source.indexOf(to));

test('a Start press without availability sends nothing to native', () => {
  // The rendered Start control carries a real disabled attribute, not only aria-disabled.
  const control = section('id="voice-start"', 'voice-stop');
  assert.match(control, /disabled/, 'the Start control is disabled for real, not only aria-disabled');
  for (const state of ['live', 'muted', 'starting', 'stopping'] as const) {
    const posted: string[] = [];
    const machine = new LiveMachine(message => posted.push(message.type), { state, consent: true });
    machine.requestStart();
    assert.deepEqual(posted, [], `a press while ${state} never posts start`);
  }
});

test('each reconnect control has its own id and its own binding', () => {
  const ids = [...source.matchAll(/id="reconnect(?:-[a-z]+)?"/g)].map(match => match[0]);
  assert.equal(new Set(ids).size, ids.length, `the reconnect ids are distinct: ${ids.join(', ')}`);
  assert.match(source, /<button id="reconnect-pairing"[^>]*>Check connection again</, 'the pairing page keeps its own control');
  assert.match(source, /button\('reconnect-pairing',\(\) ?=> ?void connect\(\)\)/, 'the pairing control is bound too');
});

test('memory search says why it cannot search while the connection is not connected', () => {
  const recall = section('function memory()', 'function settings()');
  assert.match(recall, /connection==='Connected'\?'':`<[^`]*id="recall-reason"[^`]*Search needs the connection/, 'the reason shows exactly when the connection is not Connected');
});

test('the dependency notices never replace the app inside the native shell', () => {
  const link = section('id="open-notices"', 'Orb dependency notices');
  assert.match(link, /target="_blank" rel="noopener noreferrer"/, 'a browser opens the notices in a new tab');
  assert.match(source, /type:'openExternal',url:new URL\('\/third-party-notices\.txt',location\.href\)\.href/, 'the native shell is asked to open the notices outside');
});

test('every web to native message is one the native side decodes', () => {
  const union = bridge.slice(bridge.indexOf('export type WebToNative ='), bridge.indexOf('const INBOUND_TYPES'));
  const web = [...union.matchAll(/type: '(\w+)'/g)].map(match => match[1]).sort();
  const switchBlock = swift.slice(swift.indexOf('switch type {'), swift.indexOf('default: return .unknown(type)'));
  const native = [...switchBlock.matchAll(/case "(\w+)": return/g)].map(match => match[1]).sort();
  assert.deepEqual(web, native, 'the web emits exactly the types BridgeInbound.decode handles');
});

test('the chat lane offers Allow only when a text model is configured', () => {
  const flat = lane.replace(/\s+/g, ' ');
  const block = flat.slice(flat.indexOf('const blocked ='), flat.indexOf('panel.innerHTML ='));
  assert.match(block, /Text chat is not configured\. Set the text chat model in Settings\./, 'with no model the lane says so and where to set it');
  assert.doesNotMatch(block.slice(block.indexOf('chat-unavailable')), /connected-consent/, 'the line that names the problem offers no Allow');
  assert.match(block, /grant \|\| this\.#consent \? '' : `<p class="connected-disclosure"> Chat messages go to <strong>\$\{escape\(chatModelLabel\(provider, model\)\)\}<\/strong> when you send them\. <button type="button" id="connected-consent"/, 'with a model the lane names it the way Settings does');
  assert.match(flat, /\$\{disclosure\}/, 'the lane renders exactly the line it computed');
});
