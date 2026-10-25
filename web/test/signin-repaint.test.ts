import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { bindSignInButtons, settingsMarkup } from '../src/settings-view.ts';

// #659: the owner clicked "Sign in to Mongoose ..." and nothing happened. Settings repaints itself on
// every connection poll, and the repaint replaces the whole #settings-summary panel, so the button the
// owner then clicked was a node the one-time bind never touched. A click must survive the repaint.

const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};
const catalogue = (JSON.parse(readFileSync(new URL('../../server/test/fixtures/installed-mcp-config.json', import.meta.url), 'utf8')) as {
  endpoints: { id: string }[];
}).endpoints;
const mongooseIDs = ['mongoose-knowledge', 'mongoose-data', 'mongoose-crm'];
const rows = catalogue.map(({ id }) => (mongooseIDs.includes(id)
  ? { id, state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }
  : { id, state: 'connected', tools: 1, lastHandshakeAt: null, reasonCode: null }));

interface Element { getAttribute(name: string): string | null; closest(selector: string): Element | null }
interface ClickEvent { target: Element }

/** The panel as the browser holds it: one node per sign-in button, and a click bubbles to the panel root. */
class SettingsPanel {
  private readonly rootListeners: ((event: ClickEvent) => void)[] = [];
  private nodes: { node: Element; own: ((event: ClickEvent) => void)[]; endpoint: string }[] = [];
  constructor(markup: string) { this.repaint(markup); }
  /** `panel.outerHTML = settingsMarkup(...)`: brand new nodes, and the old ones are gone with their listeners. */
  repaint(markup: string) {
    this.nodes = [...markup.matchAll(/<button[^>]*data-signin[^>]*data-endpoint="([^"]*)"[^>]*>/g)].map(match => {
      const attributes: Record<string, string> = { 'data-signin': '', 'data-endpoint': match[1]! };
      const own: ((event: ClickEvent) => void)[] = [];
      const node: Element & { addEventListener(type: 'click', listener: (event: ClickEvent) => void): void } = {
        getAttribute: (name: string) => attributes[name] ?? null,
        closest: (selector: string) => (selector === '[data-signin]' ? node : null),
        addEventListener: (_type, listener) => { own.push(listener); },
      };
      return { node, own, endpoint: match[1]! };
    });
  }
  /** What a per-node binder reaches for; a binder on the stable root never looks. */
  querySelectorAll(_selector: string): Element[] { return this.nodes.map(entry => entry.node); }
  addEventListener(_type: 'click', listener: (event: ClickEvent) => void): void { this.rootListeners.push(listener); }
  /** A real click: the button's own listeners first, then the same event bubbling up to the panel root. */
  click(row: string) {
    const entry = this.nodes.find(candidate => candidate.endpoint === row);
    assert.ok(entry, `the ${row} row renders a Sign in button`);
    for (const listener of entry.own) listener({ target: entry.node });
    for (const listener of this.rootListeners) listener({ target: entry.node });
  }
  /** A click on the panel itself, landing on no sign-in button at all. */
  clickPanel() {
    const outside: Element = { getAttribute: () => null, closest: () => null };
    for (const listener of this.rootListeners) listener({ target: outside });
  }
}

test('a Sign in click still reaches the host after the Settings repaint', () => {
  const panel = new SettingsPanel(settingsMarkup({ status, connections: rows }));
  const sent: string[] = [];
  // Exactly what main.ts bind() does once, on the stable root, before any poll tick.
  bindSignInButtons(panel, endpoint => sent.push(endpoint));
  panel.repaint(settingsMarkup({ status, connections: rows }));
  panel.click('mongoose-knowledge');
  assert.deepEqual(sent, ['knowledge'], 'the click on the repainted button names its own endpoint, once');
});

test('a click on the panel that lands on no Sign in button sends nothing', () => {
  const panel = new SettingsPanel(settingsMarkup({ status, connections: rows }));
  const sent: string[] = [];
  bindSignInButtons(panel, endpoint => sent.push(endpoint));
  panel.clickPanel();
  assert.deepEqual(sent, [], 'only a sign-in button starts a sign-in');
});

test('a sign-in that does not start says why in plain words', async () => {
  const { signInFailureNotice } = await import('../src/settings-view.ts') as typeof import('../src/settings-view.ts') & {
    signInFailureNotice?: (reason: string) => string;
  };
  assert.equal(typeof signInFailureNotice, 'function', 'the Settings notice reads a closed reason');
  assert.match(signInFailureNotice!('sign-in-in-progress'), /^Finish the sign-in already open in the browser first/);
  assert.match(signInFailureNotice!('browser-unavailable'), /^Your browser could not be opened/);
  assert.match(signInFailureNotice!('port-in-use'), /^Sign-in did not finish/);
});
