import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { attachHostLogSink } from '../tools/host-events.js';
import { beginHandleSession, endHandleSession, exposeHandles, gmailThreadUrl, homeDestination, noteGmailAccount, openDestination, registrableDomain, resolveHandle, siteRootUrl, spokenDomain, webDestination } from '../tools/open-handles.js';
import { openTarget } from '../tools/open.js';
import { DRIVE_CHOOSE_GUIDANCE, shapeDriveFile, shapeDriveSearch, shapeGcalList, shapeGmailList, shapeGmailRead } from '../tools/live-shape.js';
import { renderGoogleTool } from '../tools/google.js';
import { DRIVE_MIME_TYPES } from '../tools/research.js';
import { SITE_BLOCKLIST, pickSiteDomain } from '../tools/web-search.js';

/** The check script copies the shared table and both allowlist sources next to the compiled test. */
const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const TABLE = JSON.parse(fixture('open-destinations.json')) as { cases: { url: string; kind: string | null }[] };

// The real Calendar htmlLink shape: host www.google.com, path /calendar/event, an eid (synthetic value).
const REAL_EVENT_LINK = 'https://www.google.com/calendar/event?eid=c3ludGhldGljLWV2ZW50IG93bmVyQGV4YW1wbGUudGVzdA';
const OWNER = 'owner@example.test';
const listHeaders = (subject: string) => [{ name: 'From', value: 'Synthetic Sender <sender@example.invalid>' }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Mon, 1 Jan 2024 00:00:00 +0000' }];
const owners = [{ displayName: 'Synthetic Owner', emailAddress: 'owner@example.test' }];
const DECK_NEW = { id: 'SyntheticDeckNew01', name: 'Harbour review deck', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-10-24T08:00:00.000Z', owners, webViewLink: 'https://docs.google.com/presentation/d/SyntheticDeckNew01/edit?usp=drivesdk' };
const DECK_OLD = { id: 'SyntheticDeckOld01', name: 'Harbour review deck (old)', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-09-02T08:00:00.000Z', owners, webViewLink: 'https://docs.google.com/presentation/d/SyntheticDeckOld01/edit?usp=drivesdk' };
const DOC = { id: 'SyntheticDoc01', name: 'Harbour review notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-08-11T08:00:00.000Z', owners, webViewLink: 'https://docs.google.com/document/d/SyntheticDoc01/edit?usp=drivesdk' };
const PPTX = { id: 'SyntheticPptx01', name: 'Harbour board.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', modifiedTime: '2026-10-20T08:00:00.000Z', owners, webViewLink: 'https://drive.google.com/file/d/SyntheticPptx01/view?usp=drivesdk' };

const handlesOf = (text: string): string[] => [...text.matchAll(/^open: (L\d+) = /gm)].map(match => match[1]!);

test('C-OPEN 1: the host allowlist answers the shared destination table exactly', () => {
  assert.ok(TABLE.cases.length >= 40, 'the table is the real one, not an empty stub');
  for (const { url, kind } of TABLE.cases) assert.equal(openDestination(url)?.kind ?? null, kind, url);
});

test('C-OPEN 1: the host and native allowlists name the same hosts', () => {
  const host = fixture('parity-open-handles.ts');
  const native = fixture('parity-NativeActions.swift');
  const hostBody = host.slice(host.indexOf('export function openDestination'), host.indexOf('export function homeDestination'));
  const nativeBody = native.slice(native.indexOf('public static func of('), native.indexOf('private static func matches('));
  const hostHosts = new Set([...hostBody.matchAll(/host === '([a-z0-9.-]+)'/g)].map(match => match[1]!));
  const nativeHosts = new Set([...nativeBody.matchAll(/"([a-z0-9-]+(?:\.[a-z0-9-]+)+)"/g)].map(match => match[1]!));
  assert.deepEqual([...hostHosts].sort(), [...nativeHosts].sort());
  assert.ok(hostHosts.has('www.google.com'), 'the real Calendar event host is on both lists');
  assert.ok(hostHosts.size >= 8);
});

test('C-OPEN 1: a real-shaped Calendar event link mints a handle that opens', () => {
  beginHandleSession('open-dest-cal');
  const shaped = shapeGcalList({ events: [{ id: 'e1', summary: 'Synthetic review', start: { dateTime: '2026-10-25T07:00:00Z' }, htmlLink: REAL_EVENT_LINK }] });
  const [handle] = handlesOf(shaped.text);
  assert.ok(handle, 'the www.google.com event link minted an open: line');
  exposeHandles(shaped.text);
  assert.deepEqual(resolveHandle(handle!)?.url, REAL_EVENT_LINK);
  const resolved = openTarget('open_source', { handle: handle! }, 'open the three pm event');
  assert.ok('target' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.target.target, REAL_EVENT_LINK);
  assert.equal(resolved.target.kind, 'calendar');
  endHandleSession('open-dest-cal');
});

test('C-OPEN 4: a Gmail link names the signed-in account and the thread in all mail', () => {
  beginHandleSession('open-dest-gmail');
  noteGmailAccount(OWNER);
  try {
    assert.equal(gmailThreadUrl('t-1'), `https://mail.google.com/mail/u/${OWNER}/#all/t-1`);
    assert.equal(homeDestination('gmail')?.url, `https://mail.google.com/mail/u/${OWNER}/`);
    const shaped = shapeGmailList({ messages: [{ id: 'm1', threadId: 't1', headers: listHeaders('Synthetic forecast') }] });
    assert.deepEqual(shaped.sources?.map(source => source.url), [`https://mail.google.com/mail/u/${OWNER}/#all/t1`]);
    const [handle] = handlesOf(shaped.text);
    exposeHandles(shaped.text);
    const resolved = openTarget('open_source', { handle: handle! }, 'open that email');
    assert.ok('target' in resolved);
    assert.equal(resolved.target.target, `https://mail.google.com/mail/u/${OWNER}/#all/t1`);
  } finally { noteGmailAccount(undefined); endHandleSession('open-dest-gmail'); }
});

test('C-OPEN 4: with no account the link falls back to /u/0 and the log says so, once per session', () => {
  const events: unknown[] = [];
  const detach = attachHostLogSink({ event: raw => events.push(raw) });
  beginHandleSession('open-dest-gmail-0');
  noteGmailAccount(undefined);
  try {
    assert.equal(gmailThreadUrl('t9'), 'https://mail.google.com/mail/u/0/#all/t9');
    gmailThreadUrl('t10');
    assert.deepEqual(events.filter(event => (event as { event?: string }).event === 'gmail_account_unknown'), [{ event: 'gmail_account_unknown' }]);
    noteGmailAccount('not an address');
    assert.equal(gmailThreadUrl('t11'), 'https://mail.google.com/mail/u/0/#all/t11', 'a value that is not an address is no account');
  } finally { detach(); endHandleSession('open-dest-gmail-0'); }
});

test('C-OPEN 4: a message with no thread id opens by its own id; a list row never uses the inbox label', () => {
  beginHandleSession('open-dest-gmail-id');
  noteGmailAccount(OWNER);
  try {
    const shaped = shapeGmailList({ messages: [{ id: 'm7', headers: listHeaders('Synthetic archived') }] });
    assert.deepEqual(shaped.sources?.map(source => source.url), [`https://mail.google.com/mail/u/${OWNER}/#all/m7`]);
    assert.equal(JSON.stringify(shaped).includes('#inbox/'), false);
  } finally { noteGmailAccount(undefined); endHandleSession('open-dest-gmail-id'); }
});

test('C-OPEN 2: a URL inside an email body is never minted; the read message itself is', () => {
  beginHandleSession('open-dest-body');
  noteGmailAccount(OWNER);
  try {
    const shaped = shapeGmailRead({ id: 'm1', threadId: 't1', headers: { Subject: 'Synthetic deck', From: 'Synthetic Sender <sender@example.invalid>' }, format: 'full', body: 'Here is the deck: https://docs.google.com/presentation/d/SyntheticDeckNew01/edit and the sheet https://drive.google.com/file/d/SyntheticFile01/view', bodyCoverage: { complete: true } });
    const handles = handlesOf(shaped.text);
    assert.equal(handles.length, 1, shaped.text);
    exposeHandles(shaped.text);
    assert.equal(resolveHandle(handles[0]!)?.url, `https://mail.google.com/mail/u/${OWNER}/#all/t1`);
    assert.equal(resolveHandle(handles[0]!)?.kind, 'gmail');
    assert.equal((shaped.sources ?? []).some(source => /docs\.google|drive\.google/.test(source.url ?? '')), false, 'no body link travels as a source either');
  } finally { noteGmailAccount(undefined); endHandleSession('open-dest-body'); }
});

test('C-OPEN 2: one Drive match mints a handle from webViewLink and says name, kind, date and owner', () => {
  beginHandleSession('open-dest-drive-1');
  const shaped = shapeDriveSearch({ files: [DECK_NEW] });
  const [handle] = handlesOf(shaped.text);
  assert.ok(handle, shaped.text);
  assert.match(shaped.text, /Harbour review deck/);
  assert.match(shaped.text, /Slides deck/);
  assert.match(shaped.text, /modified 2026-10-24/);
  assert.match(shaped.text, /owner Synthetic Owner/);
  assert.equal(/https?:\/\//.test(shaped.text), false, 'the model text never carries the link');
  exposeHandles(shaped.text);
  assert.equal(resolveHandle(handle!)?.url, DECK_NEW.webViewLink);
  const resolved = openTarget('open_source', { handle: handle! }, 'open the harbour deck');
  assert.ok('target' in resolved);
  assert.equal(resolved.target.target, DECK_NEW.webViewLink);
  assert.equal(resolved.target.kind, 'docs');
  endHandleSession('open-dest-drive-1');
});

test('C-OPEN 2: an Office deck stored in Drive opens as the deck he asked for', () => {
  beginHandleSession('open-dest-drive-pptx');
  const shaped = shapeDriveSearch({ files: [PPTX] });
  const [handle] = handlesOf(shaped.text);
  exposeHandles(shaped.text);
  const resolved = openTarget('open_source', { handle: handle! }, 'open the board deck');
  assert.ok('target' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.target.target, PPTX.webViewLink);
  assert.match(shaped.text, /PowerPoint deck/);
  endHandleSession('open-dest-drive-pptx');
});

test('C-OPEN 2: a download, export or content link is never minted, whatever field it rides in', () => {
  beginHandleSession('open-dest-drive-dl');
  const download = shapeDriveSearch({ files: [{ ...DECK_NEW, webViewLink: 'https://drive.google.com/uc?id=SyntheticDeckNew01&export=download' }] });
  assert.deepEqual(handlesOf(download.text), [], download.text);
  assert.match(download.text, /no viewer link/);
  const exported = shapeDriveSearch({ files: [{ ...DOC, webViewLink: 'https://docs.google.com/document/d/SyntheticDoc01/export?format=pdf' }] });
  assert.deepEqual(handlesOf(exported.text), []);
  // Fields the contract never returns still never become a destination when a helper sends them.
  const extra = shapeDriveSearch({ files: [{ ...DOC, webContentLink: 'https://drive.google.com/uc?id=SyntheticDoc01&export=download', exportLinks: { 'application/pdf': 'https://docs.google.com/feeds/download/documents/export/Export?id=SyntheticDoc01' } }] });
  const [handle] = handlesOf(extra.text);
  exposeHandles(extra.text);
  assert.equal(resolveHandle(handle!)?.url, DOC.webViewLink);
  assert.equal(JSON.stringify(extra).includes('export'), false);
  const missing = shapeDriveSearch({ files: [{ ...DOC, webViewLink: undefined }] });
  assert.deepEqual(handlesOf(missing.text), []);
  endHandleSession('open-dest-drive-dl');
});

test('C-OPEN 3: several plausible files mint nothing; the result asks with names, dates and ids', () => {
  beginHandleSession('open-dest-drive-many');
  const shaped = shapeDriveSearch({ files: [DECK_NEW, DECK_OLD, DOC] });
  assert.deepEqual(handlesOf(shaped.text), [], 'no handle until he picks one');
  assert.ok(shaped.text.includes(DRIVE_CHOOSE_GUIDANCE), shaped.text);
  assert.match(shaped.text, /Harbour review deck \| Slides deck \| modified 2026-10-24/);
  assert.match(shaped.text, /Harbour review deck \(old\) \| Slides deck \| modified 2026-09-02/);
  assert.match(shaped.text, /\[id SyntheticDeckNew01\]/);
  assert.ok(shaped.text.indexOf('SyntheticDeckNew01') < shaped.text.indexOf('SyntheticDeckOld01'), 'newest first, as the helper ordered them');
  assert.equal(/https?:\/\//.test(shaped.text), false);
  endHandleSession('open-dest-drive-many');
});

test('C-OPEN 3: after he picks, the fresh drive_get_file result mints the handle', () => {
  beginHandleSession('open-dest-drive-get');
  const shaped = shapeDriveFile({ ...DECK_OLD, trashed: false });
  const [handle] = handlesOf(shaped.text);
  assert.ok(handle, shaped.text);
  exposeHandles(shaped.text);
  assert.equal(resolveHandle(handle!)?.url, DECK_OLD.webViewLink);
  const trashed = shapeDriveFile({ ...DECK_OLD, trashed: true });
  assert.deepEqual(handlesOf(trashed.text), []);
  assert.match(trashed.text, /in the trash/);
  endHandleSession('open-dest-drive-get');
});

test('C-OPEN 2: an empty or cut Drive listing says so and mints nothing', () => {
  beginHandleSession('open-dest-drive-empty');
  const empty = shapeDriveSearch({ files: [] });
  assert.deepEqual(handlesOf(empty.text), []);
  assert.match(empty.text, /No Drive file matched/);
  const cut = shapeDriveSearch({ files: [DECK_NEW, DECK_OLD], sourceIncomplete: true });
  assert.match(cut.text, /newest 2 of more/);
  assert.equal(cut.partial, true);
  const routed = renderGoogleTool('drive_search_files', { files: [DECK_NEW] });
  assert.equal(handlesOf(routed.text).length, 1, 'the Google projector routes the Drive tool to its shaper');
  endHandleSession('open-dest-drive-empty');
});

test('C-OPEN 5: the native opener names Chrome by bundle id and never scripts the browser', () => {
  const native = fixture('parity-NativeActions.swift');
  assert.match(native, /"com\.google\.Chrome"/);
  for (const banned of ['NSAppleScript', 'osascript', 'profile-directory', 'CGEvent', 'AppleEvent']) assert.equal(native.includes(banned), false, banned);
});

interface EvalRow {
  id: string; ask: string; replay: boolean; pick?: string;
  setup?: { drive?: string[]; driveMime?: 'deck' | 'doc' | 'sheet'; gmail?: { id: string; threadId: string; from: string; subject: string }[]; calendar?: { id: string; summary: string; start: string; htmlLink: string }[]; mailBody?: string };
  expect: { open?: { tool: string; app?: string; target: string } | null; refusal?: string; firstTurn?: string; noBodyHandle?: boolean };
  followUp?: { ask: string; driveGet: string; pick: string; open: { tool: string; target: string } };
}
const EVALS = JSON.parse(fixture('open-evals.json')) as { account: string; rows: EvalRow[] };
const SHEET = { id: 'SyntheticSheet01', name: 'Harbour budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-01T08:00:00.000Z', owners, webViewLink: 'https://docs.google.com/spreadsheets/d/SyntheticSheet01/edit?usp=drivesdk' };
const FILES: Record<string, typeof DECK_NEW> = { DECK_NEW, DECK_OLD, DOC, PPTX, SHEET };

/** The handle whose minted line names `pick`, or `pick` itself when the script names a raw handle. */
function picked(text: string, pick: string | undefined): string | undefined {
  if (pick === undefined) return undefined;
  if (/^L\d+$/.test(pick)) return pick;
  return [...text.matchAll(/^open: (L\d+) = (.*)$/gm)].find(match => match[2]!.includes(pick))?.[1];
}

test('C-OPEN evals: every replayable row E1 to E9 passes its rule on the open argument', () => {
  const ids = EVALS.rows.map(row => row.id);
  assert.deepEqual(ids, ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9', 'E10']);
  for (const row of EVALS.rows.filter(entry => entry.replay)) {
    beginHandleSession(`eval-${row.id}`);
    noteGmailAccount(EVALS.account);
    try {
      let text = '';
      const setup = row.setup ?? {};
      if (setup.drive !== undefined) {
        const mime = setup.driveMime === undefined ? undefined : DRIVE_MIME_TYPES[setup.driveMime];
        text += shapeDriveSearch({ files: setup.drive.map(name => FILES[name]!).filter(file => mime === undefined || mime.includes(file.mimeType)) }).text;
      }
      if (setup.gmail !== undefined) text += shapeGmailList({ messages: setup.gmail.map(m => ({ id: m.id, threadId: m.threadId, headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] })) }).text;
      if (setup.calendar !== undefined) text += shapeGcalList({ events: setup.calendar.map(e => ({ id: e.id, summary: e.summary, start: { dateTime: e.start }, htmlLink: e.htmlLink })) }).text;
      if (setup.mailBody !== undefined) text += shapeGmailRead({ id: 'm-body', threadId: 't-body', headers: { Subject: 'Synthetic note' }, format: 'full', body: setup.mailBody, bodyCoverage: { complete: true } }).text;
      exposeHandles(text);
      if (row.expect.firstTurn === 'asks') {
        assert.ok(text.includes(DRIVE_CHOOSE_GUIDANCE), `${row.id}: several matches ask first`);
        assert.equal(/^open: /m.test(text), false, `${row.id}: nothing openable before the pick`);
        const again = shapeDriveFile({ ...FILES[row.followUp!.driveGet]!, trashed: false }).text;
        exposeHandles(again);
        const handle = picked(again, row.followUp!.pick);
        const resolved = openTarget('open_source', { handle: handle! }, row.followUp!.ask);
        assert.ok('target' in resolved, `${row.id}: ${JSON.stringify(resolved)}`);
        assert.equal(resolved.target.target, row.followUp!.open.target, row.id);
        continue;
      }
      const open = row.expect.open;
      if (open?.tool === 'open_home') {
        const resolved = openTarget('open_home', { app: open.app! }, row.ask);
        assert.ok('target' in resolved, row.id);
        assert.equal(resolved.target.target, open.target, row.id);
        continue;
      }
      const handle = picked(text, row.pick);
      const resolved = handle === undefined ? { code: 'not_found' as const } : openTarget('open_source', { handle }, row.ask);
      if (open === null || open === undefined) {
        assert.equal('target' in resolved, false, `${row.id}: nothing opens`);
        if (row.expect.refusal !== undefined && 'code' in resolved) assert.equal(resolved.code, row.expect.refusal, row.id);
      } else {
        assert.ok('target' in resolved, `${row.id}: ${JSON.stringify(resolved)}`);
        assert.equal(resolved.target.target, open.target, row.id);
      }
      if (row.expect.noBodyHandle === true) assert.equal(/^open: /m.test(text.replace(/^open: L\d+ = Gmail: .*$/gm, '')), false, `${row.id}: only the message itself is openable`);
    } finally { noteGmailAccount(undefined); endHandleSession(`eval-${row.id}`); }
  }
});

// C-OPENWEB8: the web surfaces open_web builds from the owner's words, and the domain it names back.
test('C-OPENWEB8: every web surface is built with URL and URLSearchParams, never by concatenation', () => {
  assert.deepEqual(webDestination('maps', 'Odemira'), { url: 'https://www.google.com/maps/search/?api=1&query=Odemira', domain: 'google.com' });
  assert.deepEqual(webDestination('maps', 'directions to Lisbon'), { url: 'https://www.google.com/maps/dir/?api=1&destination=Lisbon', domain: 'google.com' });
  assert.deepEqual(webDestination('maps', 'Odemira to Lisbon'), { url: 'https://www.google.com/maps/dir/?api=1&destination=Lisbon&origin=Odemira', domain: 'google.com' });
  // A character that would separate a path or a query is encoded by URLSearchParams, never read as one.
  assert.equal(webDestination('search', 'a&b=c')?.url, 'https://www.google.com/search?q=a%26b%3Dc');
  assert.deepEqual(webDestination('site', 'plantix.net'), { url: 'https://plantix.net/', domain: 'plantix.net' });
  // Review F1: the words he said are the target, so the spoken dot opens the root too.
  assert.deepEqual(webDestination('site', 'plantix dot net'), { url: 'https://plantix.net/', domain: 'plantix.net' });
  assert.deepEqual(webDestination('site', 'Plantix dot net.'), { url: 'https://plantix.net/', domain: 'plantix.net' });
  assert.equal(webDestination('site', 'acme seeds'), undefined, 'two spoken words are a name, not a domain');
  assert.equal(webDestination('site', 'plantix.net/?q=secret'), undefined, 'a path or query is not a spoken domain');
  assert.equal(webDestination('site', 'localhost'), undefined, 'one label is not a registrable domain');
  assert.equal(webDestination('site', 'plantix.net.evil.example'), undefined, 'a deeper label is not its own registrable domain');
  assert.equal(webDestination('maps', '  '), undefined);
});

test('C-OPENWEB8: a domain is read back the way she says it, and a root is https with nothing else', () => {
  assert.equal(registrableDomain('www.plantix.net'), 'plantix.net');
  assert.equal(registrableDomain('en.wikipedia.org'), 'wikipedia.org');
  assert.equal(registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.equal(spokenDomain('Plantix.NET'), 'plantix.net');
  assert.equal(spokenDomain('open plantix dot net'), undefined, 'a whole sentence is not a domain');
  assert.equal(spokenDomain('acme dot seeds dot com'), undefined, 'a deeper label is not its own registrable domain');
  assert.equal(spokenDomain('plantix dot net'), 'plantix.net', 'the spoken dot is the address dot');
  assert.equal(spokenDomain('plantix.net.'), 'plantix.net', 'a closing period is the sentence, not the address');
  assert.equal(spokenDomain('plantix.net/private'), undefined);
  assert.equal(spokenDomain('plantix.net:8443'), undefined);
  assert.equal(spokenDomain('owner@plantix.net'), undefined);
  assert.equal(siteRootUrl('plantix.net'), 'https://plantix.net/');
  assert.equal(siteRootUrl('plantix.net/private'), undefined);
});

test('C-OPENWEB8: the handle policy is unchanged, so no open: handle ever reaches a web surface', () => {
  for (const url of ['https://www.google.com/search?q=odemira', 'https://www.google.com/maps/search/?api=1&query=Odemira', 'https://plantix.net/']) {
    assert.equal(openDestination(url), undefined, `open_source refuses ${url}`);
  }
});

test('C-OPENWEB8: the site he named is the one whose label matches, aggregators and social pages dropped', () => {
  const sources = [
    { title: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Acme_Seeds' },
    { title: 'LinkedIn', url: 'https://www.linkedin.com/company/acme-seeds' },
    { title: 'Acme Seeds', url: 'https://www.acme-seeds.com/about' },
  ];
  assert.deepEqual(pickSiteDomain('Acme Seeds', sources), { domain: 'acme-seeds.com' });
  assert.deepEqual(pickSiteDomain('Acme Seeds', sources.slice(0, 2)), { candidates: [] });
  assert.deepEqual(pickSiteDomain('Acme Seeds', [...sources, { title: 'Acme Seeds UK', url: 'https://acme-seeds.co.uk/' }]),
    { candidates: ['acme-seeds.com', 'acme-seeds.co.uk'] });
  for (const blocked of ['wikipedia.org', 'linkedin.com', 'youtube.com', 'x.com', 'bloomberg.com', 'zoominfo.com']) {
    assert.ok(SITE_BLOCKLIST.includes(blocked), `${blocked} is never the site he means`);
  }
});
