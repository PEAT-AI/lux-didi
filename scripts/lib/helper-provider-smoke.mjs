#!/usr/bin/env node
// One real helper request through the packaged model port, so a schema the provider refuses can never
// ship. The FULL declared set of this build is sent with the real worker role and the real provider
// key: the static declarations plus the company tools of every configured endpoint, built from the
// declarations the host persisted at its last live discovery (W9) and, only when it kept none, from the
// committed capture with its WARN line. Nothing here resolves a sign-in material, performs an OAuth
// refresh, or connects a connector; connector liveness is scripts/check-installed-connectors.sh's job.
//
// Usage: node scripts/lib/helper-provider-smoke.mjs --data-dir DIR --module-dir DIR [--capture FILE]
//
//   --capture FILE  the fallback catalogue of company declarations, used only when the store keeps no
//                   record: the run then prints its WARN line.
//
//   exit 0  PASS: the provider answered `completed`, named a registered tool, and the observed registry
//           equals the expected one (static declarations plus every cached company definition)
//   exit 1  the harness could not run (unreadable modules or configuration)
//   exit 2  FAIL, never a PASS: a configured endpoint has no cached discovery
//           (reason=discovery_missing, one line per endpoint), the registry is smaller than the
//           configuration requires (reason=company_bindings_unavailable), the provider rejected the
//           request, or the response named no tool
//   exit 3  SKIP: nothing to prove here (no configured provider, or a non-OpenAI provider)
//
// The owner's configuration is read where it lies and never copied or written. Only closed states,
// codes, counts and timings are printed: never the key, never owner content.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CAP_OUTPUT_TOKENS = 256;
const BODY_LIMIT = 2048;
const REQUEST_TIMEOUT_MS = 60000;
const INSTALLED_SETTINGS = 'Library/Application Support/ai.peat.lux-didi-operator/settings.json';
// W9: the host keeps the declarations it published at its last live discovery, one row per configured
// company endpoint in <dataDir>/state.sqlite. Every run names its source: the store with the discovery
// time, else the committed capture with the WARN line that claims no live-discovery parity.
const CAPTURE = fileURLToPath(new URL('../../server/test/fixtures/mongoose-tools-list-literal.json', import.meta.url));


function parseArgs(argv) {
  const options = { dataDir: '', moduleDir: '', capture: CAPTURE };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--data-dir') options.dataDir = argv[++index] ?? '';
    else if (flag === '--module-dir') options.moduleDir = argv[++index] ?? '';
    else if (flag === '--capture') options.capture = argv[++index] ?? '';
    else throw new Error(`helper-provider-smoke: unknown argument ${flag}`);
  }
  if (!options.dataDir) throw new Error('helper-provider-smoke: --data-dir is required');
  if (!options.moduleDir) throw new Error('helper-provider-smoke: --module-dir is required');
  return options;
}

/** The capture's own provenance date, so the run says how old the declarations are. */
export function captureStamp(capturePath) {
  try {
    const provenance = JSON.parse(readFileSync(capturePath, 'utf8'))?.provenance;
    const match = /(\d{4}-\d{2}-\d{2})/.exec(String(provenance ?? ''));
    return { path: capturePath, captured: match ? match[1] : 'unknown' };
  } catch {
    return { path: capturePath, captured: 'unknown' };
  }
}

/**
 * The persisted discovery record, keyed by the endpoint id the host recorded it under. Declarations
 * arrived from the host's `runtime/store` accessor, one row per endpoint: `{ endpointId, resource,
 * discoveredAt, schemaDigest, declarations }`, where `declarations` is a JSON array of `{ name,
 * description, parameters }`. The resource name is never the key: two endpoints can share one resource.
 */
export function storeCatalogue(rows) {
  const catalogues = {};
  let discoveredAt = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const endpointId = String(row?.endpointId ?? '');
    if (!endpointId) continue;
    let declarations;
    try { declarations = JSON.parse(String(row?.declarations ?? '[]')); } catch { continue; }
    if (!Array.isArray(declarations) || !declarations.length) continue;
    const tools = declarations
      .filter(entry => entry && typeof entry.name === 'string' && entry.name !== '')
      .map(entry => ({ name: entry.name, description: entry.description, inputSchema: entry.parameters ?? {} }));
    if (!tools.length) continue;
    catalogues[endpointId] = tools;
    discoveredAt = Math.max(discoveredAt, Number(row?.discoveredAt ?? 0));
  }
  return { catalogues, discoveredAt };
}

/**
 * Where the company declarations come from: the host's own record when it kept one for these configured
 * endpoints, else the committed capture, whose line is a WARN because it claims no live-discovery parity.
 * Selection is by configured endpoint id, never by resource, so a removed endpoint's row cannot stand in
 * for a replacement that has discovered nothing, and rows for unconfigured endpoints are dropped. The
 * two sources are never mixed, so a configured endpoint missing from the record fails closed.
 */
export function declarationSource({ record, endpoints, capture, stamp }) {
  const stored = record?.catalogues ?? {};
  const fromStore = {};
  for (const endpoint of endpoints ?? []) {
    const tools = stored[endpoint.id];
    if (Array.isArray(tools) && tools.length) fromStore[endpoint.id] = tools;
  }
  const matched = Object.keys(fromStore).length;
  if (record && record.discoveredAt && matched) {
    const discovered = new Date(record.discoveredAt).toISOString();
    return { kind: 'store', catalogues: fromStore, line: `HELPER-PROVIDER source=store discovered_at=${discovered} endpoints=${matched}` };
  }
  const fromCapture = {};
  for (const endpoint of endpoints ?? []) {
    if (Array.isArray(capture?.[endpoint.name])) fromCapture[endpoint.id] = capture[endpoint.name];
  }
  return {
    kind: 'capture',
    catalogues: fromCapture,
    line: `HELPER-PROVIDER WARN source=capture file=${stamp?.path || 'absent'} captured=${stamp?.captured ?? 'unknown'} live-parity=not-claimed`,
  };
}

/** The operator-selected config dir the installed app uses, else a provider-config inside the data dir. */
function configuredDir(dataDir) {
  const settings = join(homedir(), INSTALLED_SETTINGS);
  const local = join(resolve(dataDir), 'provider-config');
  if (existsSync(local)) return local;
  if (!existsSync(settings)) return '';
  const selected = JSON.parse(readFileSync(settings, 'utf8')).configDir;
  return typeof selected === 'string' && existsSync(selected) ? selected : '';
}

/**
 * The company endpoints this configuration declares, each with the endpoint id the host records its
 * discovery under: the record is selected by that id, never by the resource name alone, because two
 * endpoints can share one resource and a replacement endpoint has discovered nothing yet. Read-only: the
 * catalog is the app's own, and nothing here writes to it.
 */
export function configuredCompanyEndpoints(configDir) {
  const file = join(configDir, 'mcp.json');
  if (!existsSync(file)) return [];
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const endpoints = Array.isArray(doc?.endpoints) ? doc.endpoints : [];
  return endpoints
    .filter(entry => entry && entry.connector === 'mongoose' && entry.enabled !== false)
    .map(entry => {
      const name = String(entry.resource ?? '').replace(/^mongoose:/, '') || 'unknown';
      return { name, id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `unconfigured-${name}` };
    });
}

/**
 * The company declarations, built from cached discovery only. Endpoints are `{ name, id }` and the
 * catalogues are keyed by that id, so each configured endpoint is proved by its own discovery. A
 * configured endpoint whose cache is absent is named and the plan fails closed: its declarations would
 * ship unproved. This function takes a credential port only so a caller can prove it is never consulted.
 */
export function companyPlan({ endpoints, catalogues, credentials, ports, mcp }) {
  void credentials;
  void ports;
  const missing = endpoints.filter(endpoint => !Array.isArray(catalogues?.[endpoint.id]) || catalogues[endpoint.id].length === 0);
  if (missing.length) return { missing: missing.map(endpoint => endpoint.name), definitions: [], publishedEndpoints: 0 };
  const policy = endpoint => ({
    schemaVersion: 1, ownerId: 'helper-provider-smoke', connectionId: endpoint.id, generation: 1, enabled: true, connector: 'mongoose',
    endpoint: { id: endpoint.id, url: 'https://fixture.invalid/mcp', account: 'cached', resource: `mongoose:${endpoint.name}`, credentialRef: null },
    toolNames: catalogues[endpoint.id].map(tool => String(tool.name ?? '')), schemaDigest: `cached-${endpoint.id}`,
    sourcePolicy: { id: 'cached', revision: 1, unknownClass: 'ordinary', allowedClasses: ['ordinary'] },
    route: { identity: 'cached', allowedClasses: ['ordinary'] },
    bounds: { maxQueryChars: 4000, maxSearchLimit: 25, maxGetIds: 10, maxEntityBytes: 100000, maxResultBytes: 100000 },
  });
  const bindings = endpoints.map(endpoint => ({ connector: 'mongoose', policy: policy(endpoint), reader: { call: async () => ({ state: 'completed', decodedResult: {} }) } }));
  for (const binding of bindings) {
    mcp.mongoosePublishCatalogue(binding.policy.endpoint.id, catalogues[binding.policy.endpoint.id].map(tool => ({
      name: String(tool.name), inputSchema: tool.inputSchema,
      description: typeof tool.description === 'string' && tool.description.trim() !== '' ? tool.description : `Cached discovery of ${String(tool.name)}.`,
    })));
  }
  // A configured endpoint counts as published only when its own cached declarations produce a tool.
  const publishedEndpoints = endpoints.filter(endpoint => mcp.configuredCompanyTools([bindings.find(binding => binding.policy.endpoint.id === endpoint.id)]).length > 0).length;
  return { missing: [], definitions: mcp.configuredCompanyTools(bindings), publishedEndpoints };
}

/**
 * The precondition the paid request must meet: what the configuration declares has to be what the
 * registry published, or the declarations would ship unproved. Exported so the unit suite can hold this
 * decision without a paid call.
 */
export function providerShapeRefusal(input) {
  if (input.expectedEndpoints === 0) return '';
  if (input.published < input.expectedEndpoints) return 'company_bindings_unavailable';
  if (input.company === 0) return 'company_bindings_unavailable';
  if (input.tools !== input.static + input.company) return 'company_bindings_unavailable';
  return '';
}

/** Nothing from a provider body is printed without this: no key, no owner content. */
function redacted(text) {
  return String(text ?? '')
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, BODY_LIMIT);
}

async function main(argv) {
  const options = parseArgs(argv);
  const stamp = captureStamp(options.capture);
  const dataDir = resolve(options.dataDir);
  const sourceDir = configuredDir(dataDir);
  if (!sourceDir) {
    process.stdout.write(`HELPER-PROVIDER SKIP no provider configuration under ${dataDir}\n`);
    return 3;
  }
  const moduleDir = resolve(options.moduleDir);
  const started = Date.now();
  const load = name => import(pathToFileURL(join(moduleDir, name + '.js')).href);
  const { credentialsFor } = await load('config/index');
  const { loadTaskModels } = await load('config/tasks');
  const { createRegistry } = await load('tasks/tools');
  const { configuredCompanyTools } = await load('tasks/connectors');
  const { createModelPort } = await load('tasks/model');
  const { mongoosePublishCatalogue } = await load('connectors/mongoose');
  const { readPublishedCatalogues } = await load('runtime/store');

  const role = loadTaskModels(sourceDir).worker;
  if ((role.provider ?? 'openai') !== 'openai') {
    process.stdout.write(`HELPER-PROVIDER SKIP provider ${role.provider} does not take the OpenAI strict shape\n`);
    return 3;
  }

  // W9: the host's own record first, so the paid request proves the set the app really sends; the
  // committed capture only stands in when the host kept none, and then the run says WARN.
  const capture = options.capture && existsSync(options.capture) ? JSON.parse(readFileSync(options.capture, 'utf8')) : {};
  const endpoints = configuredCompanyEndpoints(sourceDir);
  const source = declarationSource({
    record: storeCatalogue(readPublishedCatalogues(join(dataDir, 'state.sqlite'))), endpoints, capture, stamp,
  });
  process.stdout.write(`${source.line}\n`);
  const catalogues = source.catalogues;
  const ports = { authority: { authorize: async () => { throw new Error('helper-provider-smoke executes no tool'); } }, execute: async () => { throw new Error('helper-provider-smoke executes no tool'); } };
  const plan = companyPlan({ endpoints, catalogues, credentials: credentialsFor(sourceDir), ports, mcp: { mongoosePublishCatalogue, configuredCompanyTools } });
  const staticOnly = createRegistry(ports);
  const registry = createRegistry(ports, plan.definitions);
  const tools = [...registry.values()];
  const expected = staticOnly.size + plan.definitions.length;
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1);

  if (plan.missing.length) {
    process.stderr.write(`HELPER-PROVIDER FAIL reason=discovery_missing expected=${expected} observed=${tools.length} configured=${endpoints.length} seconds=${seconds()}\n`);
    for (const name of plan.missing) process.stderr.write(`HELPER-PROVIDER FAIL endpoint=${name} reason=discovery_missing cache=${options.capture || 'absent'}\n`);
    process.stderr.write('HELPER-PROVIDER FAIL no persisted discovery covers this endpoint: the host keeps the declarations it published at its last live connect, and the fallback capture carries none\n');
    return 2;
  }
  const refusal = providerShapeRefusal({ expectedEndpoints: endpoints.length, published: plan.publishedEndpoints, company: plan.definitions.length, tools: tools.length, static: staticOnly.size });
  if (refusal) {
    process.stderr.write(`HELPER-PROVIDER FAIL reason=${refusal} expected=${expected} observed=${tools.length} company=${plan.definitions.length} seconds=${seconds()}\n`);
    return 2;
  }

  let rejection = null;
  let usage = { input: 0, output: 0 };
  const transport = async (url, init) => {
    const body = JSON.parse(String(init.body));
    body.max_output_tokens = CAP_OUTPUT_TOKENS;
    const response = await fetch(url, { ...init, body: JSON.stringify(body) });
    if (!response.ok) {
      rejection = { status: response.status, body: redacted(await response.clone().text()) };
      return response;
    }
    const counts = (await response.clone().json()).usage ?? {};
    usage = { input: counts.input_tokens ?? 0, output: counts.output_tokens ?? 0 };
    return response;
  };
  const infer = createModelPort({ role, credentials: credentialsFor(sourceDir), transport });
  let inference = null;
  try {
    inference = await infer({
      instructions: 'You are a read-only helper proving one tool call. Make the single tool call you are asked for and nothing else.',
      input: 'Read my calendar for 2026-01-05 using the calendar read tool. You must call that tool; do not answer without it.',
      outputs: [],
      turns: [],
      tools,
      model: role.model,
      effort: role.effort,
    }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
  } catch (error) {
    if (!rejection) throw error;
  }
  if (rejection) {
    process.stderr.write(`HELPER-PROVIDER FAIL status=${rejection.status} expected=${expected} observed=${tools.length} seconds=${seconds()}\n`);
    process.stderr.write(`HELPER-PROVIDER FAIL body=${JSON.stringify(rejection.body)}\n`);
    return 2;
  }
  const calls = (inference?.calls ?? []).filter(call => registry.has(call.name));
  if (!calls.length) {
    process.stderr.write(`HELPER-PROVIDER FAIL status=completed expected=${expected} observed=${tools.length} seconds=${seconds()} calls=0 no registered tool call in the answer\n`);
    return 2;
  }
  process.stdout.write(`HELPER-PROVIDER PASS status=completed expected=${expected} observed=${tools.length} static=${staticOnly.size} company=${plan.definitions.length} endpoints=${endpoints.map(endpoint => endpoint.name).join(',')} model=${role.model} effort=${role.effort} calls=${calls.map(call => call.name).join(',')} input_tokens=${usage.input} output_tokens=${usage.output} seconds=${seconds()}\n`);
  return 0;
}

// The provider client keeps sockets open, so the process ends on its own exit code instead of waiting
// for the event loop to drain. Importing this file (the unit suite does) runs nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`HELPER-PROVIDER ERROR ${redacted(error?.message ?? error)}\n`);
    process.exit(1);
  });
}
