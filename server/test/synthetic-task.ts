import type { ToolsOwner } from '../tools/types.js';
import type { Store } from '../runtime/store.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
/** Explicit synthetic fixture: no network credentials or real model calls. */
export function syntheticTaskFactory(store: Store, tools?: { owner: ToolsOwner; connectionIds(): readonly string[] }) {
  return hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => tools?.owner.taskBindings(tools.connectionIds()) ?? [], executors: sessionId => tools?.owner.taskExecutors(sessionId) ?? {}, timeZone: 'UTC',
    infer: async () => ({ text: '', calls: [], no_action: true }), effectCheck: async () => true });
}
