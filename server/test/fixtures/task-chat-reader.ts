import { connectorDescriptor } from '../../connectors/index.js';
import type { McpPort } from '../../adapters/mcp/port.js';
import type { McpRegistry } from '../../adapters/mcp/registry.js';
import type { ConnectionEndpoint, ConnectionPolicy } from '../../tools/types.js';
import { connectorExecutor } from '../../tasks/connectors.js';
import { createRegistry } from '../../tasks/tools.js';
import { FakeAuthority } from '../../tasks/authority.js';

/** Real native reader/projector and SDK port, selected by explicit helper arguments. */
export function taskChatReader(port: McpPort, registry: McpRegistry, endpoint: ConnectionEndpoint, schemaDigest: string, toolNames: string[], grantedNames = toolNames) {
  const policy: ConnectionPolicy = {
    schemaVersion: 1, ownerId: 'synthetic-owner', connectionId: endpoint.id, generation: 1, enabled: true,
    connector: 'mattermost', endpoint, schemaDigest, toolNames: grantedNames,
    sourcePolicy: { id: 'synthetic-chat', revision: 1, unknownClass: 'private', allowedClasses: ['private'] },
    route: { identity: 'voice', allowedClasses: ['private'] },
    bounds: { maxQueryChars: 1000, maxSearchLimit: 50, maxGetIds: 50, maxEntityBytes: 1000000, maxResultBytes: 1000000 },
  };
  const descriptor = connectorDescriptor('mattermost')!;
  const reader = descriptor.createReader({ port, registry, endpoint, schemaDigest, generation: 1, policy });
  const execute = connectorExecutor([{ connector: 'mattermost', reader, policy, project: evidence => descriptor.project(evidence, port, policy) }]);
  const tools = createRegistry({ execute, authority: new FakeAuthority() });
  return { tools, policy, async call(name: string, args: Record<string, unknown>) {
    const tool = tools.get(name)!;
    const fields = tool.parameters.properties as Record<string, unknown>;
    const normalized = Object.fromEntries(Object.keys(fields).map(key => [key, args[key] ?? null]));
    return tool.run(normalized, { task_id: 'synthetic-chat', task_revision: 1, operation_id: name, connection_generation: 1 }, new AbortController().signal);
  } };
}
