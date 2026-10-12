import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_DESCRIPTORS } from '../connectors/index.js';
import { declarationsFor } from '../tools/declarations.js';
import { REMEMBER_PARAMETERS } from '../tools/remember.js';
import type { ConnectionPolicy } from '../tools/types.js';
import type { ToolDefinition } from '../adapters/model/types.js';

const accepted = new Set(['type', 'properties', 'required', 'description', 'enum', 'nullable']);
const types = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'OBJECT', 'ARRAY']);
function violations(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== 'object') return [path];
  const value = schema as Record<string, unknown>;
  const errors = Object.keys(value).filter(key => !accepted.has(key)).map(key => `${path}.${key}`);
  if (!types.has(String(value.type))) errors.push(`${path}.type=${String(value.type)}`);
  for (const [name, child] of Object.entries(value.properties ?? {})) errors.push(...violations(child, `${path}.properties.${name}`));
  return errors;
}

test('every composed Live connector and built-in declaration conforms to provider schema dialect', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 12, maxGetIds: 10, maxEntityBytes: 4096, maxResultBytes: 8192 } } as ConnectionPolicy;
  const originals = Object.values(CONNECTOR_DESCRIPTORS).flatMap(descriptor => descriptor.declarations(policy));
  const registry = [...originals, { name: 'remember_note', description: 'Remember a note', parameters: REMEMBER_PARAMETERS }].map(tool => ({ ...tool, effect: 'read' as const, accountId: 'fixture', resourceId: 'fixture', validate: () => true, execute: async () => ({ status: 'failed' as const }) })) as ToolDefinition[];
  const before = structuredClone(registry.map(tool => tool.parameters));
  const derived = declarationsFor(registry);
  assert.deepEqual(registry.map(tool => tool.parameters), before, 'original validation authority is unchanged');
  assert.deepEqual([...derived.originalByName.values()], before);
  const errors = derived.declarations.flatMap(tool => violations(tool.parameters, `${tool.name}.parameters`));
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('nested unsupported constraints never leak and semantic constraints remain described', () => {
  const parameters = { type: 'object', additionalProperties: false, $schema: 'fixture', properties: { nested: { type: 'object', title: 'nested', properties: { text: { type: 'string', minLength: 1, maxLength: 10, pattern: '^a', format: 'email', default: 'a', examples: ['a'], const: 'a' }, choice: { type: 'string', enum: ['a', 'b'] } } } } };
  const registry: ToolDefinition[] = [{ name: 'nested', description: 'nested', parameters, effect: 'read', accountId: 'fixture', resourceId: 'fixture', validate: () => true, execute: async () => ({ status: 'failed' }) }];
  const declaration = declarationsFor(registry).declarations[0]!;
  assert.deepEqual(violations(declaration.parameters, 'nested'), []);
  assert.match(JSON.stringify(declaration.parameters), /Original schema/);
  assert.equal(parameters.additionalProperties, false);
});
