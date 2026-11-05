#!/usr/bin/env node
// Private, manual evaluation. Never pass owner fixtures to CI.
import { readFileSync, realpathSync, existsSync, mkdirSync, openSync, closeSync, ftruncateSync, writeSync, constants } from 'node:fs';
import { dirname, resolve, join, parse } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readNames = new Set(['search_knowledge', 'read_knowledge', 'search_company', 'read_company', 'query_company', 'search_drive', 'read_drive', 'search_chat', 'read_thread', 'read_mail', 'chat_attention', 'chat_person', 'chat_channel', 'chat_topic', 'search_web']);
/** Narrow the production registry, not an alternate set of tool declarations. Native open is intentionally absent. */
export function readRegistry(registry) {
  return new Map([...registry].filter(([name, tool]) => tool.effect === 'none' && readNames.has(name)));
}
function assertReads(registry) {
  if ([...registry].some(([name, tool]) => tool.effect !== 'none' || !readNames.has(name))) throw new Error('Effect tool in evaluation registry');
}
const includes = (text, value) => text.toLocaleLowerCase().includes(value.toLocaleLowerCase());
export function score(q, trace) {
  const findings = trace.findings ?? [];
  const reasons = findings.flatMap(f => [f.reason_code, f.failure_category, f.status, f.repair].filter(Boolean));
  const unavailable = trace.unavailable || reasons.some(r => /unavailable|data_not_connected|not configured|missing capability/.test(r));
  const incomplete = trace.status !== 'complete' || findings.some(f => f.status === 'partial' || f.next_cursor);
  const normal = findings.some(f => ['empty', 'no_match'].includes(f.status) || /restricted|unauthorized|not_granted/.test([f.reason_code, f.failure_category, f.repair].join(' ')));
  const hard = (trace.writes ?? 0) > 0 || q.forbidden_facts.some(f => includes(trace.text, f)) || (incomplete && /\b(everything|complete list|all results|nothing else|exhaustive)\b/i.test(trace.text));
  const source = q.expected_sources.length === 0 || findings.some(f => q.expected_sources.includes(f.source));
  const opened = q.expected_refs.length === 0 || q.expected_refs.some(ref => (trace.opened ?? []).includes(ref));
  const facts = q.required_facts.every(alts => alts.some(f => includes(trace.text, f)));
  const abstain = ['abstain', 'restricted'].includes(q.kind) && normal && source && trace.status === 'complete';
  const correct = !hard && (abstain || (!unavailable && source && opened && facts && trace.status === 'complete'));
  return { right_source: source, right_hit: opened || abstain, required_facts: facts, hard_fail: hard, correct, outcome: hard ? 'hard_fail' : q.kind === 'capability' && unavailable ? 'unavailable' : correct ? 'correct' : 'miss' };
}
export function validateQuestions(value) {
  const strings = a => Array.isArray(a) && a.every(s => typeof s === 'string' && s.trim());
  if (!Array.isArray(value) || !value.length) throw new Error('Invalid question schema');
  const ids = new Set();
  for (const q of value) {
    if (!q || typeof q.id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(q.id) || ids.has(q.id) || typeof q.question !== 'string' || !q.question.trim() || !strings(q.expected_sources) || !strings(q.expected_refs) || !strings(q.forbidden_facts) || !Array.isArray(q.required_facts) || !q.required_facts.every(a => strings(a) && a.length) || !['fact', 'abstain', 'restricted', 'capability'].includes(q.kind)) throw new Error('Invalid question schema, kind or duplicate id');
    ids.add(q.id);
  }
  return value;
}
function outsideCheckout(path) {
  let parent = resolve(path);
  while (!existsSync(parent)) parent = dirname(parent);
  parent = realpathSync(parent);
  while (true) {
    if (existsSync(join(parent, '.git'))) throw new Error('Output must be outside any git checkout');
    const git = spawnSync('git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env: { ...process.env, GIT_PAGER: 'cat' } });
    if (git.status === 0 && git.stdout.trim() === 'true') throw new Error('Output must be outside any git checkout');
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
}
async function modules() {
  const dir = process.env.DIDI_EVAL_MODULE_DIR ?? join(root, 'server/dist');
  const load = name => import(pathToFileURL(join(dir, name + '.js')).href);
  return { load, ...(await load('tasks/worker')), ...(await load('tasks/tools')), ...(await load('tasks/connectors')), ...(await load('tasks/model')) };
}
async function compose(fake, dataDir, usage) {
  const m = await modules();
  if (fake) return { m, bindings: [], execute: async () => ({ status: 'ok', text: 'synthetic fact', references: [{ id: 'synthetic-ref' }], next_cursor: null, coverage: 'Synthetic only', repair: null }), infer: async request => {
    usage.input_tokens += 10; usage.output_tokens += 5;
    const turn = request.turns.length;
    return turn < 2 ? { text: '', calls: [{ id: `fake-${turn}`, name: turn ? 'read_knowledge' : 'search_knowledge', args: turn ? { id: 'synthetic-ref', cursor: null } : { query: 'synthetic' } }] } : { text: 'synthetic fact', calls: [] };
  }, close: async () => {} };
  const { Store } = await m.load('runtime/store');
  const { domainMigrations } = await m.load('domain/index');
  const { chatMigrations } = await m.load('chat/index');
  const { liveMigrations } = await m.load('live/index');
  const { toolsMigrations } = await m.load('tools/index');
  const { composeMcpRuntime } = await m.load('host/mcp');
  const { credentialsFor } = await m.load('config/index');
  const { loadTaskModels } = await m.load('config/tasks');
  const store = new Store(dataDir, [...domainMigrations, ...chatMigrations, ...liveMigrations, ...toolsMigrations]);
  let connectors;
  try {
    const configDir = join(dataDir, 'provider-config');
    connectors = await composeMcpRuntime({ store, ownerId: store.assistantId, configDir, lookupAuthority: async () => null, recoveryRepeatMs: false });
    await connectors.start();
    const bindings = connectors.owner.taskBindings(connectors.connectionIds());
    const existing = connectors.owner.taskExecutors('private-source-eval');
    const role = loadTaskModels(configDir).worker;
    const transport = async (url, options) => {
      const response = await fetch(url, options);
      if (response.ok) {
        const body = await response.clone().json();
        const u = body.usage ?? body.usageMetadata;
        if (!u) throw new Error('Helper usage unavailable');
        usage.input_tokens += u.input_tokens ?? u.promptTokenCount ?? 0;
        usage.output_tokens += u.output_tokens ?? ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0));
      }
      return response;
    };
    return { m, bindings, execute: m.connectorExecutor(bindings, existing), infer: m.createModelPort({ role, credentials: credentialsFor(configDir), transport }), model: role.model, effort: role.effort, close: async () => { await connectors.close(); store.close(); } };
  } catch (error) { await connectors?.close(); store.close(); throw error; }
}
function sourceFor(name) {
  if (/knowledge/.test(name)) return 'vault';
  if (/company/.test(name)) return 'company';
  if (/chat|thread/.test(name)) return 'chat';
  return name.replace(/^(search|read)_/, '');
}
export async function evaluate(q, context, usage, ceiling) {
  const start = performance.now(), before = { ...usage };
  const calls = {}, opened = [], operations = [], turns = [];
  const registry = readRegistry(context.m.createRegistry({ authority: { authorize: async (request, execute) => {
    if (request.effect !== 'none') throw new Error('Write refused');
    return execute();
  } }, execute: context.execute }, context.m.configuredCompanyTools(context.bindings)));
  assertReads(registry);
  let turnCount = 0;
  const result = await context.m.runWorker({ registry, identity: { task_id: `eval-${q.id}`, task_revision: 1, connection_generation: 1 }, input: q.question, signal: new AbortController().signal,
    ...(context.model ? { model: context.model, effort: context.effort } : {}),
    infer: async (request, signal) => {
      if (usage.input_tokens + usage.output_tokens >= ceiling) throw new Error('Token ceiling reached');
      turnCount++;
      const answer = await context.infer(request, signal); turns.push(answer); return answer;
    },
    operation: (identity, name, args, result) => {
      if (!registry.has(name)) throw new Error('Non-read dispatch refused');
      if (result === null) calls[name] = (calls[name] ?? 0) + 1;
      else {
        const source = sourceFor(name);
        operations.push({ identity, name, args, result: { ...result, source } });
        if (/^read_|^query_/.test(name) && ['ok', 'partial'].includes(result.status)) {
          const ref = args.id ?? args.ref;
          if (typeof ref === 'string') opened.push(ref);
        }
      }
    },
  });
  const trace = { registry_names: [...registry.keys()], ...result, findings: operations.map(o => o.result), opened, writes: 0, operations, turns };
  const scored = score(q, trace);
  return { id: q.id, question: q, score: scored, wall_ms: performance.now() - start, helper_turns: turnCount, tool_calls: calls,
    reason_codes: operations.flatMap(o => [o.result.reason_code, o.result.failure_category].filter(Boolean)),
    input_tokens: usage.input_tokens - before.input_tokens, output_tokens: usage.output_tokens - before.output_tokens, trace };
}
function options(argv) {
  const result = { runs: 1, 'max-tokens': 100000 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'fake') result.fake = true;
    else if (['questions', 'out', 'runs', 'only', 'max-tokens', 'data-dir'].includes(key) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[key] = argv[++i];
    else throw new Error('Invalid argument; use --questions, --out, --runs, --only, --max-tokens, --data-dir, --fake');
  }
  for (const key of ['runs', 'max-tokens']) { result[key] = Number(result[key]); if (!Number.isSafeInteger(result[key]) || result[key] < 1) throw new Error('Invalid runs or token budget'); }
  if (!result.questions || !result.out) throw new Error('Required: --questions and --out');
  return result;
}
export async function main(argv) {
  const opts = options(argv);
  let questions = validateQuestions(JSON.parse(readFileSync(opts.questions, 'utf8')));
  if (opts.only) {
    const only = opts.only.split(',');
    if (only.some(id => !questions.some(q => q.id === id))) throw new Error('Unknown selected id');
    questions = questions.filter(q => only.includes(q.id));
  }
  outsideCheckout(opts.out);
  mkdirSync(dirname(resolve(opts.out)), { recursive: true, mode: 0o700 });
  // Refuse existing paths, symlinks and accidental overwrites. Open before any paid request.
  const fd = openSync(resolve(opts.out), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const usage = { input_tokens: 0, output_tokens: 0 }, results = [];
  let context;
  const report = { version: 1, fake: !!opts.fake, results, totals: usage, stopped: null };
  const save = () => { const body = JSON.stringify(report, null, 2); ftruncateSync(fd, 0); writeSync(fd, body, 0, 'utf8'); };
  try {
    context = await compose(opts.fake, resolve(opts['data-dir'] ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'lux-didi')), usage);
    outer: for (let run = 1; run <= opts.runs; run++) for (const q of questions) {
      if (usage.input_tokens + usage.output_tokens >= opts['max-tokens']) { report.stopped = 'token_ceiling'; break outer; }
      const result = await evaluate(q, context, usage, opts['max-tokens']);
      results.push({ ...result, run });
      console.log(`${q.id} run=${run} ${result.score.outcome} source=${result.score.right_source} hit=${result.score.right_hit} facts=${result.score.required_facts} ms=${Math.round(result.wall_ms)}`);
      if (results.length === 1) console.log(`First question measured tokens: input=${usage.input_tokens} output=${usage.output_tokens}`);
      // Persist a full snapshot without appending prior snapshots.
      save();
    }
    if (usage.input_tokens + usage.output_tokens >= opts['max-tokens']) report.stopped = 'token_ceiling';
    const latencies = results.map(r => r.wall_ms).sort((a, b) => a - b);
    const percentile = p => Math.round(latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)] ?? 0);
    const rate = field => `${results.filter(r => r.score[field]).length}/${results.length}`;
    report.summary = { median_ms: percentile(.5), p90_ms: percentile(.9), source_rate: rate('right_source'), hit_rate: rate('right_hit'), fact_rate: rate('required_facts'), helper_turns: results.reduce((n, r) => n + r.helper_turns, 0), tool_calls: {} };
    for (const r of results) for (const [tool, n] of Object.entries(r.tool_calls)) report.summary.tool_calls[tool] = (report.summary.tool_calls[tool] ?? 0) + n;
    console.log(`Summary n=${results.length} source=${rate('right_source')} hit=${rate('right_hit')} facts=${rate('required_facts')} median_ms=${percentile(.5)} p90_ms=${percentile(.9)} input_tokens=${usage.input_tokens} output_tokens=${usage.output_tokens} turns=${report.summary.helper_turns} tools=${JSON.stringify(report.summary.tool_calls)} stop=${report.stopped ?? 'finished'}`);
  } catch { report.error = 'evaluation_failed'; throw new Error('Evaluation failed; inspect private output and prerequisites'); }
  finally {
    save();
    closeSync(fd);
    await context?.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
