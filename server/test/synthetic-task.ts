import type { Store } from '../runtime/store.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
/** Explicit synthetic fixture: no network credentials or real model calls. */
export function syntheticTaskFactory(store: Store) {
  return hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => [], contentAllowed: () => false, timeZone: 'UTC',
    infer: async () => ({ text: '', calls: [], no_action: true }), effectCheck: async () => true });
}
