// The two log-backed views (call, doctor) and the list row, over logs in today's shape.
// Fixture: server/test/fixtures/timeline-call.json. Every value in it is invented.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildCallStory, listCalls, logHealth, renderCallList, renderCallStory, renderLogHealth, scanLogs,
  type LogInput, type LogStream, type TimelineReport, type TraceRead,
} from '../trace/timeline.js';

interface FixtureFile { file: string; stream: LogStream; text: string[] }
interface TimelineFixture { liveSessionId: string; otherSessionId: string; pid: number; files: FixtureFile[] }
const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/timeline-call.json', import.meta.url), 'utf8')) as TimelineFixture;
// The fixture keeps one array per file so a torn line is visible in the diff; the reader takes file text.
const scan = () => scanLogs(fixture.files.map((file): LogInput => ({ file: file.file, stream: file.stream, text: file.text.join('\n') })));

/** The store half of one call: one owner turn, one tool call of that turn, one answered response. */
function report(): TimelineReport {
  return {
    liveSessionId: fixture.liveSessionId,
    capturedAt: 1792486800000,
    callFailures: { count: 0, kinds: {} },
    contentAccess: { state: 'allowed', dataClass: 'ordinary', revision: 1 },
    gaps: [], nativeGaps: [], unattributedPlayback: [], unattributedCalls: [], unattributedResponses: [],
    turns: [{
      turn: {
        turnId: 'turn_1', turnIndex: 1, origin: 'owner', supersedesTurnId: null, openedAt: 1792486799800, monoMs: 100,
        closedAt: 1792486809500, closeReason: 'completed', firstAudibleAt: 1792486800900, playbackDrainedAt: null,
        outcome: 'answered', stallReason: null, attributionUncertain: false,
      },
      responses: [{
        responseKey: 'resp_1', providerResponseId: null, delegationId: null, turnId: 'turn_1', status: 'completed',
        createdAt: 1792486801200, terminalAt: 1792486809000, terminalReason: 'completed', continuationOfResponseKey: null,
      }],
      calls: [{
        callKey: 'call_1', responseKey: 'resp_1', turnId: 'turn_1', name: 'calendar', argsChars: 12,
        intentAt: 1792486802050, executedAt: null, outputPreparedAt: null, outputWrittenAt: null,
        outcome: 'completed', ms: 412, resultChars: 30, continuationAt: null, continuationOutcome: null,
      }],
      playback: [],
      utterances: [{ role: 'owner', at: 1792486800500, final: true, text: 'move my two oclock' }],
    }],
  };
}

test('scan counts every line and every torn line (#1026)', () => {
  const scanned = scan();
  assert.deepEqual(scanned.files.map(f => [f.file, f.lines, f.torn]), [
    ['logs/host.log.1', 1, 0], ['logs/host.log', 11, 1], ['logs/native-live.log', 4, 0], ['logs/audio.log', 3, 1],
  ]);
  assert.equal(scanned.torn, 2);
  assert.equal(scanned.lines.length, 19);
});

test('call view orders the four streams and marks what joined by window (#1026)', () => {
  const story = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId });
  // The pid guard: a foreign pid inside the window, and this pid outside it, are both absent.
  assert.equal(story.entries.some(e => e.text.includes('99000')), false);
  assert.equal(story.entries.some(e => e.text.includes('42000')), false);
  assert.deepEqual(story.entries.map(e => e.text), [
    'turn 1 opened origin=owner',
    'live_state state=listening from=speaking cause=silence',
    'audio_owned',
    'owner utterance at=1792486800500 final',
    'first model audio',
    'live_first_audio msSinceReady=812 msSinceOpen=1904',
    'response resp_1 status=completed',
    'live_interrupted reason=owner_spoke',
    'tool calendar ms=412',
    'tool calendar outcome=completed ms=412',
    'tool_output_sent outcome=sent tools=1 msSinceArrived=418',
    'live_dead_air deadAirMs=1744',
    'research_joined researchId=res_7f sources=3',
    'playback_underrun queuedMs=180',
    'playback_underrun queuedMs=90',
    'connector_failure connector=calendar reason=token_expired endpointId=calendar',
    'live_terminal state=closed code=voice_stop',
    'live_end state=closed',
  ]);
  assert.deepEqual(story.entries.map(e => e.joinedBy), [
    'store', 'session', 'session', 'store', 'store', 'session', 'store', 'session', 'window', 'store',
    'session', 'window', 'window', 'window', 'window', 'session', 'window', 'window',
  ]);
  assert.equal(story.joinedByWindow, 7);
  assert.equal(story.skipped, 3); // live_idle_arm, orb_occlusion, playback_level
  assert.equal(story.torn, 2);
});

test('call view carries owner content only when asked (#1026)', () => {
  const quiet = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId });
  assert.equal(quiet.entries.some(e => e.text.includes('two oclock')), false);
  const loud = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId, content: true });
  assert.ok(loud.content);
  assert.ok(loud.entries.some(e => e.text === 'owner utterance at=1792486800500 final text="move my two oclock"'));
});

/** The store as `buildTimeline` leaves it: the research text is the one content table the view reads. */
const researchRead: TraceRead = {
  all: sql => sql.includes('trace_research_text')
    ? [{ at: 1792486804300, kind: 'question', research_id: 'res_7f', text: 'calendar next week' }]
    : [],
  get: () => undefined,
};

test('call --content prints the researched question, and only then (#1026)', () => {
  const quiet = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId, read: researchRead });
  assert.equal(quiet.entries.some(e => e.text.includes('calendar next week')), false);
  const loud = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId, content: true, read: researchRead });
  assert.ok(loud.entries.some(e => e.text === 'research question at=1792486804300 text="calendar next week"'));
  // The store's own gate decides, not the flag: a denied read stays denied even with --content.
  const denied = buildCallStory(scan(), { ...report(), contentAccess: { state: 'denied', reason: 'class_denied' } },
    { liveSessionId: fixture.liveSessionId, content: true, read: researchRead });
  assert.equal(denied.entries.some(e => e.text.includes('calendar next week')), false);
});

test('call view prefers callId when the envelope is there (#1026)', () => {
  const scanned = scanLogs([{
    file: 'logs/host.log', stream: 'host',
    text: [
      '{"timestamp":"2026-10-20T09:00:02.500Z","monoMs":2512,"pid":5010,"seq":42,"event":"live_tool_turn","callId":"call_9","liveSessionId":"sess-1","toolLatencyMs":[{"tool":"notes","ms":77}]}',
      '{"timestamp":"2026-10-20T09:00:03.000Z","monoMs":3012,"pid":5010,"seq":43,"event":"live_first_audio","callId":"call_9","liveSessionId":"sess-1"}',
      '{"timestamp":"2026-10-20T09:00:04.000Z","monoMs":4012,"pid":5010,"seq":44,"event":"live_first_audio","callId":"call_other","liveSessionId":"sess-1"}',
    ].join('\n'),
  }]);
  const story = buildCallStory(scanned, undefined, { callId: 'call_9' });
  assert.deepEqual(story.entries.map(e => [e.text, e.joinedBy]), [
    ['tool notes ms=77', 'call'],
    ['live_first_audio', 'call'],
  ]);
  assert.equal(story.callId, 'call_9');
});

test('doctor reports files, torn lines, days, top events and unattributed lines (#1026)', () => {
  const health = logHealth(scan());
  assert.equal(health.files.length, 4);
  assert.equal(health.lines, 19);
  assert.equal(health.torn, 2);
  assert.ok(health.bytes > 1000);
  assert.equal(health.oldestDay, '2026-10-19');
  assert.equal(health.newestDay, '2026-10-20');
  assert.deepEqual(health.topEvents.slice(0, 3).map(e => [e.event, e.lines]), [
    ['live_dead_air', 3], ['live_state', 2], ['playback_underrun', 2],
  ]);
  assert.equal(health.unattributed.lines, 10);
  assert.equal(health.unattributed.streams.host, 7);
  assert.equal(health.unattributed.streams.native, 2);
  assert.equal(health.unattributed.streams.audio, 1);
  const [loosest] = health.unattributed.topEvents;
  assert.ok(loosest);
  assert.equal(loosest.event, 'live_dead_air');
});

test('list view shows start, duration, tools, max silence and terminal (#1026)', () => {
  const rows = listCalls(scan());
  assert.equal(rows.length, 2);
  const [newest, older] = rows;
  assert.ok(newest && older);
  assert.deepEqual(newest, {
    liveSessionId: fixture.liveSessionId, start: 1792486800000, durationMs: 10400, tools: 1,
    maxSilenceMs: 1744, terminal: 'closed/voice_stop', lines: 16,
  });
  assert.equal(older.liveSessionId, fixture.otherSessionId);
  assert.equal(older.durationMs, 0);
  assert.equal(older.terminal, null);
});

test('the three renders are metadata only and greppable (#1026)', () => {
  const story = buildCallStory(scan(), report(), { liveSessionId: fixture.liveSessionId });
  const text = renderCallStory(story);
  assert.match(text, /^call 3f2c8a10-0000-4a1a-9d1e-0000000000a1 /);
  assert.match(text, /joined-by-window=7/);
  assert.match(text, /\n\+\d+ms connector connector_failure connector=calendar reason=token_expired endpointId=calendar/);
  assert.equal(text.includes('two oclock'), false);
  const health = renderLogHealth(logHealth(scan()));
  assert.match(health, /torn=2/);
  assert.match(health, /logs\/audio\.log audio 3 lines 1 torn/);
  assert.match(renderCallList(listCalls(scan())), /closed\/voice_stop/);
});
