import type { Store } from '../runtime/store.js';
import type { ToolsOwner } from '../tools/types.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import { taskDefinitions } from '../tasks/chat.js';

/** A real canonical tool turn, with explicit test approval and no inference/provider call. The caller closes it before its Store. */
export function canonicalTaskFixture(store: Store, owner: ToolsOwner, runId: string, ownerWords: string, timeZone = 'UTC') {
  const runtime = hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => owner.taskBindings(), executors: () => owner.taskExecutors(runId), contentAllowed: () => false, timeZone,
    effectCheck: async () => true, infer: async () => { throw Error('The test calls the shared tool registry, not a second inference.'); },
  })(runId, { attach: () => {}, progress: () => {}, deliver: () => {}, closed: () => {} });
  const revision = runtime.begin(ownerWords, 1, 1);
  return { runtime, revision, tools: taskDefinitions(runtime, revision.identity, owner, runId), close: () => runtime.close() };
}
