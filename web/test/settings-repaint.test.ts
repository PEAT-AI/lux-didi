import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { bindSettingsPanel, bindSignInButtons, laneNoticesMarkup, settingsMarkup, sheetBodyMarkup, type PanelControl, type SettingsPanelHandlers } from '../src/settings-view.ts';

// #673: the owner pressed Save provider after Settings had been open ten seconds. The page reloaded to
// /?provider=...&voice=...&accent=..., the sheet closed and nothing was saved: the 10 s repaint replaces
// every node inside #settings-summary, and a submit bound once in bind() went with the old form, so the
// browser did its own native GET submit. One delegated owner on the stable root must reach every control,
// however many repaints happened before the press, and no submit may ever navigate.

const status = {
  ownerProfile: { status: 'default', displayName: 'Naya' },
  model: { configured: true, provider: 'gemini', model: 'gemini-2.5' },
  capabilities: { memory: true, commitments: true, notifications: false, model: true },
  serviceMode: 'loopback',
};
/** What GET /api/v1/live/summary answers for a running OpenAI Live session. */
const openaiSummary = {
  provider: 'openai', modelId: 'gpt-live-1', voice: 'marin', delegationModel: 'gpt-6-luna',
  personaName: 'Naya', limits: { sessionMs: 900000, idleMs: 60000 }, profileEnabled: true,
};
const catalogue = (JSON.parse(readFileSync(new URL('../../server/test/fixtures/installed-mcp-config.json', import.meta.url), 'utf8')) as {
  endpoints: { id: string }[];
}).endpoints;
const mongooseIDs = ['mongoose-knowledge', 'mongoose-data', 'mongoose-crm'];
const rows = catalogue.map(({ id }) => (mongooseIDs.includes(id)
  ? { id, state: 'error', tools: 0, lastHandshakeAt: null, reasonCode: 'needs_sign_in' }
  : { id, state: 'connected', tools: 2, lastHandshakeAt: null }));
const input = {
  status, connections: rows, summary: openaiSummary,
  micMode: { preferred: 'voice-isolation', active: 'voice-isolation' },
  theme: 'dark' as const,
  connected: {
    conversations: [{ title: 'Today chat', sessionId: 'session-1', active: true }, { title: 'Planning notes', sessionId: 'session-2' }],
    remember: false, standingRevoke: true, conversationState: 'asked',
  },
};

type FakeEvent = { target: Control; preventDefault(): void };
type Control = PanelControl & { id: string; tag: string; type: string; attributes: Record<string, string>; getAttribute(name: string): string | null };

function attributesOf(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [, name, value] of source.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attributes[name!] = value!;
  for (const [, , boolean] of source.matchAll(/(^|\s)(selected|checked|disabled)(?=\s|$)/g)) attributes[boolean!] = '';
  return attributes;
}
function matches(control: Control, selector: string): boolean {
  return selector.split(',').some(part => {
    const one = part.trim();
    if (one.startsWith('#')) return control.id === one.slice(1);
    if (one.startsWith('[')) return one.slice(1, -1) in control.attributes;
    return control.tag === one;
  });
}
/** Every control one render of the panel carries, held the way the browser holds them. */
function controlsOf(markup: string): Control[] {
  const controls: Control[] = [];
  for (const match of markup.matchAll(/<(button|select|input|form)\b([^>]*)>/g)) {
    const tag = match[1]!.toLowerCase();
    const attributes = attributesOf(match[2]!);
    let value = attributes.value ?? '';
    if (tag === 'select') {
      const block = markup.slice(match.index! + match[0].length, markup.indexOf('</select>', match.index!));
      const options = [...block.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
      value = (options.find(option => /selected/.test(option[2]!)) ?? options[0])?.[1] ?? '';
    }
    const control: Control = {
      id: attributes.id ?? '',
      tag,
      type: attributes.type ?? (tag === 'button' ? 'submit' : 'text'),
      attributes,
      value,
      checked: 'checked' in attributes,
      getAttribute: (name: string) => attributes[name] ?? null,
      closest(selector: string) { return matches(control, selector) ? control : null; },
    };
    controls.push(control);
  }
  return controls;
}

/** The page's stable root: #app survives every render, so a listener installed once keeps working. */
class StableRoot {
  controls = new Map<string, Control>();
  all: Control[] = [];
  renders = 0;
  navigations = 0;
  private listeners: Record<'submit' | 'change' | 'click', ((event: FakeEvent) => void)[]> = { submit: [], change: [], click: [] };
  constructor(markup: string) { this.repaint(markup); }
  /** `panel.outerHTML = settingsMarkup(...)`: every node inside the panel is new, the old ones are gone. */
  repaint(markup: string) {
    this.renders += 1;
    this.all = controlsOf(markup);
    this.controls = new Map(this.all.filter(control => control.id).map(control => [control.id, control]));
  }
  querySelector(selector: string): Control | null { return this.controls.get(selector.replace(/^#/, '')) ?? null; }
  get(selector: string): Control { const control = this.querySelector(selector); assert.ok(control, `${selector} is in the rendered panel`); return control; }
  addEventListener(type: 'submit' | 'change' | 'click', listener: (event: FakeEvent) => void): void { this.listeners[type].push(listener); }
  /** What the browser does with an event on a node inside the panel: every listener runs, and a submit
   *  that nothing prevented is a navigation, which is the reload that lost the save. */
  fire(type: 'submit' | 'change' | 'click', target: Control): boolean {
    let prevented = false;
    const event: FakeEvent = { target, preventDefault: () => { prevented = true; } };
    for (const listener of this.listeners[type]) listener(event);
    if (type === 'submit' && !prevented) this.navigations += 1;
    return prevented;
  }
}

function recorder() {
  const calls: string[] = [];
  const handlers: SettingsPanelHandlers = {
    saveSettings: ({ provider, voice, accent }) => calls.push(`save ${provider}/${voice}/${accent}`),
    providerChanged: provider => calls.push(`provider ${provider}`),
    historyChanged: history => calls.push(`history ${history}`),
    rememberChanged: remember => calls.push(`remember ${remember}`),
    appearanceChanged: value => calls.push(`appearance ${value}`),
    openMicModePicker: () => calls.push('mic picker'),
    dismissMicModePrompt: () => calls.push('mic dismiss'),
    revokeStanding: () => calls.push('revoke standing'),
    revokeConversation: () => calls.push('revoke conversation'),
    recoverHistory: () => calls.push('recover history'),
  };
  return { calls, handlers };
}

/** Every control the panel renders, and the one action each must still reach after a repaint. A control
 *  added to settingsMarkup() without an entry here fails the enumeration test below. */
const actions = [
  { id: 'connected-remember', event: 'change' as const, set: 'checked', effect: 'remember true' },
  { id: 'connected-history', event: 'change' as const, set: 'value', to: 'session-2', effect: 'history session-2' },
  { id: 'connected-recover', event: 'click' as const, effect: 'recover history' },
  { id: 'connected-standing-revoke', event: 'click' as const, effect: 'revoke standing' },
  { id: 'connected-revoke', event: 'click' as const, effect: 'revoke conversation' },
  { id: 'appearance-theme', event: 'change' as const, set: 'value', to: 'light', effect: 'appearance light' },
  { id: 'mic-mode-open', event: 'click' as const, effect: 'mic picker' },
  { id: 'live-provider', event: 'change' as const, set: 'value', to: 'gemini', effect: 'provider gemini' },
  { id: 'live-settings-form', event: 'submit' as const, effect: 'save' },
];
/** The controls with no action of their own: the save form reads both at submit. */
const passive = ['live-voice', 'live-accent'];

test('the panel renders exactly the controls this test drives, so a new control cannot slip through', () => {
  const controls = controlsOf(settingsMarkup(input));
  const named = controls.filter(control => control.id).map(control => control.id);
  const declared = new Set([...actions.map(action => action.id), ...passive]);
  assert.deepEqual(named.filter(id => !declared.has(id)), [], 'a control inside #settings-summary has no declared effect in this test');
  assert.deepEqual(passive.filter(id => !named.includes(id)), [], 'a passive control the test still expects');
  assert.deepEqual(named.filter(id => ['settings-summary', 'live-voices'].includes(id)), [], 'the panel section and the voice datalist are containers, not controls');
  const unlabelled = controls.filter(control => !control.id).map(control => `${control.tag}:${control.type}`).sort();
  assert.deepEqual(unlabelled, ['button:submit', ...mongooseIDs.map(() => 'button:button')].sort(),
    'the only unnamed controls are the Save provider button and one Sign in button per Mongoose connector');
  assert.equal(controls.filter(control => 'data-signin' in control.attributes).length, mongooseIDs.length);
});

test('every Settings control still acts after three repaints, and no submit ever navigates', () => {
  const root = new StableRoot(settingsMarkup(input));
  const { calls, handlers } = recorder();
  const signedIn: string[] = [];
  // Exactly what main.ts bind() does once, on the stable root, before any poll tick.
  bindSettingsPanel(root, handlers);
  bindSignInButtons(root, endpoint => signedIn.push(endpoint));

  for (let repaint = 1; repaint <= 3; repaint += 1) {
    root.repaint(settingsMarkup(input));
    for (const action of actions) {
      calls.length = 0;
      const control = root.get(`#${action.id}`);
      if (action.set === 'value') control.value = action.to!;
      if (action.set === 'checked') control.checked = true;
      const prevented = root.fire(action.event, control);
      if (action.event === 'submit') assert.equal(prevented, true, `the form never navigates after repaint ${repaint}`);
      const expected = action.effect === 'save'
        ? `save ${root.get('#live-provider').value}/${root.get('#live-voice').value!.trim()}/${root.get('#live-accent').value}`
        : action.effect;
      assert.deepEqual(calls, [expected], `${action.id} still acts after repaint ${repaint}`);
    }
    // The owner types a voice and presses Save provider, which carries no id and submits the form.
    calls.length = 0;
    root.get('#live-voice').value = ' marin ';
    assert.equal(root.fire('submit', root.get('#live-settings-form')), true, `Save provider never navigates after repaint ${repaint}`);
    assert.deepEqual(calls, [`save ${root.get('#live-provider').value}/marin/${root.get('#live-accent').value}`], 'the save carries the values the owner left in the repainted fields');
    // Every connector's Sign in button is a new node after each repaint and still names its own endpoint.
    for (const button of root.all.filter(control => 'data-signin' in control.attributes)) {
      signedIn.length = 0;
      root.fire('click', button);
      assert.equal(signedIn.length, 1, `a Sign in click after repaint ${repaint} sends one endpoint`);
    }
  }
  assert.equal(root.renders, 4, 'the panel was rendered once and repainted three times');
  assert.equal(root.navigations, 0, 'no submit ever reached the browser, so the page never reloaded');
});

test('main.ts installs the panel binder on the stable root and keeps none of the one-time binds', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/bindSettingsPanel\(/g)?.length, 1, 'the panel binder is installed once, from bindSettings');
  assert.equal(source.match(/bindSettings\(\);/g)?.length, 1, 'bind() calls it, not the repaint');
  assert.doesNotMatch(source, /form\('live-settings-form'/, 'no one-time submit bind that a repaint drops');
  assert.doesNotMatch(source, /bindConnectedHistory|bindLiveProviderSwitch/, 'no per-control rebinding left in the repaint path');
  assert.match(source, /panel\.outerHTML=settingsMarkup\(settingsInput\(\)\);/, 'the repaint only swaps the panel');
});

test('a notice raised while the Settings sheet is open is rendered inside the sheet, once', () => {
  const notice = 'Sign in to Mongoose Knowledge in the browser window.';
  const body = sheetBodyMarkup(settingsMarkup(input), '', notice);
  assert.match(body, /^<div class="sheet-body"><div class="notice" role="status" aria-live="polite" aria-atomic="true">Sign in to Mongoose Knowledge in the browser window\.<\/div>/);
  assert.ok(body.indexOf('class="notice"') < body.indexOf('id="settings-summary"'), 'the notice sits above the panel, inside the sheet');
  assert.equal(body.match(/aria-live/g)?.length, 1, 'one live region, so a reader hears the words once');
  assert.equal(laneNoticesMarkup('', notice, true), '', 'the lane row renders none while a sheet covers it');
  assert.match(laneNoticesMarkup('', notice, false), /^<div class="notice" role="status"/, 'with no sheet open the lane row still carries it');

  const failure = sheetBodyMarkup('<p>panel</p>', 'Could not save. Try again.', '');
  assert.match(failure, /^<div class="sheet-body"><div class="alert" role="alert" aria-live="assertive">Could not save\. Try again\.<\/div>/);
  assert.equal(sheetBodyMarkup('<p>panel</p>', '', ''), '<div class="sheet-body"><p>panel</p></div>', 'nothing pending renders no banner');
});
