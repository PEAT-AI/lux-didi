import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTOR_DESCRIPTORS } from '../connectors/index.js';
import { declarationsFor } from '../tools/declarations.js';
import { chatCapabilities } from '../chat/context.js';
import { compilePrompt, validatePreferences, PROMPT_VERSION } from '../prompt/index.js';
import { createHash } from 'node:crypto';
import { REMEMBER_PARAMETERS } from '../tools/remember.js';
import { researchDeclaration } from '../tools/research.js';
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
  // The one research tool is declared to the Live model alongside remember_note (#241).
  const intents = [researchDeclaration()].map(({ name, description, parameters, guidance }) => ({ name, description, parameters, guidance }));
  const registry = [...originals, ...intents, { name: 'remember_note', description: 'Remember a note', parameters: REMEMBER_PARAMETERS }].map(tool => ({ ...tool, effect: 'read' as const, accountId: 'fixture', resourceId: 'fixture', validate: () => true, execute: async () => ({ status: 'failed' as const }) })) as ToolDefinition[];
  const before = structuredClone(registry.map(tool => tool.parameters));
  const derived = declarationsFor(registry);
  assert.deepEqual(registry.map(tool => tool.parameters), before, 'original validation authority is unchanged');
  assert.deepEqual([...derived.originalByName.values()], before);
  const errors = derived.declarations.flatMap(tool => violations(tool.parameters, `${tool.name}.parameters`));
  assert.deepEqual(errors, [], errors.join('\n'));
  const chat = chatCapabilities(registry.filter(tool => tool.name !== 'remember_note'), []);
  assert.deepEqual(chat.declarations.flatMap(tool => violations(tool.parameters, `${tool.name}.parameters`)), []);
  assert.deepEqual(registry.map(tool => tool.parameters), before, 'chat compilation leaves validation schemas intact');
});

// X2 (#250): the declared get_insight shape and its boundary validator must agree. The old
// schema named only `ids` and set additionalProperties:false, while the validator accepted
// more and refused include_links, which the upstream MCP get_insight itself accepts.
test('X2: the get_insight declaration names every key its validator accepts', () => {
  const policy = { bounds: { maxQueryChars: 200, maxSearchLimit: 12, maxGetIds: 10, maxEntityBytes: 4096, maxResultBytes: 8192 } } as ConnectionPolicy;
  const declaration = CONNECTOR_DESCRIPTORS['lux-knowledge']!.declarations(policy).find(tool => tool.name === 'get_insight')!;
  const properties = declaration.parameters['properties'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), ['ids', 'include_links'], 'the declared keys are exactly the accepted keys');
  assert.equal(declaration.parameters['additionalProperties'], true, 'the read schema admits extra keys the validator drops');
  assert.equal(declaration.validate({ ids: [1], include_links: true }), true, 'the declared include_links key is accepted by the validator');
  assert.equal(declaration.validate({ ids: [1], nonsense: 1 }), true, 'an unknown read key is dropped, not refused');
  const live = declarationsFor([{ name: 'get_insight', description: declaration.description, parameters: declaration.parameters } as ToolDefinition]).declarations[0]!;
  const liveProperties = live.parameters['properties'] as Record<string, unknown>;
  assert.ok(Object.keys(liveProperties).includes('include_links'), 'the flattened Live schema still names include_links');
  assert.deepEqual(violations(live.parameters, 'get_insight.parameters'), []);
});

test('nested unsupported constraints never leak and semantic constraints remain described', () => {
  const parameters = { type: 'object', additionalProperties: false, $schema: 'fixture', properties: { nested: { type: 'object', title: 'nested', properties: { text: { type: 'string', minLength: 1, maxLength: 10, pattern: '^a', format: 'email', default: 'a', examples: ['a'], const: 'a' }, choice: { type: 'string', enum: ['a', 'b'] } } } } };
  const registry: ToolDefinition[] = [{ name: 'nested', description: 'nested', parameters, effect: 'read', accountId: 'fixture', resourceId: 'fixture', validate: () => true, execute: async () => ({ status: 'failed' }) }];
  const declaration = declarationsFor(registry).declarations[0]!;
  assert.deepEqual(violations(declaration.parameters, 'nested'), []);
  assert.match(JSON.stringify(declaration.parameters), /Original schema/);
  assert.equal(parameters.additionalProperties, false);
});


test('chat TOOLS conduct is in the compiled instruction and its audited capability section', () => {
  const registry: ToolDefinition[] = [{ name: 'read_fixture', description: 'Read synthetic evidence', parameters: { type: 'object', properties: {} }, effect: 'read', accountId: 'fixture', resourceId: 'fixture', validate: () => true, execute: async () => ({ status: 'failed' }) }];
  const base = { ownerId: 'fixture', persona: 'didi' as const, promptVersion: PROMPT_VERSION,
    preferences: validatePreferences({ schemaVersion: 1, ownerId: 'fixture', dataClass: 'ordinary', language: 'en-US', register: 'plain', humor: 'off', verbosity: 'brief' }, 'fixture'),
    evidence: [], history: [{ schemaVersion: 1 as const, ownerId: 'fixture', dataClass: 'ordinary' as const, id: 'turn', role: 'user' as const, text: 'Read the evidence' }],
    budgets: { trustedChars: 20000, contextChars: 12000, historyChars: 12000 } };
  const enabled = compilePrompt({ ...base, capabilities: chatCapabilities(registry, []) });
  assert.match(enabled.system, /TOOLS: Call approved read tools/);
  const capabilityText = enabled.system.split('[capabilities]\n')[1]!;
  assert.equal(enabled.manifest.sections.find(section => section.id === 'capabilities')?.hash, createHash('sha256').update(capabilityText).digest('hex'));
  const disabled = compilePrompt({ ...base, capabilities: chatCapabilities([], []) });
  assert.doesNotMatch(disabled.system, /TOOLS:/);
});
