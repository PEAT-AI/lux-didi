// M2: the helper's task prompt opens with one clock line, computed when the task starts, in the session's
// zone. Before this, WORKER_INSTRUCTIONS carried no clock at all, so the helper answered "what time is it"
// from nothing and the owner heard the wrong part of the day (issue 907).
import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorker, type InferRequest } from '../tasks/worker.js';
import { taskInstructions } from '../tasks/instructions.js';

const REGISTRY = new Map();
const IDENTITY = { task_id: 'clock', task_revision: 1, connection_generation: 1 };

/** The instant of the reported call: 06:45:58 in Jakarta, which is 23:45:58 UTC the day before. */
const SAID = Date.parse('2026-11-05T23:45:58Z');

test('a helper task prompt opens with the owner clock at task start', async () => {
  let seen: InferRequest | undefined;
  await runWorker({
    registry: REGISTRY, identity: IDENTITY, input: 'synthetic task', signal: new AbortController().signal,
    timeZone: 'Asia/Jakarta', now: () => SAID,
    infer: async request => { seen = request; return { text: 'Nothing to do.', calls: [], no_action: true }; },
  });
  assert.ok(seen, 'the worker asked the model once');
  const [first] = seen.instructions.split('\n');
  assert.equal(first, 'Now: Fri, 2026-11-06, 06:45 Asia/Jakarta (UTC+07:00)');
  assert.equal(seen.instructions.split('Now:').length - 1, 1, 'exactly one clock line per prompt');
  assert.doesNotMatch(seen.instructions, /23:45/u, 'the UTC hour never reaches the helper');
});

test('the clock is read from the session zone, not from the process zone', () => {
  const instructions = taskInstructions({ timeZone: 'Europe/Berlin', now: () => SAID });
  assert.equal(instructions.split('\n')[0], 'Now: Fri, 2026-11-06, 00:45 Europe/Berlin (UTC+01:00)');
  assert.doesNotMatch(instructions, /Asia\/Jakarta|23:45/u);
});
