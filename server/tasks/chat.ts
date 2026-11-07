import { TASK_CONNECTOR_FAILURE, TASK_CONNECTOR_FAILURE_CODE } from './results.js';
import { isConnectorTaskRead } from './connectors.js';
import { HOST_EVIDENCE } from '../tools/types.js';
import { TASK_DISCLOSURE } from './results.js';
import type { ToolDefinition, JsonObject, DataClass } from '../adapters/model/types.js';
import type { ToolsOwner } from '../tools/types.js';
import type { RevisionIdentity } from './controller.js';
import type { TaskRuntime } from './runtime.js';
import { validateArguments, TASK_ACCOUNT, TASK_RESOURCE } from './tools.js';
export { TASK_ACCOUNT, TASK_RESOURCE } from './tools.js';
/** The chat model uses the same task registry, schemas, captured evidence and Authority as voice. */
export function taskDefinitions(runtime: TaskRuntime, identity: RevisionIdentity, owner: Pick<ToolsOwner, 'complete' | 'taskIntent' | 'runTask' | 'taskVisible'> & { journal: Pick<ToolsOwner['journal'], 'fail'> }, runId?: string): ToolDefinition[] {
  return [...runtime.registry.values()].filter(tool => !runId || owner.taskVisible(runId, tool.name)).map(tool => ({
    name: tool.name, description: tool.description, parameters: tool.parameters as ToolDefinition['parameters'],
    effect: tool.effect === 'none' ? 'read' : 'write', accountId: TASK_ACCOUNT, resourceId: TASK_RESOURCE,
    validate: args => validateArguments(tool, args).ok,
    execute: async (args, context) => {
      const call = owner.taskIntent(context, tool.name, args);
      const { signal } = context;
      return owner.runTask(call, args, async () => {
        const result = await runtime.runTool(tool.name, args, { ...identity, operation_id: context.executionId }, signal);
        if (result.status === 'failed' && (isConnectorTaskRead(tool.name) || tool.effect === 'none' && tool.outside_text)) return { status: 'completed' as const, result: owner.journal.fail(call, 'failed', result[TASK_CONNECTOR_FAILURE_CODE] ?? 'connector_error', result[TASK_CONNECTOR_FAILURE]) };
        // Reads are conservatively private except host-owned alarm/roster metadata and public web evidence.
        const dataClasses: readonly DataClass[] = result.dataClasses ?? (result.status === 'failed' || tool.effect !== 'none' || ['alarm_list', 'people_lookup', 'search_web'].includes(tool.name) ? ['ordinary'] : ['private']);
        const snapshot = result[TASK_DISCLOSURE];
        snapshot?.recordReuse?.();
        return { status: 'completed', result: owner.complete(call, JSON.parse(JSON.stringify(result)) as JsonObject, dataClasses, undefined, snapshot?.[HOST_EVIDENCE], snapshot?.sourceDispatchRefs?.map(id => ({ id })), snapshot?.sourcePolicyRefs) };
      });
    },
  }));
}
