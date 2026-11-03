import type { ToolResult } from '../tasks/results.js';
import type { Store } from '../runtime/store.js';
import type { ToolsOwner } from '../tools/types.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import { taskDefinitions } from '../tasks/chat.js';

/** A real canonical tool turn, with explicit test approval and no inference/provider call. The caller closes it before its Store. */
export function canonicalTaskFixture(store: Store, owner: ToolsOwner, runId: string, ownerWords: string, connectionIds: readonly string[], timeZone = 'UTC') {
  const runtime = hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => owner.taskBindings(connectionIds), executors: () => owner.taskExecutors(runId), contentAllowed: () => false, timeZone,
    effectCheck: async () => true, infer: async () => { throw Error('The test calls the shared tool registry, not a second inference.'); },
  })(runId, { attach: () => {}, progress: () => {}, deliver: () => {}, closed: () => {} });
  const results: ToolResult[] = [], runTool = runtime.runTool.bind(runtime);
  runtime.runTool = async (...args) => { const result = await runTool(...args); results.push(result); return result; };
  const errors: string[] = [];
  const scopedOwner: ToolsOwner = { ...owner, runTask: (call, args, body) => {
    try { return owner.runTask(call, args, body); }
    catch (error) { errors.push(error instanceof Error ? error.message : 'non_error'); throw error; }
  } };
  const revision = runtime.begin(ownerWords, 1, 1);
  return { runtime, revision, results, errors, tools: taskDefinitions(runtime, revision.identity, scopedOwner, runId), close: () => runtime.close() };
}
