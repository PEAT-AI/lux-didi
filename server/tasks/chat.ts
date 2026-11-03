import type { ToolDefinition, JsonObject, DataClass } from '../adapters/model/types.js';
import type { ToolsOwner } from '../tools/types.js';
import { canonicalJSON, sha256 } from '../tools/canonical.js';
import type { RevisionIdentity } from './controller.js';
import type { TaskRuntime } from './runtime.js';
import { validateArguments } from './tools.js';
export const TASK_ACCOUNT = 'gateway:tasks';
export const TASK_RESOURCE = 'owner-task-tools';
/** The chat model uses the same task registry, schemas, captured evidence and Authority as voice. */
export function taskDefinitions(runtime: TaskRuntime, identity: RevisionIdentity, owner: Pick<ToolsOwner, 'complete'>): ToolDefinition[] {
  return [...runtime.registry.values()].map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters as ToolDefinition['parameters'],
    effect: tool.effect === 'none' ? 'read' : 'write', accountId: TASK_ACCOUNT, resourceId: TASK_RESOURCE,
    validate: args => validateArguments(tool, args).ok,
    execute: async (args, context) => {
      const { signal, ...execution } = context;
      const result = await runtime.runTool(tool.name, args, { ...identity, operation_id: context.executionId }, signal);
      // Reads are conservatively private except host-owned alarm/roster metadata and public web evidence.
      const dataClasses: DataClass[] = tool.effect !== 'none' || ['alarm_list', 'people_lookup', 'search_web'].includes(tool.name) ? ['ordinary'] : ['private'];
      const call = { ...execution, toolName: tool.name, argumentsHash: sha256(canonicalJSON(args)) };
      return { status: 'completed', result: owner.complete(call, JSON.parse(JSON.stringify(result)) as JsonObject, dataClasses) };
    },
  }));
}
