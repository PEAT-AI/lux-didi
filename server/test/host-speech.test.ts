import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { fakeReady } from './openai-live-voice-fixture.js';
import { attachHostLogSink } from '../tools/host-events.js';
import { commentaryPart } from './commentary-test.js';
import { safeEvent } from '../host/log.js';

// Reject host notes accidentally becoming typed owner turns. These structural checks
// complement the adapter wire tests below; they do not simulate a whole alarm call.
const source = readFileSync(new URL('../../live/index.ts', import.meta.url), 'utf8');
for (const [name, start, end] of [
  ['alarm opening', '  #sendHostSpeech(', '  #ringingAlarms('],
  ['mute offer', 'handle.mutedOfferTimer = this.#schedule(', 'handle.mutedOfferTimer.unref'],
  ['continuation', 'const ask = handle.session.', 'this.#scheduleDebt(handle, DEAD_AIR_CONTINUATION_MS'],
] as const) {
  test(`${name} uses session commentary rather than typed owner input`, () => {
    const offset = source.indexOf(start);
    const block = source.slice(offset, source.indexOf(end, offset + start.length));
    assert.match(block, /sendSessionCommentary/);
    assert.doesNotMatch(block, /sendText/);
  });
}

test('host commentary produces one null-delegation command and no response.create', async t => {
  const { socket, session } = await fakeReady(t);
  const before = socket.sent.length;
  assert.ok(session.sendSessionCommentary!({ text: 'Synthetic host instruction' }));
  const commands = socket.sent.slice(before).map(frame => JSON.parse(frame));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'session.commentary.append');
  assert.equal(commands[0].delegation_id, null);
});

test('typed owner input retains its current response commands, a known provider compatibility gap', async t => {
  const { socket, session } = await fakeReady(t);
  const before = socket.sent.length;
  session.sendText({ text: 'Synthetic typed input' });
  assert.deepEqual(socket.sent.slice(before).map(frame => JSON.parse(frame).type), ['response.item.create', 'response.create']);
});

test('provider rejection identifies the rejected command without its content', async t => {
  const { socket, session } = await fakeReady(t);
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { records.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const id = session.sendSessionCommentary!({ text: 'Synthetic private content' });
  socket.deliver({ type: 'error', error: { type: 'invalid_request_error', code: 'invalid_request_error', param: 'type', client_event_id: id } });
  const event = records.find(record => record.event === 'live_provider_error');
  assert.ok(event);
  assert.equal(event.clientEventId, id);
  assert.equal(event.commandType, 'session.commentary.append');
  assert.equal(safeEvent(event)?.commandType, 'session.commentary.append');
  assert.doesNotMatch(JSON.stringify(event), /Synthetic private content/);
});

// Exercise the host against the actual adapter, not a fake voice port: provider
// readiness, silent frames and the first audible frame are distinct transitions.
async function openHost(t: TestContext) {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../runtime/store.js');
  const { domainMigrations } = await import('../domain/schema.js');
  const { chatMigrations } = await import('../chat/index.js');
  const { toolsMigrations } = await import('../tools/schema.js');
  const { createLiveSessionOwner, liveMigrations, validateLiveProfile } = await import('../live/index.js');
  const { syntheticTaskFactory } = await import('./synthetic-task.js');
  const { OpenAiLiveVoiceAdapter } = await import('../adapters/live-voice/index.js');
  const { FakeSocket, FakeClock, options, pcm16 } = await import('./openai-live-voice-fixture.js');
  const clock = new FakeClock();
  const dir = mkdtempSync(join(tmpdir(), 'didi-host-speech-'));
  const store = new Store(dir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  const socket = new FakeSocket();
  const voice = new OpenAiLiveVoiceAdapter(options({ clock, limits: { handshakeMs: 1000, idleMs: 600000, sessionMs: 1200000, closeMs: 50 }, socketFactory: () => {
    queueMicrotask(() => { socket.readyState = 1; socket.emit('open'); });
    return socket as unknown as import('ws').default;
  } }));
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { records.push(raw as Record<string, unknown>); } });
  const profile = validateLiveProfile({ provider: 'openai', liveModelId: 'gpt-live-1', voice: 'cedar', keyReference: 'synthetic-reference',
    audio: { inputRate: 8000, outputRate: 24000 }, route: { enabled: true, provider: 'openai', modelId: 'gpt-live-1', dataClasses: ['ordinary'] },
    prompt: { text: 'Synthetic alarm persona', dataClass: 'ordinary' }, limits: { handshakeMs: 1000, idleMs: 600000, sessionMs: 1200000, closeMs: 50 } });
  const owner = createLiveSessionOwner({ store, voice, profile, timeZone: 'UTC', createTaskRuntime: syntheticTaskFactory(store),
    now: () => clock.now(), schedule: (fire, ms) => { const timer = clock.setTimer(ms, fire); return { unref() {}, cancel: () => clock.clearTimer(timer) }; } });
  const now = clock.now();
  store.transaction(tx => tx.run("INSERT INTO alarms(id,fire_at_utc,tz,label,state,created_journal_id,ring_started_at_utc,ring_deadline_utc) VALUES(?,?,'UTC','','ringing','synthetic',?,?)", ['synthetic-alarm', now, now, now + 60000]));
  const context = { clientId: 'synthetic', auditId: 'synthetic-audit', authorityEpoch: store.authorityEpoch };
  const created = owner.create({ idempotencyKey: 'synthetic-alarm-call', inputClass: 'ordinary', alarm: { ownerDisplayName: 'Synthetic owner', scheduledTime: '08:00', alarmId: 'synthetic-alarm', ringDeadlineUtc: now + 60000 } }, context);
  const attachment = owner.attach({ liveSessionId: created.liveSessionId }, context);
  const consumed = (async () => { for await (const _chunk of attachment.output) { /* Native playback consumes the host event stream. */ } })();
  t.after(async () => { attachment.close(); await attachment.done; await consumed; detach(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setImmediate(resolve)); };
  const commands = () => socket.sent.map(frame => JSON.parse(frame) as Record<string, unknown>);
  const events = (name: string) => records.filter(record => record.event === name);
  return { socket, attachment, flush, commands, events, clock, pcm16 };
}

test('alarm opening waits for session.started and announces only on its first audible output', async t => {
  const { socket, attachment, flush, commands, events, pcm16, clock } = await openHost(t);
  await flush();
  assert.equal(commands().filter(command => command.type === 'session.commentary.append').length, 0);
  assert.equal(events('alarm_prompt_installed').length, 1);
  assert.equal(events('alarm_ready').length, 0);
  assert.equal(events('alarm_announced').length, 0);
  socket.deliver({ type: 'session.started', session: { id: 'synthetic-session' } });
  assert.equal((await attachment.ready).terminal, null); await flush();
  const opening = commands().filter(command => command.type === 'session.commentary.append');
  assert.ok(opening.length > 1, 'a full alarm instruction exceeds one 450-character item');
  const parts = opening.map(command => {
    assert.equal(command.delegation_id, null);
    assert.ok(String(command.content).length <= 450);
    return commentaryPart(String(command.content));
  });
  assert.deepEqual(parts.map(part => part.part), parts.map((_, i) => `${i + 1}/${parts.length}`));
  assert.ok(parts.every(part => part.id === parts[0]!.id));
  assert.equal(parts.at(-1)!.final, true);
  assert.match(String(parts[0]!.cause), /alarm is due now/i);
  const content = parts.map(part => part.content ?? '').join('');
  assert.ok(content.length > 450);
  assert.match(content, /Synthetic owner/);
  assert.equal(commands().filter(command => command.type === 'response.create').length, 0);
  assert.equal(events('alarm_ready').length, 1);
  assert.equal(events('alarm_announced').length, 0);
  socket.deliver({ type: 'session.output_audio.delta', delta: Buffer.alloc(4800).toString('base64') });
  await flush();
  assert.equal(events('alarm_announced').length, 0);
  socket.deliver({ type: 'session.output_audio.delta', delta: Buffer.from(pcm16(2400)).toString('base64') });
  clock.advance(1000); // Release the adapter's standing playback cushion before observing host playback.
  await flush();
  assert.equal(events('alarm_announced').length, 1);
  socket.deliver({ type: 'session.output_audio.delta', delta: Buffer.from(pcm16(2400)).toString('base64') });
  clock.advance(1000); // Release the adapter's standing playback cushion before observing host playback.
  await flush();
  assert.equal(events('alarm_announced').length, 1);
});


test('a held muted answer requests exactly one commentary offer, not a typed turn', async t => {
  const { socket, attachment, flush, commands, clock, pcm16 } = await openHost(t);
  await flush();
  socket.deliver({ type: 'session.started', session: { id: 'synthetic-session' } });
  assert.equal((await attachment.ready).terminal, null); await flush();
  attachment.setInputMuted(true);
  socket.deliver({ type: 'session.output_audio.delta', delta: Buffer.from(pcm16(2400)).toString('base64') });
  clock.advance(1000); // Release the adapter's standing playback cushion before observing host playback.
  await flush();
  attachment.setInputMuted(false);
  const before = commands().length;
  clock.advance(2000); await flush();
  const offer = commands().slice(before);
  assert.equal(offer.length, 1);
  assert.equal(offer[0]!.type, 'session.commentary.append');
  assert.equal(offer[0]!.delegation_id, null);
  clock.advance(2000); await flush();
  assert.equal(commands().length, before + 1);
});

for (const event of ['alarm_prompt_installed', 'alarm_ready'] as const) {
  test(`${event} admits only closed alarm metadata`, () => {
    assert.deepEqual(safeEvent({ event, alarmId: 'synthetic-alarm', mode: 'new_session' }), { event, alarmId: 'synthetic-alarm', mode: 'new_session' });
    assert.equal(safeEvent({ event, alarmId: 'synthetic-alarm', mode: 'new_session', content: 'Synthetic private text' }), undefined);
  });
}

test('typed command rejections distinguish both response writes despite their shared prefix', async t => {
  const { socket, session } = await fakeReady(t);
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { records.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const before = socket.sent.length;
  session.sendText({ text: 'Synthetic typed input' });
  const commands = socket.sent.slice(before).map(frame => JSON.parse(frame));
  for (const command of commands) socket.deliver({ type: 'error', error: { type: 'invalid_request_error', param: 'type', client_event_id: command.event_id } });
  const errors = records.filter(record => record.event === 'live_provider_error');
  assert.deepEqual(errors.map(error => error.commandType), ['response.item.create', 'response.create']);
  assert.deepEqual(errors.map(error => error.eventIdPrefix), ['cont', 'cont']);
  for (const error of errors) assert.deepEqual(safeEvent(error), error);
});

test('recent command attribution is bounded and unknown ids preserve the rejection metadata', async t => {
  const { socket, session } = await fakeReady(t);
  const records: Record<string, unknown>[] = [];
  const detach = attachHostLogSink({ event: raw => { records.push(raw as Record<string, unknown>); } });
  t.after(detach);
  const first = session.sendSessionCommentary!({ text: 'Synthetic oldest note' });
  let last: string | undefined;
  for (let i = 0; i < 128; i++) last = session.sendSessionCommentary!({ text: 'Synthetic recent note' });
  for (const id of [first, last, 'unknown_id']) socket.deliver({ type: 'error', error: { type: 'invalid_request_error', param: 'type', client_event_id: id } });
  const errors = records.filter(record => record.event === 'live_provider_error');
  assert.equal(errors.length, 3);
  assert.equal(errors[0]!.commandType, undefined);
  assert.equal(errors[1]!.commandType, 'session.commentary.append');
  assert.equal(errors[2]!.clientEventId, 'unknown_id');
  assert.equal(errors[2]!.commandType, undefined);
});
