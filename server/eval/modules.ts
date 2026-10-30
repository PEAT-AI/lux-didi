import { registerHooks } from 'node:module';

/**
 * Records every module the eval process loads after the watch is installed. The scripted path must never
 * resolve the real realtime adapter, and this is the observable that proves it: if a static import ever
 * pulled `live.ts` (and with it `adapters/live-voice`) into a run, the URL would appear here.
 */
const loaded: string[] = [];
let installed = false;

export function installModuleWatch(): void {
  if (installed) return;
  installed = true;
  registerHooks({ load(url, context, nextLoad) { loaded.push(url); return nextLoad(url, context); } });
}

export function loadedModules(): readonly string[] { return loaded; }

/** The module URLs that would mean eval mode reached the real adapter. */
export const REALTIME_ADAPTER_MODULES = [/adapters\/live-voice\/gemini\.js$/, /adapters\/live-voice\/openai\.js$/, /eval\/live\.js$/];

export function realtimeAdapterModulesLoaded(): string[] {
  return loaded.filter(url => REALTIME_ADAPTER_MODULES.some(pattern => pattern.test(url)));
}
