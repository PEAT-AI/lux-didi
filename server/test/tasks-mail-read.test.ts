import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shapeGmailRead } from '../tools/live-shape.js';
import { connectorExecutor, projectTaskPayload } from '../tasks/connectors.js';
import type { ConnectorEvidence, ConnectorReader } from '../connectors/index.js';
import type { ConnectionPolicy } from '../tools/types.js';

// Synthetic fixtures only. No provider call, no owner account, no real name.
const SENDER = { Subject: 'Mooring plan', From: 'Dana <dana@example.invalid>', To: 'rob@example.invalid', Date: 'Mon, 5 Oct 2026 09:00:00 +0000' };

/** The shaped display text, exactly what the old seam received as `response.text`. */
function shapedRead(headers: Record<string, string>, body?: string): string {
  return shapeGmailRead({ id: 'synthetic-m1', threadId: 'synthetic-t1', format: 'full', headers, ...(body === undefined ? {} : { body }), bodyCoverage: { complete: true } }).text;
}
/** The decoded connector envelope for one message, the seam's real source for a mail read. */
function decodedRead(headers: Record<string, string>, body?: string): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ data: { id: 'synthetic-m1', threadId: 'synthetic-t1', format: 'full', headers, ...(body === undefined ? {} : { body }) } }) }] };
}

test('read_mail returns the body of a message whose sender has a display name and whose To header is present', () => {
  const result = projectTaskPayload('read_mail', shapedRead(SENDER, 'The mooring plan is ready.\nSecond line.'), { id: 'synthetic-m1' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /The mooring plan is ready\./, 'the mail body must survive the header block');
  assert.match(result.text, /Second line\./);
});

test('read_mail still returns the body of a message whose sender carries no display name', () => {
  const result = projectTaskPayload('read_mail', shapedRead({ Subject: 'Mooring plan', From: 'dana@example.invalid', Date: 'Mon, 5 Oct 2026 09:00:00 +0000' }, 'The mooring plan is ready.'), { id: 'synthetic-m1' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /The mooring plan is ready\./);
});

test('read_mail keeps the quoted reply chain below the new text', () => {
  const body = 'The mooring plan is ready.\n\nOn Mon, 5 Oct 2026 at 09:00, Dana <dana@example.invalid> wrote:\n> The harbour survey is booked.\n> Bring the tide tables.';
  const result = projectTaskPayload('read_mail', decodedRead(SENDER, body), { id: 'synthetic-m1' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /The mooring plan is ready\./);
  assert.match(result.text, /The harbour survey is booked\./, 'the quoted chain is part of the received text');
  assert.match(result.text, /Bring the tide tables\./);
});

test('read_mail strips MIME boilerplate, inline data and tracking links from the received text', () => {
  const body = 'Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\nThe mooring plan is ready.\n<img src="data:image/png;base64,AAAA">\nMore plan text.\nhttps://tracker.example/click?utm_source=x&x=1';
  const result = projectTaskPayload('read_mail', decodedRead(SENDER, body), { id: 'synthetic-m1' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /The mooring plan is ready\./, 'the message text survives the cleaning');
  assert.match(result.text, /More plan text\./);
  assert.equal(result.text.includes('Content-Type'), false, 'MIME boilerplate is removed');
  assert.equal(result.text.includes('data:image'), false, 'inline image data is removed');
  assert.equal(result.text.includes('utm_source'), false, 'tracking links are removed');
});

test('read_mail keeps a Gmail-style forwarded block at the bottom of the message', () => {
  const body = 'FYI\n\n---------- Forwarded message ---------\nFrom: Sam <sam@example.invalid>\nDate: Tue, 6 Oct 2026\nSubject: Tide tables\nTo: Dana <dana@example.invalid>\n\nThe tide tables are in the dock log.';
  const result = projectTaskPayload('read_mail', decodedRead(SENDER, body), { id: 'synthetic-m1' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /The tide tables are in the dock log\./, 'a forwarded block is received text');
});

test('read_mail keeps an Outlook-style From/Sent forward and never returns it empty', () => {
  const body = 'Passing this on.\n\nFrom: Sam Rivera <sam@example.invalid>\nSent: Tuesday, 6 October 2026 10:00\nTo: Dana <dana@example.invalid>\nSubject: Tide tables\n\nThe tide tables are in the dock log.';
  const result = projectTaskPayload('read_mail', decodedRead(SENDER, body), { id: 'synthetic-m1' });
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Passing this on\./);
  assert.match(result.text, /The tide tables are in the dock log\./, 'an Outlook From/Sent block is received text, not a cut marker');
});

test('read_mail reports a bodyless message as failed, never as a successful read', () => {
  const result = projectTaskPayload('read_mail', decodedRead(SENDER), { id: 'synthetic-m1' });
  assert.notEqual(result.status, 'ok');
  assert.equal(result.status, 'failed');
});

// --- Calendar -----------------------------------------------------------------------------

const policy: ConnectionPolicy = {
  schemaVersion: 1, ownerId: 'fixture', connectionId: 'fixture', generation: 1, enabled: true, connector: 'google',
  endpoint: { id: 'fixture', url: 'https://fixture.example.test/mcp', account: 'fixture', resource: 'fixture', credentialRef: null },
  toolNames: ['calendar_list_events'], schemaDigest: 'fixture',
  sourcePolicy: { id: 'fixture', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] }, route: { identity: 'fixture', allowedClasses: ['ordinary'] },
  bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
};

function events(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `synthetic-e${i}`, summary: `Synthetic event ${i}`,
    start: { dateTime: `2026-11-02T${String(i).padStart(2, '0')}:00:00Z` },
    end: { dateTime: `2026-11-02T${String(i).padStart(2, '0')}:30:00Z` },
  }));
}

function envelope(list: Record<string, unknown>[], nextPageToken?: string): unknown {
  return { content: [{ type: 'text', text: JSON.stringify({ data: { events: list, ...(nextPageToken ? { nextPageToken } : {}) } }) }] };
}

function fakeReader(list: Record<string, unknown>[], nextPageToken: string | undefined, seen: Record<string, unknown>[]): ConnectorReader {
  return {
    async call(_tool, args) {
      seen.push(args);
      return { state: 'completed', decodedResult: envelope(list, nextPageToken) } as unknown as ConnectorEvidence;
    },
  };
}

test('a calendar window asks for the day budget and returns every event, not the page default', async () => {
  const seen: Record<string, unknown>[] = [];
  const execute = connectorExecutor([{ connector: 'google', policy, reader: fakeReader(events(12), undefined, seen) }]);
  const result = await execute('calendar_events', { start: '2026-11-02T00:00:00.000Z', end: '2026-11-03T00:00:00.000Z' }, new AbortController().signal);
  assert.equal(seen[0]?.['maxResults'], 50, 'the whole day fits one bounded read');
  assert.equal(result.status, 'ok');
  for (let i = 0; i < 12; i++) assert.match(result.text, new RegExp(`Synthetic event ${i}\\b`));
  assert.equal(result.next_cursor, null);
});

test('a calendar window judges completeness on the source, so a full day is never reported partial', async () => {
  const seen: Record<string, unknown>[] = [];
  // The display text holds only the first page; the structured source holds the whole day.
  const execute = connectorExecutor([{ connector: 'google', policy, reader: fakeReader(events(12), undefined, seen), project: () => ({ response: { text: 'Synthetic event 0 only' }, dataClasses: [] }) }]);
  const result = await execute('calendar_events', { start: '2026-11-02T00:00:00.000Z', end: '2026-11-03T00:00:00.000Z' }, new AbortController().signal);
  assert.equal(result.status, 'ok');
  assert.match(result.text, /Synthetic event 11\b/);
});

test('a calendar window says partial only when the source really had more', async () => {
  const seen: Record<string, unknown>[] = [];
  const execute = connectorExecutor([{ connector: 'google', policy, reader: fakeReader(events(12), 'page-2', seen) }]);
  const result = await execute('calendar_events', { start: '2026-11-02T00:00:00.000Z', end: '2026-11-03T00:00:00.000Z' }, new AbortController().signal);
  assert.equal(result.status, 'partial');
  assert.equal(result.next_cursor, null);
});
