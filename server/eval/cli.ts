import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatSummary, loadCases, runSuite, type RunOptions } from './runner.js';
import { scriptedProvider } from './scripted.js';

/**
 * The eval CLI. `--live` is the owner's own run: it prints the model-call count and the estimate, refuses
 * without `--yes`, and prints the measured cost at the end. Everything else is the scripted harness.
 */
interface Args {
  cases?: string | undefined; toolMap?: string | undefined; category?: string | undefined; id?: string | undefined;
  live: boolean; yes: boolean;
}

function parse(argv: readonly string[]): Args {
  const args: Args = { live: false, yes: false };
  const value = (index: number): string => {
    const next = argv[index];
    if (next === undefined) throw new Error(`missing value for ${argv[index - 1] ?? 'argument'}`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const next = argv[index] as string;
    if (next === '--live') args.live = true;
    else if (next === '--yes') args.yes = true;
    else if (next === '--category') { args.category = value(++index); }
    else if (next === '--id') { args.id = value(++index); }
    else if (next === '--cases') { args.cases = value(++index); }
    else if (next === '--tool-map') { args.toolMap = value(++index); }
    else throw new Error(`unknown argument: ${next}`);
  }
  return args;
}

const here = dirname(fileURLToPath(import.meta.url));

function roots(args: Args) {
  const repoRoot = resolve(here, '../..');
  return {
    casesDir: args.cases ?? join(repoRoot, 'eval/cases'),
    toolMapPath: args.toolMap ?? join(repoRoot, 'eval/tool-map.json'),
  };
}

function selectCases(options: RunOptions) {
  return loadCases(options.casesDir).filter(entry =>
    (options.id === undefined || entry.id === options.id) &&
    (options.category === undefined || entry.category === options.category));
}

async function main() {
  const args = parse(process.argv.slice(2));
  const { casesDir, toolMapPath } = roots(args);
  const base: RunOptions = { casesDir, toolMapPath, ...(args.category ? { category: args.category } : {}), ...(args.id ? { id: args.id } : {}) };

  if (!args.live) {
    const summary = await runSuite({ ...base, provider: scriptedProvider() });
    console.log(formatSummary(summary));
    process.exitCode = summary.fail === 0 ? 0 : 1;
    return;
  }

  const { estimateLiveCost, formatLiveCost, livePort, liveProvider, measuredCost } = await import('./live.js');
  const selected = selectCases(base);
  console.log(formatLiveCost(estimateLiveCost(selected)));
  if (!args.yes) {
    console.log('refusing to spend: pass --yes to run these cases against the real model');
    process.exitCode = 2;
    return;
  }
  const { loadLiveConfig } = await import('../config/live.js');
  const configDir = process.env.LUX_DIDI_CONFIG_DIR ?? join(process.env.HOME ?? '', 'Library', 'Application Support', 'ai.peat.lux-didi');
  const loaded = loadLiveConfig({ configDir, ownerId: process.env.LUX_DIDI_OWNER_ID ?? 'local-owner' });
  if (loaded.status !== 'configured') {
    console.log(`LIVE UNAVAILABLE: the live provider config is ${loaded.status}; set the provider and key in the app first`);
    process.exitCode = 3;
    return;
  }
  const profile = loaded.config.profile;
  const envKey = profile.provider === 'openai' ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY;
  if (!envKey) {
    console.log(`LIVE UNAVAILABLE: set ${profile.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} for this run`);
    process.exitCode = 3;
    return;
  }
  const port = livePort({
    modelId: profile.liveModelId, voice: profile.voice, keyReference: profile.keyReference,
    resolveKey: async () => envKey,
    route: profile.route as unknown as { provider: 'gemini'; modelId: string; dataClasses: readonly ['ordinary'] },
  });
  const summary = await runSuite({ ...base, provider: liveProvider({ port, system: profile.prompt }) });
  console.log(formatSummary(summary));
  console.log(formatLiveCost(measuredCost()).replace('estimated', 'measured'));
  process.exitCode = summary.fail === 0 ? 0 : 1;
}

main().catch(error => {
  console.error(`eval cli failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
