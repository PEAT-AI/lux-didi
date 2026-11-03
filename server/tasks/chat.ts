import type { ToolDefinition, JsonObject, DataClass } from '../adapters/model/types.js';
import type { ToolsOwner } from '../tools/types.js';
import type { RevisionIdentity } from './controller.js';
import type { TaskRuntime } from './runtime.js';
import { validateArguments, TASK_ACCOUNT, TASK_RESOURCE } from './tools.js';
export { TASK_ACCOUNT, TASK_RESOURCE } from './tools.js';
/** The chat model uses the same task registry, schemas, captured evidence and Authority as voice. */
export function taskDefinitions(runtime: TaskRuntime, identity: RevisionIdentity, owner: Pick<ToolsOwner, 'complete' | 'taskIntent'>): ToolDefinition[] {
  return [...runtime.registry.values()].map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters as ToolDefinition['parameters'],
    effect: tool.effect === 'none' ? 'read' : 'write', accountId: TASK_ACCOUNT, resourceId: TASK_RESOURCE,
    validate: args => validateArguments(tool, args).ok,
    execute: async (args, context) => {
      const call = owner.taskIntent(context, tool.name, args);
      const { signal } = context;
      const result = await runtime.runTool(tool.name, args, { ...identity, operation_id: context.executionId }, signal);
      // Reads are conservatively private except host-owned alarm/roster metadata and public web evidence.
      const dataClasses: DataClass[] = tool.effect !== 'none' || ['alarm_list', 'people_lookup', 'search_web'].includes(tool.name) ? ['ordinary'] : ['private'];
      return { status: 'completed', result: owner.complete(call, JSON.parse(JSON.stringify(result)) as JsonObject, dataClasses) };
    },
  }));
}
