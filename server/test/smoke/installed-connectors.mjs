#!/usr/bin/env node
// C-CONNECT9 (W2-R1): one assertion, two sources, so an install cannot pass with a dead connector.
//
//   node server/test/smoke/installed-connectors.mjs --from-installed <data-dir>
//       The installed host's own closed surfaces only: provider-config/mcp.json for the enabled entry ids
//       and logs/host.log for the connector receipts written after the newest host_started. It reads no
//       credential file, no owner profile and no store, and it writes nothing.
//
//   node server/test/smoke/installed-connectors.mjs --synthetic connected|outside-envelope
//       A synthetic catalog with the shipped stdio fixtures in a temporary directory: no network, no
//       installation, no owner store. `connected` proves an 8-entry catalog where one entry widens inside
//       the reviewed envelope and still connects; `outside-envelope` proves the same check fails, named,
//       for a child whose published reads are all outside the envelope (connected with no readable read).
//
// Exit: 0 every enabled entry is connected with reads, 1 otherwise, 2 bad usage.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '..', 'fixtures');
const dist = join(here, '..', '..', 'dist');
const PREFIX = 'CHECK-INSTALLED-CONNECTORS';
const PEOPLE_CHILD = join(fixtures, 'stdio-mattermost-people-child.mjs');
const ECHO_CHILD = join(fixtures, 'stdio-mcp-child.mjs');

const okId = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);

/** One row per enabled entry, from whatever closed source this run has. */
function assertConnected(entries, states) {
  let failed = 0;
  for (const id of entries) {
    const state = states.get(id);
    const connected = state?.state === 'connected' && Number(state.tools) > 0;
    const detail = `state=${state?.state ?? 'absent'} tools=${Number.isSafeInteger(state?.tools) ? state.tools : 0}${state?.code === undefined ? '' : ` code=${state.code}`}${state?.exception === undefined ? '' : ` exception=${state.exception.class}:${state.exception.code}`}`;
    if (connected) console.log(`${PREFIX} ${id} ${detail}`);
    else { console.log(`${PREFIX} FAIL ${id} ${detail}`); failed += 1; }
  }
  console.log(`${PREFIX} ${failed === 0 ? 'PASS' : 'FAIL'} enabled=${entries.length} connected=${entries.length - failed}`);
  return failed === 0;
}

/** The closed status of each endpoint of one running host. */
function statesOf(runtime) {
  const states = new Map();
  for (const report of runtime.status().endpoints) {
    const code = typeof report.configurationError === 'string' ? report.configurationError : report.error;
    states.set(report.id, { state: report.state, tools: report.tools, ...(code === undefined ? {} : { code }), ...(report.exception === undefined ? {} : { exception: report.exception }) });
  }
  return states;
}

/** The enabled catalog entries, from the installed config's own ids and enabled flags. */
function installedEntries(configFile) {
  let bytes;
  try { bytes = readFileSync(configFile, 'utf8'); } catch { return { entries: [], error: null }; }
  let parsed;
  try { parsed = JSON.parse(bytes); } catch { return { entries: [], error: 'config_unreadable' }; }
  if (!Array.isArray(parsed?.endpoints)) return { entries: [], error: 'config_unreadable' };
  return { entries: parsed.endpoints.filter(entry => entry && typeof entry === 'object' && entry.enabled !== false && okId(entry.id)).map(entry => entry.id), error: null };
}

/** The last closed connector receipt per endpoint after the newest host_started line. */
function loggedStates(logFile) {
  const states = new Map();
  let lines;
  try { lines = readFileSync(logFile, 'utf8').split('\n'); } catch { return states; }
  let from = 0;
  lines.forEach((line, index) => { if (line.includes('"host_started"')) from = index; });
  for (const line of lines.slice(from)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!okId(event?.endpointId)) continue;
    if (event.event === 'connector_connected') states.set(event.endpointId, { state: 'connected', tools: Number.isSafeInteger(event.tools) ? event.tools : 0 });
    else if (event.event === 'connector_failure') states.set(event.endpointId, { state: 'error', tools: 0, code: String(event.reason ?? 'connector_failure') });
    else if (event.event === 'connector_approval_refused') states.set(event.endpointId, { state: 'error', tools: 0, code: String(event.reason ?? 'owner-approval-required') });
  }
  return states;
}

async function fromInstalled(dataDir) {
  const { entries, error } = installedEntries(join(dataDir, 'provider-config', 'mcp.json'));
  if (error !== null) { console.log(`${PREFIX} FAIL ${error} dir=${dataDir}`); return false; }
  return assertConnected(entries, loggedStates(join(dataDir, 'logs', 'host.log')));
}

function endpointOf(id, child, mode) {
  return {
    id, transport: 'stdio', command: process.execPath, args: mode === null ? [child] : [child, mode],
    env: { HOME: '/home/fixture', PATH: process.env.PATH ?? '/usr/bin', LOGNAME: '', SHELL: '', TERM: '', USER: '' },
    connector: 'mattermost', account: 'mattermost', resource: 'mattermost', credentialRef: null,
    enabled: true, allowEgress: true, unknownClass: 'private',
  };
}

async function synthetic(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'didi-installed-connectors-'));
  const configDir = join(dir, 'provider-config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const { composeMcpRuntime } = await import(pathToFileURL(join(dist, 'host', 'mcp.js')).href);
  const { Store } = await import(pathToFileURL(join(dist, 'runtime', 'store.js')).href);
  const { toolsMigrations } = await import(pathToFileURL(join(dist, 'tools', 'schema.js')).href);
  const ids = ['mattermost', 'mattermost-people', 'mattermost-attention', 'mattermost-chat', 'mattermost-archive', 'mattermost-standup', 'mattermost-ops', 'mattermost-support'];
  if (scenario === 'outside-envelope') ids[ids.length - 1] = 'mattermost-outside';
  const endpointsFor = wideningMode => [
    ...ids.map(id => endpointOf(id, id === 'mattermost-outside' ? ECHO_CHILD : PEOPLE_CHILD, id === 'mattermost-outside' ? null : 'people')),
    // A disabled catalog entry is retired, not an install failure: it is never asserted.
    { ...endpointOf('mattermost-retired', PEOPLE_CHILD, 'people'), enabled: false },
  ].map(endpoint => (endpoint.id === 'mattermost-people' ? { ...endpoint, args: [PEOPLE_CHILD, wideningMode] } : endpoint));
  const write = wideningMode => writeFileSync(join(configDir, 'mcp.json'), JSON.stringify({
    // No ownerIdentity: the synthetic children answer no real account, so the catalog states none and the
    // host does not probe one (the publication suite reads its synthetic children the same way).
    schemaVersion: 1, grantMode: 'owner-trusted-reads', endpoints: endpointsFor(wideningMode),
  }), { mode: 0o600 });
  const lifecycle = [];
  let store = new Store(join(dir, 'data'), toolsMigrations);
  const start = async () => {
    const runtime = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, lifecycleLog: event => { lifecycle.push(event); } });
    await runtime.start();
    return runtime;
  };
  try {
    // The installed release first ran the older child, whose reads the row records.
    write('legacy');
    const older = await start();
    const olderStates = statesOf(older);
    await older.close();
    store.close();
    store = new Store(join(dir, 'data'), toolsMigrations);
    // The newer release ships the same connector with the person reads: a widening inside the envelope.
    lifecycle.length = 0;
    write('people');
    const wider = await start();
    try {
      for (const event of lifecycle) {
        if (event.event === 'connector_envelope_widened') console.log(`${PREFIX} RECEIPT connector_envelope_widened endpoint=${event.endpointId} added=${[...event.addedToolNames].sort().join(',')}`);
      }
      const states = statesOf(wider);
      // The older run must have connected too, or the scenario proves nothing about a widening.
      if (olderStates.get('mattermost-people')?.state !== 'connected') console.log(`${PREFIX} FAIL setup older_people=${olderStates.get('mattermost-people')?.state ?? 'absent'}`);
      const entries = endpointsFor('people').filter(endpoint => endpoint.enabled !== false).map(endpoint => endpoint.id);
      return assertConnected(entries, states);
    } finally { await wider.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}

const argv = process.argv.slice(2);
const installedAt = argv.indexOf('--from-installed');
const syntheticAt = argv.indexOf('--synthetic');
let passed;
if (installedAt === 0 && argv[1] !== undefined) passed = await fromInstalled(argv[1]);
else if (syntheticAt === 0 && (argv[1] === 'connected' || argv[1] === 'outside-envelope')) passed = await synthetic(argv[1]);
else { console.log(`${PREFIX} FAIL usage`); process.exit(2); }
// A live stdio child is never left behind: every runtime above was closed before this line.
process.exit(passed ? 0 : 1);
