#!/usr/bin/env node
// One real helper request through the packaged model port, so a schema the provider refuses can never
// ship. The declared tool set of this build is sent to the configured provider with the real
// credential and the FULL real registry, configured company tools included; the request is a fixed
// harmless ask that forces one calendar read, and no tool is executed here. A configuration that
// declares company endpoints and a run that publishes none of them is a refusal before the request,
// with one bounded reconnect through the host's own recover(), never a PASS on the static set alone.
//
// Usage: node scripts/lib/helper-provider-smoke.mjs --data-dir DIR [--module-dir DIR]
//
//   exit 0  PASS: every configured company set published and the provider answered `completed` with at
//           least one registered tool, so the full declared set is proved
//   exit 1  FAIL, not proved: the harness could not run, or the company endpoints this configuration
//           declares did not publish, so their declarations would ship unproved. Never a PASS.
//   exit 2  FAIL: the provider rejected the request, or the response named no tool
//   exit 3  SKIP: nothing to prove here (no configured provider, or a non-OpenAI provider)
//
// The owner's config is read, copied to a private temporary directory and handed to the host from
// there, as server/test/smoke/probes.mjs does (#397): a host is never given a config dir it could
// journal or seed beside. The copy and the scratch store are removed before exit. Never prints the
// credential and never prints owner content: only status, tool count, tokens and time.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CAP_OUTPUT_TOKENS = 256;
const BODY_LIMIT = 2048;
const REQUEST_TIMEOUT_MS = 60000;
const INSTALLED_SETTINGS = 'Library/Application Support/ai.peat.lux-didi-operator/settings.json';

function parseArgs(argv) {
  const options = { dataDir: '', moduleDir: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--data-dir') options.dataDir = argv[++index] ?? '';
    else if (flag === '--module-dir') options.moduleDir = argv[++index] ?? '';
    else throw new Error(`helper-provider-smoke: unknown argument ${flag}`);
  }
  if (!options.dataDir) throw new Error('helper-provider-smoke: --data-dir is required');
  return options;
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

/** A private copy of the config dir: regular files only, each keeping its own mode. */
function stageConfig(sourceDir) {
  const staged = mkdtempSync(join(tmpdir(), 'didi-helper-provider-'));
  chmodSync(staged, 0o700);
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = join(sourceDir, entry.name);
    copyFileSync(from, join(staged, entry.name));
    chmodSync(join(staged, entry.name), statSync(from).mode & 0o777);
  }
  return staged;
}

/**
 * The precondition the paid request must meet: what the configuration declares has to be what the
 * registry published, or the company declarations would ship unproved. Exported so the unit suite can
 * hold this decision without a paid call.
 */
export function providerShapeRefusal(input) {
  if (input.expected === 0) return '';
  if (input.published < input.expected) return 'company-unpublished';
  if (input.company === 0) return 'company-unpublished';
  if (input.tools <= input.static) return 'company-unpublished';
  return '';
}

/**
 * The company endpoints this configuration declares. The proof is fail-closed: a configuration that
 * declares them and a run that publishes none of them is a rejection, never a PASS on the static set
 * alone, because the company declarations would then ship unproved.
 */
function declaredCompanyEndpoints(configDir) {
  const file = join(configDir, 'mcp.json');
  if (!existsSync(file)) return 0;
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const endpoints = Array.isArray(doc?.endpoints) ? doc.endpoints : [];
  return endpoints.filter(entry => entry && entry.connector === 'mongoose' && entry.enabled !== false).length;
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
  const dataDir = resolve(options.dataDir);
  const sourceDir = configuredDir(dataDir);
  if (!sourceDir) {
    process.stdout.write(`HELPER-PROVIDER SKIP no provider configuration under ${dataDir}\n`);
    return 3;
  }
  const moduleDir = resolve(options.moduleDir);
  const work = mkdtempSync(join(tmpdir(), 'didi-helper-provider-run-'));
  chmodSync(work, 0o700);
  const configDir = stageConfig(sourceDir);
  const storeDir = join(work, 'store');
  mkdirSync(storeDir, { mode: 0o700 });
  const started = Date.now();
  try {
    const load = name => import(pathToFileURL(join(moduleDir, name + '.js')).href);
    const { Store } = await load('runtime/store');
    const { domainMigrations } = await load('domain/index');
    const { chatMigrations } = await load('chat/index');
    const { liveMigrations } = await load('live/index');
    const { toolsMigrations } = await load('tools/index');
    const { composeMcpRuntime } = await load('host/mcp');
    const { credentialsFor } = await load('config/index');
    const { loadTaskModels } = await load('config/tasks');
    const { createRegistry } = await load('tasks/tools');
    const { configuredCompanyTools, connectorExecutor } = await load('tasks/connectors');
    const { createModelPort } = await load('tasks/model');

    const role = loadTaskModels(configDir).worker;
    if ((role.provider ?? 'openai') !== 'openai') {
      process.stdout.write(`HELPER-PROVIDER SKIP provider ${role.provider} does not take the OpenAI strict shape\n`);
      return 3;
    }

    const store = new Store(storeDir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
    let connectors;
    try {
      connectors = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryRepeatMs: false });
      await connectors.start();
      const expected = declaredCompanyEndpoints(configDir);
      let derived;
      const derive = () => {
        const bindings = connectors.owner.taskBindings(connectors.connectionIds());
        const company = configuredCompanyTools(bindings);
        const ports = { authority: { authorize: async () => { throw new Error('helper-provider-smoke executes no tool'); } }, execute: connectorExecutor(bindings) };
        const staticOnly = createRegistry(ports);
        const registry = createRegistry(ports, company);
        const tools = [...registry.values()];
        const published = bindings.filter(binding => binding.connector === 'mongoose').length;
        derived = { company, registry, staticOnly, tools, published };
        return providerShapeRefusal({ expected, published, company: company.length, tools: tools.length, static: staticOnly.size });
      };
      // Fail closed before the paid request: what the configuration declares must have published. A
      // first round that came up short earns the host's own bounded reconnect, never a silent pass.
      let refusal = derive();
      if (refusal) {
        await connectors.recover();
        refusal = derive();
      }
      const { company, registry, staticOnly, tools, published } = derived;
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (refusal) {
        const state = connectors.status().endpoints.map(endpoint => `${endpoint.id}:${endpoint.state}/${endpoint.tools}/${endpoint.error ?? '-'}`).join(',');
        process.stderr.write(`HELPER-PROVIDER FAIL reason=${refusal} configured=${expected} published=${published} company=${company.length} tools=${tools.length} static=${staticOnly.size} endpoints=${state} seconds=${seconds}\n`);
        process.stderr.write('HELPER-PROVIDER FAIL the configured company endpoints did not connect, so their declarations stay unproved\n');
        return 1;
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
      const infer = createModelPort({ role, credentials: credentialsFor(configDir), transport });
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
        process.stderr.write(`HELPER-PROVIDER FAIL status=${rejection.status} tools=${tools.length} seconds=${seconds}\n`);
        process.stderr.write(`HELPER-PROVIDER FAIL body=${JSON.stringify(rejection.body)}\n`);
        return 2;
      }
      const calls = (inference?.calls ?? []).filter(call => registry.has(call.name));
      if (!calls.length) {
        process.stderr.write(`HELPER-PROVIDER FAIL status=completed tools=${tools.length} seconds=${seconds} calls=0 no registered tool call in the answer\n`);
        return 2;
      }
      process.stdout.write(`HELPER-PROVIDER PASS status=completed tools=${tools.length} static=${staticOnly.size} company=${company.length} configured=${expected} model=${role.model} effort=${role.effort} calls=${calls.map(call => call.name).join(',')} input_tokens=${usage.input} output_tokens=${usage.output} seconds=${seconds}\n`);
      return 0;
    } finally {
      await connectors?.close();
      store.close();
    }
  } finally {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
}

// The connector runtime keeps sockets open after close, so the process ends on its own exit code
// instead of waiting for the event loop to drain. Importing this file (the unit suite does) runs nothing.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(error => {
    process.stderr.write(`HELPER-PROVIDER ERROR ${redacted(error?.message ?? error)}\n`);
    process.exit(1);
  });
}
