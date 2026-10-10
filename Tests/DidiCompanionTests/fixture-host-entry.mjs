// TEST-ONLY host entry. Inside a separately composed fixture app this file is
// `server/dist/host/index.js`; the byte-identical canonical entry is kept beside
// it as `canonical.js`. Never shipped and never imported by production.
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installRuntimeHook } from './fixture-host-runtime.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const canonicalURL = pathToFileURL(join(here, 'canonical.js')).href;

// Deterministic recording transport: reject anything that is not the synthetic
// provider endpoint and never fall back to a real network call.
const calls = [];
globalThis.__didiFixtureCalls = calls;
globalThis.__didiFixtureModelTesting = {
  credentials: { resolve: async () => 'synthetic-NEVER-REAL' },
  transport: async (url, init) => {
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) {
      throw new Error('fixture transport refuses a non-synthetic provider URL');
    }
    calls.push({ url, body: typeof init?.body === 'string' ? init.body : '' });
    try {
      const i = process.argv.indexOf('--data-dir');
      if (i >= 0 && process.argv[i + 1]) writeFileSync(join(process.argv[i + 1], 'fixture-calls.json'), JSON.stringify(calls));
    } catch {}
    const chunk = { candidates: [{ content: { parts: [{ text: 'synthetic reply' }], role: 'model' } }] };
    const body = `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
};

installRuntimeHook({ canonicalURL });
const canonical = await import(canonicalURL);
await canonical.main(process.argv.slice(2));
