import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CANDIDATES, RESEARCH, ResearchLedger, ResearchScheduler, candidateSubs, capReply, fallbackSelection, runResearch, type ResearchDeps, type SourceKind } from '../tools/research.js';
import { WEB_DEADLINE_MS, WEB_MODEL, WEB_SEARCH_ACTION, createWebSearch, publicQueryOf, webAttribution, webDeadlineMs, webEvidenceText, webFooter, type WebOutcome, type WebSearchPort } from '../tools/web-search.js';
import { safeEvent } from '../host/log.js';
import type { IntentSubCall, IntentSubResult } from '../tools/intent.js';

const KEY = { resolve: async () => 'test-key' };

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'The bridge reopened to traffic last Tuesday. The council lists the works as finished.' }] },
      groundingMetadata: {
        groundingChunks: [
          { web: { uri: 'https://example.com/bridge', title: 'Bridge reopening' } },
          { web: { uri: 'https://example.org/works', title: 'Council works list', pubDate: '2026-10-14' } },
          { web: { uri: 'https://example.net/notes', title: 'Traffic notes' } },
          { web: { uri: 'https://example.co/extra', title: 'Fourth source' } },
        ],
        groundingSupports: [
          { segment: { text: 'The bridge reopened to traffic last Tuesday.' }, groundingChunkIndices: [0] },
          { segment: { text: 'The council lists the works as finished.' }, groundingChunkIndices: [1, 2] },
        ],
        searchEntryPoint: { renderedContent: '<div class="g-search"><a href="https://google.com/search?q=bridge">Search</a></div>' },
      },
    }],
    ...overrides,
  };
}

const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

function transportOf(seen: { url?: string; body?: string; signal?: AbortSignal }[], response: () => Promise<Response>) {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, body: String(init.body), signal: init.signal as AbortSignal });
    return response();
  }) as unknown as typeof fetch;
}

test('a grounded response becomes evidence with claims mapped to at most five sources', async () => {
  const seen: { url?: string; body?: string; signal?: AbortSignal }[] = [];
  const port = createWebSearch({ credentials: KEY, transport: transportOf(seen, async () => json(body())), now: () => Date.parse('2026-10-21T12:00:00Z') });
  const outcome = await port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.evidence.sources.length, 3, 'at most five sources');
  assert.deepEqual(outcome.evidence.sources.map(source => source.title), ['Bridge reopening', 'Council works list', 'Traffic notes']);
  assert.equal(outcome.evidence.sources[1]!.publishedAt, '2026-10-14', 'publication time only when the result supplies it');
  assert.equal(outcome.evidence.sources[0]!.publishedAt, undefined);
  assert.deepEqual(outcome.evidence.claims.map(claim => claim.sourceIndexes), [[0], [1, 2]]);
  assert.match(outcome.evidence.retrievedAt, /^2026-10-21T12:00:00/);
  assert.match(outcome.evidence.searchEntryPoint ?? '', /google\.com\/search/, 'the required attribution markup is kept');
  assert.equal(seen[0]!.url, `https://generativelanguage.googleapis.com/v1beta/models/${WEB_MODEL}:generateContent`);
  const markdown = webFooter(outcome.evidence.sources.map(source => ({ title: source.title, url: source.url })));
  assert.match(markdown, /\[Bridge reopening\]\(https:\/\/example\.com\/bridge\)/);
  assert.equal(webEvidenceText(outcome.evidence).includes('https://'), false, 'the spoken evidence never carries a URL');
  assert.match(webEvidenceText(outcome.evidence), /web claim: The bridge reopened to traffic last Tuesday\. \[Bridge reopening\]/);
});

test('the request body carries only the public query, the search tool and low thinking', async () => {
  const seen: { url?: string; body?: string; signal?: AbortSignal }[] = [];
  const port = createWebSearch({ credentials: KEY, transport: transportOf(seen, async () => json(body())) });
  await port.search({ query: 'council bridge works status', signal: new AbortController().signal });
  const sent = JSON.parse(seen[0]!.body ?? '{}') as Record<string, unknown>;
  assert.deepEqual(sent['tools'], [{ google_search: {} }]);
  assert.deepEqual((sent['generationConfig'] as Record<string, unknown>)['thinkingConfig'], { thinkingLevel: 'low' });
  const query = JSON.stringify(sent['contents']);
  assert.match(query, /council bridge works status/);
  for (const privateText of ['research brief', 'launchpad', 'in:inbox', 'transcript', 'attendee']) assert.equal(JSON.stringify(sent).includes(privateText), false);
  assert.equal(seen[0]!.signal?.aborted, false);
  assert.equal(WEB_DEADLINE_MS, 14_000);
});

test('a question that cannot be separated from private content is reported instead of sent', async () => {
  const seen: { url?: string; body?: string; signal?: AbortSignal }[] = [];
  const port = createWebSearch({ credentials: KEY, transport: transportOf(seen, async () => json(body())) });
  const outcome = await port.search({ query: 'is rob@example.com free for the launchpad review on Friday', signal: new AbortController().signal });
  assert.deepEqual(outcome, { ok: false, code: 'web_private_question' });
  assert.equal(seen.length, 0, 'nothing egresses');
  assert.equal(publicQueryOf('is rob@example.com free on Friday'), undefined);
  assert.equal(publicQueryOf('bridge reopening date'), 'bridge reopening date');
});

test('a response without grounding metadata is typed insufficient, never a success', async () => {
  const bare = body() as { candidates: { groundingMetadata?: unknown }[] };
  delete bare.candidates[0]!.groundingMetadata;
  const port = createWebSearch({ credentials: KEY, transport: transportOf([], async () => json(bare)) });
  assert.deepEqual(await port.search({ query: 'bridge reopening date', signal: new AbortController().signal }), { ok: false, code: 'web_insufficient', reason: 'ungrounded' });
});

test('a transport past the deadline yields web_timeout and is cancelled', async () => {
  let cancelled = false;
  const slow = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { cancelled = true; reject(new Error('aborted')); });
  })) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport: slow, deadlineMs: 40 });
  const started = Date.now();
  assert.deepEqual(await port.search({ query: 'bridge reopening date', signal: new AbortController().signal }), { ok: false, code: 'web_timeout' });
  assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 2_000);
});

// --- #655: one web budget above the measured tail, and a cut that lands on it -------------------

/** Let the awaited credential and the transport start settle, so the fake clock owns every timer. */
const settled = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)); };

/** The fake clock's own reading of virtual time, which drives the mocked timers. */
const fakeClock = (t: { mock: { timers: { tick: (ms: number) => void } } }): { tick: (ms: number) => void; now: () => number } => {
  let elapsed = 0;
  return { tick: (ms) => { elapsed += ms; t.mock.timers.tick(ms); }, now: () => elapsed };
};

test('#655: the research row and the web module read one budget, above the measured tail', () => {
  // #670: 78 live grounded reads on 2026-10-25 measured median 5.2 s, p95 7.9 s, p99 10.3 s and max
  // 11.5 s, so 8 s cut about one read in twenty. R1: 14 s cuts none of them and still fits inside the 15 s
  // research patience budget, which is the one number `RESEARCH_OPERATION` names.
  assert.equal(RESEARCH.sourceDeadline.web, WEB_DEADLINE_MS, 'one number, read from one place');
  assert.equal(WEB_DEADLINE_MS, 14_000, 'the web budget is the 14 s that cut none of 78 measured reads');
  assert.equal(webDeadlineMs('what is the weather in Pune tomorrow'), WEB_DEADLINE_MS, 'a weather ask is not slower than any other');
});

test('#655: a web read that answers at 5 s is kept', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer: (response: Response) => void = () => {};
  const transport = (async () => new Promise<Response>(resolve => { answer = resolve; })) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport });
  const pending = port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  await settled();
  t.mock.timers.tick(5_000);
  answer(json(body()));
  const outcome = await pending;
  assert.equal(outcome.ok, true, 'a read inside the budget is kept, never cut');
});

test('#655: a web read that answers at 20 s is cut at the budget, not later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = fakeClock(t);
  let cutAt: number | undefined;
  let answeredLate = false;
  const transport = (async (_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    setTimeout(() => { answeredLate = true; resolve(json(body())); }, 20_000);
    options.signal?.addEventListener('abort', () => { cutAt = clock.now(); reject(new Error('aborted')); });
  })) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport });
  const pending = port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  await settled();
  clock.tick(WEB_DEADLINE_MS);
  assert.deepEqual(await pending, { ok: false, code: 'web_timeout' });
  assert.equal(cutAt, WEB_DEADLINE_MS, 'the cut lands on the budget, never after it');
  assert.equal(answeredLate, false, 'the 20 s answer never lands');
});

test('#670: a web read that answers at 11 s is kept and its findings reach the reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer: (response: Response) => void = () => {};
  const transport = (async (_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    answer = resolve;
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport });
  const pending = port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  await settled();
  t.mock.timers.tick(11_000);
  answer(json(body()));
  const outcome = await pending;
  if (!outcome.ok) assert.fail(`an 11 s read is inside the budget, not cut: ${outcome.code}`);
  assert.match(webEvidenceText(outcome.evidence), /web claim: The bridge reopened to traffic last Tuesday\./, 'the kept read carries its claim');
  // The kept read then rides the reply as web findings, so the extra second is a read the owner hears.
  t.mock.timers.reset();
  const h = harness(outcome);
  const reply = await new ResearchScheduler(h.deps).call({ action: 'start', question: 'what is the bridge reopening date' }, new AbortController().signal);
  const findings = (reply['findings'] as { source: string; text: string }[]) ?? [];
  assert.ok(findings.some(finding => finding.source === 'web' && finding.text.includes('The bridge reopened')), JSON.stringify(findings));
});

test('#670/R1: a web read still open at 14 s is cut there, and the reply names 14 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = fakeClock(t);
  let cutAt: number | undefined;
  let answeredLate = false;
  const transport = (async (_url: string, options: RequestInit) => new Promise<Response>((resolve, reject) => {
    setTimeout(() => { answeredLate = true; resolve(json(body())); }, 20_000);
    options.signal?.addEventListener('abort', () => { cutAt = clock.now(); reject(new Error('aborted')); });
  })) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport });
  const pending = port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  await settled();
  clock.tick(13_999);
  assert.equal(cutAt, undefined, 'the read is never cut before its budget');
  clock.tick(1);
  assert.deepEqual(await pending, { ok: false, code: 'web_timeout' });
  assert.equal(cutAt, 14_000, 'the cut lands on 14 s exactly');
  assert.equal(answeredLate, false, 'the 20 s answer never lands');
  t.mock.timers.reset();
  const h = harness({ ok: false, code: 'web_timeout' });
  const reply = await new ResearchScheduler(h.deps).call({ action: 'start', question: 'what is the bridge reopening date' }, new AbortController().signal);
  assert.equal((reply['unavailable'] as Record<string, string>)['web'], 'timeout', 'the reason code is the web timeout');
  assert.match(String(reply['note']), /the web: not read \(timed out after 14 s\)/, 'the timeout clause names the 14 s that cut it');
});

test('#655: a retry after an empty first attempt never extends past the budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = fakeClock(t);
  const bare = body() as { candidates: { groundingMetadata?: unknown }[] };
  delete bare.candidates[0]!.groundingMetadata;
  const starts: number[] = [];
  let cutAt: number | undefined;
  const transport = (async (_url: string, options: RequestInit) => {
    starts.push(clock.now());
    if (starts.length === 1) return json(bare);
    return new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { cutAt = clock.now(); reject(new Error('aborted')); });
    });
  }) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport });
  const pending = port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  await settled();
  clock.tick(1_000);
  await settled();
  assert.equal(starts.length, 2, 'an empty first attempt is retried once');
  clock.tick(WEB_DEADLINE_MS - 1_000);
  assert.deepEqual(await pending, { ok: false, code: 'web_timeout' });
  assert.equal(cutAt, WEB_DEADLINE_MS, 'the retry is cut on the first attempt clock, not on a budget of its own');
});


test('rate limiting and an outage are named, never answered as if they were searched', async () => {
  const port = createWebSearch({ credentials: KEY, transport: transportOf([], async () => json({}, 429)) });
  assert.deepEqual(await port.search({ query: 'bridge reopening date', signal: new AbortController().signal }), { ok: false, code: 'web_rate_limited' });
  const down = createWebSearch({ credentials: KEY, transport: transportOf([], async () => json({}, 503)) });
  assert.deepEqual(await down.search({ query: 'bridge reopening date', signal: new AbortController().signal }), { ok: false, code: 'web_unavailable' });
});

// --- The candidate set and the selector -----------------------------------------------------

test('the closed candidate set offers web_search on the web source', () => {
  assert.ok(CANDIDATES.some(candidate => candidate.kind === 'web_search' && candidate.source === 'web'));
  assert.equal(RESEARCH.sourceDeadline.web, WEB_DEADLINE_MS);
  const subs = candidateSubs('web_search', { question: 'bridge reopening date', configured: ['web'], evidence: new Map(), query: 'bridge reopening date' });
  assert.deepEqual(subs, [{ key: 'w0', name: WEB_SEARCH_ACTION, args: { query: 'bridge reopening date' } }]);
  assert.deepEqual(candidateSubs('web_search', { question: 'q', configured: [], evidence: new Map(), query: 'q' }), [], 'no configuration, no read');
});

// --- ROUTE-1022 K1: a lookup that names the web reads the web, and nothing else answers it -----

/** A routed harness: the model named the layers, so no selector runs. */
function routedDeps(opts: { configured: readonly SourceKind[]; web?: WebSearchPort; executed: string[]; dispatched: Record<string, unknown>[]; logged?: object[] }): ResearchDeps {
  return {
    now: () => 0,
    configured: opts.configured,
    ...(opts.web === undefined ? {} : { web: opts.web }),
    execute: async (subs: readonly IntentSubCall[]) => subs.map(call => {
      opts.executed.push(call.name);
      opts.dispatched.push({ ...call.args });
      return { key: call.key, name: call.name, ok: true, text: '**team**\nthe decision was recorded', originalCharacters: 30, omittedCharacters: 0 } as IntentSubResult;
    }),
    emit: () => {},
    log: entry => { opts.logged?.push(entry); },
    ledger: new ResearchLedger(),
  };
}

test('a web lookup dispatches the web search, never team chat, and the reply credits the web', async () => {
  const seen: { url?: string; body?: string; signal?: AbortSignal }[] = [];
  const port = createWebSearch({ credentials: KEY, transport: transportOf(seen, async () => json(body())) });
  const executed: string[] = [], dispatched: Record<string, unknown>[] = [];
  const reply = await runResearch(routedDeps({ configured: ['chat'], web: port, executed, dispatched }), {
    action: 'start', question: 'agricon 2026 dates', lookups: [{ source: 'web', query: 'agricon 2026 dates' }],
  }, new AbortController().signal);
  assert.equal(executed.includes('mattermost_search'), false, 'no chat read answers a web lookup');
  assert.equal(seen.length, 1, 'one real web search ran');
  assert.deepEqual(reply['sources'], { web: 'ok' }, 'the reply credits the layer that actually ran');
  assert.deepEqual((reply['findings'] as { source?: string }[]).map(finding => finding.source), ['web']);
});

test('a web lookup with no web configured says so, and reads nothing else', async () => {
  const executed: string[] = [], dispatched: Record<string, unknown>[] = [];
  const reply = await runResearch(routedDeps({ configured: ['chat', 'knowledge'], executed, dispatched }), {
    action: 'start', question: 'agricon 2026 dates', lookups: [{ source: 'web', query: 'agricon 2026 dates' }],
  }, new AbortController().signal);
  assert.deepEqual(executed, [], 'nothing is dispatched for a web this session cannot serve');
  assert.deepEqual(reply['sources'], { web: 'unavailable' });
  assert.match(String(reply['note']), /web: not available/, 'the reply names the web as unavailable');
});

// --- The loop: one web action, evidence in the findings, typed failure in the reply ---------

type Harness = { deps: ResearchDeps; runs: object[]; sources: object[]; executed: string[]; webCalls: string[] };

function harness(outcome: WebOutcome | (() => Promise<WebOutcome>)): Harness {
  const runs: object[] = [];
  const sources: object[] = [];
  const executed: string[] = [];
  const webCalls: string[] = [];
  const web: WebSearchPort = {
    search: async ({ query }) => {
      webCalls.push(query);
      return typeof outcome === 'function' ? outcome() : outcome;
    },
  };
  const deps: ResearchDeps = {
    now: () => 0,
    configured: ['web'] as readonly SourceKind[],
    web,
    execute: async (subs: readonly IntentSubCall[]) => { executed.push(...subs.map(call => call.name)); return [] as IntentSubResult[]; },
    emit: () => {},
    log: entry => runs.push(entry),
    logSource: entry => sources.push(entry),
    ledger: new ResearchLedger(),
  };
  return { deps, runs, sources, executed, webCalls };
}

const grounded: WebOutcome = {
  ok: true,
  evidence: {
    answer: 'The bridge reopened to traffic last Tuesday.',
    claims: [{ text: 'The bridge reopened to traffic last Tuesday.', sourceIndexes: [0] }],
    sources: [{ title: 'Bridge reopening', url: 'https://example.com/bridge' }],
    retrievedAt: '2026-10-21T12:00:00.000Z',
  },
};

test('the web candidate runs once and its evidence reaches the findings with its links kept apart', async () => {
  const h = harness(grounded);
  const reply = await new ResearchScheduler(h.deps).call({ action: 'start', question: 'what is the bridge reopening date' }, new AbortController().signal);
  assert.equal(h.webCalls.length, 1, 'at most one web action per invocation');
  assert.deepEqual(h.executed, [], 'a web read is never sent to a connector');
  const findings = reply['findings'] as { source: string; text: string }[];
  assert.ok(findings.some(finding => finding.source === 'web' && finding.text.includes('The bridge reopened')), JSON.stringify(findings));
  assert.equal(findings.some(finding => finding.text.includes('https://')), false, 'the spoken findings never carry a URL');
  assert.match(String(reply['markdown']), /\[Bridge reopening\]\(https:\/\/example\.com\/bridge\)/, 'the transcript keeps the source as a link');
  assert.equal(JSON.stringify(h.runs).includes('bridge reopening date'), false, 'telemetry never carries the query text');
  assert.ok(JSON.stringify(h.sources).includes('"source":"web"'), 'the web read reports a receipt');
});

test('a web failure names the web part as missing instead of answering as if it had searched', async () => {
  const h = harness({ ok: false, code: 'web_timeout' });
  const reply = await new ResearchScheduler(h.deps).call({ action: 'start', question: 'what is the bridge reopening date' }, new AbortController().signal);
  const findings = (reply['findings'] as { source: string; text: string }[]) ?? [];
  assert.equal(findings.some(finding => finding.source === 'web'), false, 'no web evidence is claimed');
  const unavailable = JSON.stringify(reply['unavailable'] ?? {});
  assert.match(unavailable, /timeout/, 'the reply carries the timeout reason');
  // N6 (#569): a cut web read reaches the model as timeout, never as an endpoint outage.
  assert.equal((reply['unavailable'] as Record<string, string>)['web'], 'timeout', 'the timeout reason rides the reply');
  // #655: a cut web read is spoken as the web taking too long, never as an access or service
  // problem, and the seconds it names are the budget that actually cut it.
  assert.match(String(reply['note']), /The web took too long to answer, so that part is missing\./, 'Naya says the web took too long');
  assert.match(String(reply['note']), new RegExp(`the web: not read \\(timed out after ${Math.round(WEB_DEADLINE_MS / 1_000)} s\\)`), 'the seconds named are the budget that cut it');
  assert.doesNotMatch(String(reply['note']), /could not reach|unavailable/i, 'a timeout is never spoken as an access or service problem');
  // #663: a web part that never arrived is not a licence to answer as if it had, so the reply says what the
  // model's own knowledge counts as.
  assert.match(String(reply['note']), /general knowledge, so say so/, 'a timed out web read asks for the general knowledge label');
  assert.equal(JSON.stringify(reply).includes('bridge reopening date'), false);
});

// #663: the same label applies when the web read failed outright instead of timing out.
test('a failed web read asks for the general knowledge label too', async () => {
  const h = harness({ ok: false, code: 'web_unavailable' });
  const reply = await new ResearchScheduler(h.deps).call({ action: 'start', question: 'what is the bridge reopening date' }, new AbortController().signal);
  const note = String(reply['note']);
  assert.match(note, /I could not reach the web right now\./, 'the failed read is spoken as the web out of reach');
  assert.match(note, /general knowledge, so say so/, 'and anything the model adds itself is labelled general knowledge');
});

// --- B2: the grounding attribution is honoured, and B4: the web receipt survives the log gate ---

test('the search entry point links are honoured in the transcript, https only', () => {
  const rendered = '<div class="g-search"><a href="https://www.google.com/search?q=bridge" target="_blank">Search bridge</a>'
    + '<a href="javascript:alert(1)">bad</a><a href="http://insecure.example">plain http</a></div>';
  const links = webAttribution(rendered);
  assert.deepEqual(links, [{ title: 'Search bridge', url: 'https://www.google.com/search?q=bridge' }], 'only an https entry point link survives');
  const footer = webFooter([{ title: 'Bridge reopening', url: 'https://example.com/bridge' }], links);
  assert.match(footer, /\[Bridge reopening\]\(https:\/\/example\.com\/bridge\)/);
  assert.match(footer, /\[Search bridge\]\(https:\/\/www\.google\.com\/search\?q=bridge\)/, 'the attribution rides the transcript');
  assert.deepEqual(webAttribution(undefined), []);
});

test('the loop puts the attribution link in the reply markdown and never in the spoken findings', async () => {
  const h = harness({ ok: true, evidence: {
    answer: 'The bridge reopened to traffic last Tuesday.',
    claims: [{ text: 'The bridge reopened to traffic last Tuesday.', sourceIndexes: [0] }],
    sources: [{ title: 'Bridge reopening', url: 'https://example.com/bridge' }],
    retrievedAt: '2026-10-21T12:00:00.000Z',
    searchEntryPoint: '<div><a href="https://www.google.com/search?q=bridge">Search bridge</a></div>',
  } });
  const reply = await new ResearchScheduler(h.deps).call({ action: 'start', question: 'what is the bridge reopening date' }, new AbortController().signal);
  assert.match(String(reply['markdown']), /\[Search bridge\]\(https:\/\/www\.google\.com/);
  assert.deepEqual(reply['webAttribution'], [{ title: 'Search bridge', url: 'https://www.google.com/search?q=bridge' }]);
  const findings = reply['findings'] as { text: string }[];
  assert.equal(findings.some(finding => finding.text.includes('google.com')), false);
});

test('the web receipt and the web candidate survive the host log gate', () => {
  const receipt = safeEvent({ event: 'research_source', researchId: 'r-1', source: 'web', outcome: 'ok', ms: 812, deadlineMs: 4000, coalesced: 1 });
  assert.deepEqual(receipt, { event: 'research_source', researchId: 'r-1', source: 'web', outcome: 'ok', ms: 812, deadlineMs: 4000, coalesced: 1 });
  const down = safeEvent({ event: 'research_source', researchId: 'r-1', source: 'web', outcome: 'unavailable', ms: 4, deadlineMs: 4000, coalesced: 1 });
  assert.equal(down?.['source'], 'web', 'a typed web failure is kept, never dropped');
  assert.equal(JSON.stringify(receipt).includes('bridge'), false, 'the receipt never carries the query text');
});

// --- M2: a dropped chunk never re-points a later citation, and an out-of-range index never crashes ---

test('a dropped chunk keeps every later citation on its own source', async () => {
  const dropped = body() as { candidates: { groundingMetadata: { groundingChunks: unknown[]; groundingSupports: { segment: { text: string }; groundingChunkIndices: number[] }[] } }[] };
  dropped.candidates[0]!.groundingMetadata.groundingChunks = [
    { web: { uri: 'http://insecure.example/x', title: 'Insecure' } },
    { web: { uri: 'https://example.org/works', title: 'Council works list' } },
    { web: { uri: 'https://example.net/notes', title: 'Traffic notes' } },
  ];
  dropped.candidates[0]!.groundingMetadata.groundingSupports = [
    { segment: { text: 'The bridge reopened to traffic last Tuesday.' }, groundingChunkIndices: [1] },
    { segment: { text: 'The council lists the works as finished.' }, groundingChunkIndices: [2] },
  ];
  const port = createWebSearch({ credentials: KEY, transport: transportOf([], async () => json(dropped)) });
  const outcome = await port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.evidence.sources.map(source => source.title), ['Council works list', 'Traffic notes']);
  assert.deepEqual(outcome.evidence.claims.map(claim => claim.sourceIndexes), [[0], [1]], 'citation one points at the works list, two at the notes');
  assert.equal(webEvidenceText(outcome.evidence).includes('[Council works list]'), true);
});

test('an out-of-range chunk index is dropped instead of crashing the reply path', async () => {
  const broken = body() as { candidates: { groundingMetadata: { groundingSupports: { segment: { text: string }; groundingChunkIndices: number[] }[] } }[] };
  broken.candidates[0]!.groundingMetadata.groundingSupports = [
    { segment: { text: 'The bridge reopened to traffic last Tuesday.' }, groundingChunkIndices: [9] },
    { segment: { text: 'The council lists the works as finished.' }, groundingChunkIndices: [1] },
  ];
  const port = createWebSearch({ credentials: KEY, transport: transportOf([], async () => json(broken)) });
  const outcome = await port.search({ query: 'bridge reopening date', signal: new AbortController().signal });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.evidence.claims.map(claim => claim.sourceIndexes), [[0]], 'the kept chunk becomes the first source');
  assert.deepEqual(outcome.evidence.sources.map(source => source.title), ['Council works list']);
  assert.equal(webFooter(outcome.evidence.sources).includes('undefined'), false);
  assert.equal(webFooter(outcome.evidence.sources).includes('https://example.org/works'), true);
});

test('the deterministic fallback offers the web read for a public question once web is configured', () => {
  const offered = fallbackSelection('what is the latest news on the bridge', ['web']);
  assert.ok(offered.actions.some(action => action.kind === 'web_search'), JSON.stringify(offered.actions));
  assert.deepEqual(fallbackSelection('what is the latest news on the bridge', []).actions.filter(action => action.kind === 'web_search'), [], 'nothing offered without the web source');
  assert.deepEqual(fallbackSelection('where does the release stand', ['web']).actions.filter(action => action.kind === 'web_search'), []);
});

test('MED-1022: an internal question that says latest never offers the web read', () => {
  assert.deepEqual(fallbackSelection('what is the latest on the OCP deck', ['web', 'knowledge']).actions.filter(action => action.kind === 'web_search'), [], 'latest is not public intent');
  assert.ok(fallbackSelection('what is the weather in Pune', ['web']).actions.some(action => action.kind === 'web_search'), 'a public question still offers it');
  assert.deepEqual(fallbackSelection('what is the cost of the licences', ['web']).actions.filter(action => action.kind === 'web_search'), [], 'cost is internal, not public intent');
});

test('T-R5: a price question about our own licence is internal, never a web read', () => {
  assert.deepEqual(fallbackSelection('what is our API licence price', ['web', 'knowledge']).actions.filter(action => action.kind === 'web_search'), [], 'price is how the owner asks about his own business');
  assert.deepEqual(fallbackSelection('what are the prices on the plan', ['web']).actions.filter(action => action.kind === 'web_search'), []);
});

// --- N6 (#569): an explicit weather or news ask gets the long web budget ------------------------

test('#655: every web ask takes the one web budget, since weather measured no slower than the rest', () => {
  assert.equal(webDeadlineMs('what is the weather in Pune tomorrow'), WEB_DEADLINE_MS);
  assert.equal(webDeadlineMs('latest news on the bridge closure'), WEB_DEADLINE_MS);
  assert.equal(webDeadlineMs('bridge reopening date'), WEB_DEADLINE_MS);
});

test('N6: a weather read that settles at 6 s succeeds, and a generic read is named timeout', async () => {
  const weatherSeen: number[] = [];
  const weather: WebSearchPort = {
    search: async ({ deadlineMs }) => {
      weatherSeen.push(deadlineMs ?? WEB_DEADLINE_MS);
      return (deadlineMs ?? WEB_DEADLINE_MS) >= 6_000 ? grounded : { ok: false, code: 'web_timeout' };
    },
  };
  const weatherReply = await runResearch(routedDeps({ configured: ['web'], web: weather, executed: [], dispatched: [] }), {
    action: 'start', question: 'what is the weather in Pune', lookups: [{ source: 'web', query: 'weather in Pune tomorrow' }],
  }, new AbortController().signal);
  assert.deepEqual(weatherSeen, [WEB_DEADLINE_MS], 'the port is told the one web budget for a weather ask');
  assert.deepEqual(weatherReply['sources'], { web: 'ok' }, 'a 6 s weather read is no longer cut');

  const genericSeen: number[] = [];
  const logged: object[] = [];
  const generic: WebSearchPort = {
    search: async ({ deadlineMs }) => {
      genericSeen.push(deadlineMs ?? WEB_DEADLINE_MS);
      return { ok: false, code: 'web_timeout' };
    },
  };
  const genericReply = await runResearch(routedDeps({ configured: ['web'], web: generic, executed: [], dispatched: [], logged }), {
    action: 'start', question: 'bridge reopening date', lookups: [{ source: 'web', query: 'bridge reopening date' }],
  }, new AbortController().signal);
  assert.deepEqual(genericSeen, [WEB_DEADLINE_MS], 'every other ask keeps the short deadline');
  assert.deepEqual(genericReply['unavailable'], { web: 'timeout' }, 'the model hears timeout, never endpoint_unavailable');
  const run = logged.find(entry => (entry as { event?: string }).event === 'research_run') as { sources?: { kind: string; reason?: string }[] } | undefined;
  assert.deepEqual(run?.sources?.filter(source => source.kind === 'web').map(source => source.reason), ['timeout'], 'the run log names the timeout too');
});

test('N6: a per-call deadline overrides the port default', async () => {
  const hanging = (async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as unknown as typeof fetch;
  const port = createWebSearch({ credentials: KEY, transport: hanging });
  const started = Date.now();
  assert.deepEqual(await port.search({ query: 'weather in Pune tomorrow', signal: new AbortController().signal, deadlineMs: 40 }), { ok: false, code: 'web_timeout' });
  assert.ok(Date.now() - started < 2_000);
});

// WEB-1024: these regressions assert the evidence that reaches the model, not HTTP success.
test('WEB-1024: public fact shapes offer web but private source words keep it off', () => {
  for (const question of ['What is the price of a Herreshoff Caribbean 50', 'how much is a bicycle', 'latest version of Node', 'who is Ada Lovelace', 'when did Apollo land', 'release date of Node', 'population of Pune', 'exchange rate USD INR', 'cricket score', 'results of the marathon']) {
    assert.ok(fallbackSelection(question, ['web']).actions.some(action => action.kind === 'web_search'), question);
  }
  for (const question of ['what did Thomas write about the price', 'price of our licence', 'latest version in my mail', 'weather in the calendar', 'news in chat', 'when did we agree']) {
    assert.equal(fallbackSelection(question, ['web']).actions.some(action => action.kind === 'web_search'), false, question);
  }
});

test('WEB-1024: cap preserves clipped web evidence and its first source, with metadata outside the spoken budget', () => {
  assert.ok(grounded.ok);
  if (!grounded.ok) return;
  const evidence = { ...grounded.evidence, answer: 'The bridge reopened. ' + 'The works are finished. '.repeat(39), claims: [{ text: 'The bridge reopened.', sourceIndexes: [0] }], sources: [...grounded.evidence.sources, { title: 'Council', url: 'https://example.org/' + 'x'.repeat(3000) }] };
  const reply = capReply({ status: 'complete', sources: { web: 'ok' }, findings: [{ source: 'knowledge', text: 'knowledge: 1 of 1 shown\n' + 'A complete statement. '.repeat(105) }, { source: 'web', text: 'web: 1 of 1 shown\n' + webEvidenceText(evidence) }], webSources: evidence.sources }, 2500);
  const finding = (reply['findings'] as { source: string; text: string }[]).find(item => item.source === 'web');
  assert.ok(finding, JSON.stringify(reply));
  assert.match(finding.text, /The bridge reopened\./);
  assert.match(finding.text, /web sources: 1\. Bridge reopening/);
  assert.match(finding.text, /ask for the full result/i);
  const { webSources: _metadata, ...spoken } = reply;
  assert.ok(JSON.stringify(spoken).length <= 2500);
  assert.deepEqual(reply['webSources'], evidence.sources);
});

test('WEB-1024: evidence that cannot fit is typed insufficient, never web ok with empty findings', () => {
  const reply = capReply({ sources: { web: 'ok' }, findings: [{ source: 'web', text: 'web: 1 of 1 shown\nweb answer: ' + 'Long answer. '.repeat(80) + '\nweb claim: Long answer. [Bridge]\nweb sources: 1. Bridge' }] }, 240);
  assert.notEqual((reply['sources'] as Record<string, unknown> | undefined)?.['web'], 'ok');
  assert.deepEqual(reply['webInsufficient'], { code: 'web_insufficient', reason: 'reply_budget' });
});

test('WEB-1024: cap rechecks grounding after supported claims fall outside the word cap', async () => {
  const payload = body() as { candidates: { content: { parts: { text: string }[] }; groundingMetadata: { groundingSupports: unknown[] } }[] };
  payload.candidates[0]!.content.parts[0]!.text = 'Unsupported filler. '.repeat(230) + 'The bridge reopened.';
  payload.candidates[0]!.groundingMetadata.groundingSupports = [{ segment: { text: 'The bridge reopened.' }, groundingChunkIndices: [0] }];
  const seen: { body?: string }[] = [];
  const port = createWebSearch({ credentials: KEY, transport: transportOf(seen, async () => json(payload)) });
  assert.deepEqual(await port.search({ query: 'bridge reopening date', signal: new AbortController().signal }), { ok: false, code: 'web_insufficient', reason: 'capped' });
  assert.equal(seen.length, 2, 'one retry only');
});

test('WEB-1024: empty results retry once with a broader entity query', async () => {
  const seen: { body?: string }[] = [];
  const port = createWebSearch({ credentials: KEY, transport: transportOf(seen, async () => json(seen.length === 1 ? { candidates: [] } : body())) });
  assert.equal((await port.search({ query: 'please find the latest bridge reopening date in Pune 2026', signal: new AbortController().signal })).ok, true);
  assert.equal(seen.length, 2);
  const retry = JSON.stringify(JSON.parse(seen[1]!.body!)['contents']);
  assert.match(retry, /bridge/); assert.match(retry, /Pune/); assert.match(retry, /2026/);
  assert.doesNotMatch(retry, /please|latest|find/);
  assert.equal(WEB_MODEL, 'gemini-3.8-flash');
  const emptySeen: { body?: string }[] = [];
  const empty = createWebSearch({ credentials: KEY, transport: transportOf(emptySeen, async () => json({ candidates: [] })) });
  assert.deepEqual(await empty.search({ query: 'bridge reopening date', signal: new AbortController().signal }), { ok: false, code: 'web_insufficient', reason: 'empty' });
  assert.equal(emptySeen.length, 2);
});


test('WEB-1024: a multi-sentence supported claim is clipped as sentences rather than removed whole', () => {
  assert.ok(grounded.ok); if (!grounded.ok) return;
  const answer = 'The bridge reopened. ' + 'The council completed the works. '.repeat(28);
  const text = webEvidenceText({ ...grounded.evidence, answer, claims: [{ text: answer.trim(), sourceIndexes: [0] }] });
  const reply = capReply({ status: 'complete', sources: { web: 'ok' }, findings: [{ source: 'web', text: 'web: 1 of 1 shown\n' + text }] }, 750);
  const findings = reply['findings'] as { text: string }[];
  assert.equal(findings.length, 1);
  assert.ok(findings[0]!.text.length < text.length);
  assert.match(findings[0]!.text, /web answer: The bridge reopened\./);
  assert.match(findings[0]!.text, /web sources: 1\. Bridge reopening/);
  assert.equal(reply['webInsufficient'], undefined);
});

test('WEB-1024: fallback query clipping keeps entity date and place tokens before descriptions', () => {
  const offered = fallbackSelection('please tell me the price of ' + 'beautiful classic restored wooden sailing vessel '.repeat(5) + 'Herreshoff Caribbean 50 Pune 2026', ['web']);
  const action = offered.actions.find(action => action.kind === 'web_search');
  assert.ok(action);
  const query = String(action.query);
  assert.ok(query.length <= 120);
  for (const token of ['Herreshoff', 'Caribbean', '50', 'Pune', '2026']) assert.ok(query.includes(token), query);
  assert.doesNotMatch(query, /please|tell me/);
});

// --- #1028: the name is resolved before the web is asked -------------------------------------------

test('#1028: a misheard organisation resolves to the name her own calendar digest carries', async () => {
  const h = harness({ ok: false, code: 'web_insufficient', reason: 'empty' });
  const deps: ResearchDeps = {
    ...h.deps, configured: ['knowledge', 'calendar', 'web'] as readonly SourceKind[],
    calendarDigest: () => '09:00 Standup, 11:00 Acme Seeds quarterly review',
  };
  const reply = await runResearch(deps, {
    action: 'start', question: 'what did Akme Seats decide about the harvest',
    lookups: [{ source: 'web', query: 'Akme Seats harvest' }],
  }, new AbortController().signal);
  assert.equal(h.webCalls.length, 1, 'the web was read once');
  assert.match(h.webCalls[0]!, /Acme Seeds/u, 'the web query names the organisation the owner meant');
  assert.doesNotMatch(h.webCalls[0]!, /Akme/u, 'the web never searched the mishearing as it was heard');
  assert.ok(h.executed.includes('search_knowledge'), 'knowledge ran for a named organisation');
  assert.ok(h.executed.includes('calendar_list_events'), 'calendar ran for a named organisation');
  assert.ok(reply['researchId'] !== undefined, 'the round answered');
});
