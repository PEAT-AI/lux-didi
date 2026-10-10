// TEST-ONLY runtime shim. Never imported by production.
//
// Hooks ONLY the `./runtime.js` import made by the exact canonical host entry
// URL, and forwards every other resolution/load through the default loader. The
// returned wrapper re-exports the real runtime module and installs the
// recording synthetic ModelTesting supplied by the fixture entry on globalThis.
import { registerHooks } from 'node:module';

export function installRuntimeHook({ canonicalURL }) {
  const wrapperURL = new URL('fixture-runtime.mjs', canonicalURL).href;
  const canonicalRuntimeURL = new URL('runtime.js', canonicalURL).href;
  const wrappers = new Map();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === './runtime.js' && context.parentURL === canonicalURL) {
        return { url: wrapperURL, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url !== wrapperURL) return nextLoad(url, context);
      let result = wrappers.get(url);
      if (result === undefined) {
        const source = [
          `import * as real from ${JSON.stringify(canonicalRuntimeURL)};`,
          'export const defaultDataDir = real.defaultDataDir;',
          'export const pairLocal = real.pairLocal;',
          'export async function startHost(config) {',
          '  return real.startHost({ ...config, modelTesting: globalThis.__didiFixtureModelTesting });',
          '}'
        ].join('\n');
        result = { format: 'module', source, shortCircuit: true };
        wrappers.set(url, result);
      }
      return result;
    }
  });
}
