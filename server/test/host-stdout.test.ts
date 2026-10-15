// Regression for issue 233: the supervised host's stdout carries protocol frames only.
// Every structured diagnostic goes to host.log; the console passthrough goes to stderr.
// On the base revision these two tool round trips wrote their event JSON into the supervised
// stdout, which the native supervisor reads as invalidOutput and tears the service down.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { captureHostDiagnostics, HostLog } from '../host/log.js';
import { projectMattermostResult } from '../tools/mattermost.js';
import { runToolCalls } from '../tools/declarations.js';
import type { ConnectorEvidence } from '../connectors/index.js';
import type { McpPort } from '../adapters/mcp/port.js';
import type { JsonObject, ToolCallJournal, ToolDefinition, ToolResultGate } from '../adapters/model/types.js';

const webRoot = resolve(import.meta.dirname, '../../../web/dist');

/** A real diagnostic capture into a private host.log, plus a bounded process.stdout recorder. */
function capture(t: TestContext): { log: string; stdout: () => string } {
  const dir = mkdtempSync(join(tmpdir(), 'didi-host-stdout-'));
  const logPath = join(dir, 'logs', 'host.log');
  const stopDiagnostics = captureHostDiagnostics(new HostLog(dir));
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  t.after(() => {
    process.stdout.write = original;
    stopDiagnostics();
    rmSync(dir, { recursive: true, force: true });
  });
  return { log: logPath, stdout: () => chunks.join('') };
}

/** A read-only result whose retained bytes hash and length match, as the connector reader requires. */
function mattermostEvidence(text: string): ConnectorEvidence {
  const bytes = Buffer.from(text);
  return {
    state: 'completed',
    tool: 'mattermost_search',
    observedAt: Date.now(),
    source: { endpointId: 'mm', url: 'https://chat.example.invalid', schemaDigest: 'd'.repeat(64), toolName: 'mattermost_search', generation: 1, account: 'acct', resource: 'res' },
    coverage: { completeCorpus: false, basis: 'single-tool-result', remoteSideEffects: 'unverified' },
    projection: { text, omitted: false, originalCharacters: text.length, omittedCharacters: 0 },
    response: { state: 'available', handle: 'h', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.byteLength, expiresAt: Date.now() + 60_000, encoding: 'http-response-entity' },
    decodedResult: { result: { content: [{ type: 'text', text }] } },
  };
}

function portOver(bytes: Buffer): McpPort {
  return {
    discover: async () => { throw new Error('unused'); },
    visibleTools: () => [],
    call: async () => { throw new Error('unused'); },
    readSlice: request => {
      const slice = bytes.subarray(request.offset, request.offset + request.length);
      return { state: 'available', bytes: slice, byteLength: slice.byteLength, sha256: createHash('sha256').update(slice).digest('hex'), expiresAt: Date.now() + 60_000 };
    },
    whenSuspended: async () => { throw new Error('unused'); },
    close: async () => {},
  };
}

function errorTool(): ToolDefinition {
  return {
    name: 'get_insight', description: 'Read', effect: 'read', accountId: 'acct', resourceId: 'res',
    parameters: { type: 'object', properties: { ids: { type: 'array' } }, required: ['ids'] },
    validate: () => false, execute: async () => ({ status: 'failed' as const }),
  };
}
function errorContext(tool: ToolDefinition) {
  return {
    registry: [tool],
    host: { runId: 'run', actorId: 'actor', authorityEpoch: 'epoch', revision: 1, grants: [{ tool: tool.name, effect: 'read' as const, accountId: 'acct', resourceId: 'res' }] },
    control: { signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 },
    authority: { isCurrent: async () => true }, seenIds: new Set<string>(), step: 0, contentIndex: 0,
  };
}
const refuses = (): ToolCallJournal => ({ intent: () => 'fresh', refuse: () => ({ id: 'ref', sha256: 'a'.repeat(64) }), fail: () => ({ id: 'ref', sha256: 'a'.repeat(64) }) });

function hostLogLines(path: string): { event?: string }[] {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event?: string });
}

test('Live path: a mattermost_shape diagnostic reaches host.log and never stdout', async t => {
  const f = capture(t);
  const text = JSON.stringify({ order: ['p1'], posts: { p1: { id: 'p1', message: 'standup note', channel_id: 'c', user_id: 'u' } } });
  const projected = projectMattermostResult(portOver(Buffer.from(text)), mattermostEvidence(text));
  assert.equal(projected.ok, true, 'the connector projection must succeed');
  assert.equal(f.stdout(), '', 'no diagnostic byte may reach the supervised stdout');
  assert.ok(hostLogLines(f.log).some(line => line.event === 'mattermost_shape'), 'mattermost_shape must be in host.log');
});

test('Text chat path: a tool_arguments_rejected diagnostic reaches host.log and never stdout', async t => {
  const f = capture(t);
  const owner = { journal: refuses(), resultGate: {} as unknown as ToolResultGate };
  await runToolCalls(owner, [{ id: '1', name: 'get_insight', args: { ids: ['hunter2'] } as JsonObject }], errorContext(errorTool()) as never);
  assert.equal(f.stdout(), '', 'no diagnostic byte may reach the supervised stdout');
  assert.ok(hostLogLines(f.log).some(line => line.event === 'tool_arguments_rejected'), 'tool_arguments_rejected must be in host.log');
});

test('supervised host writes exactly one stdout frame and nothing else across its lifetime', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'didi-host-stdout-spawn-'));
  let child: ChildProcess | undefined;
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit').catch(() => {}); } rmSync(dir, { recursive: true, force: true }); });
  child = spawn(process.execPath, [resolve(import.meta.dirname, '../host/index.js'), '--supervised', '--data-dir', dir, '--web-root', webRoot, '--port', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += String(chunk); });
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const nonce = randomUUID();
  child.stdin!.write(`${JSON.stringify({ type: 'start', schemaVersion: 1, nonce })}\n`);
  const deadline = Date.now() + 10_000;
  while (!stdout.includes('\n') && child.exitCode === null && Date.now() < deadline) await once(child.stdout!, 'data');
  assert.ok(stdout.endsWith('\n'), `supervised host never emitted a complete frame: ${stderr}`);
  const frame = JSON.parse(stdout.trim());
  assert.equal(frame.type, 'ready'); assert.equal(frame.nonce, nonce); assert.equal(frame.pid, child.pid);
  child.stdin!.end();
  const [code] = await once(child, 'exit') as [number];
  child = undefined;
  assert.equal(code, 0, 'supervised host must shut down cleanly');
  assert.equal(stdout.split('\n').length, 2, 'stdout must hold exactly the one ready frame');
});

test('a structured console.log is captured to host.log and its passthrough never reaches stdout', async t => {
  const f = capture(t);
  console.log(JSON.stringify({ event: 'mattermost_shape', tool: 'mattermost_search', shape: 'posts_map', rawCharacters: 1, shapedCharacters: 1, itemCount: 1 }));
  assert.equal(f.stdout(), '', 'console passthrough must not reach stdout');
  assert.ok(hostLogLines(f.log).some(line => line.event === 'mattermost_shape'), 'host.log still receives the structured event');
});
