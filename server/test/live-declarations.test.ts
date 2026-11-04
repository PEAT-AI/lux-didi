import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/store.js';
import { domainMigrations } from '../domain/schema.js';
import { hostTaskFactory } from '../tasks/host.js';
import { resolveTaskModels } from '../config/tasks.js';
import { FakeDelivery } from '../tasks/controller.js';
import { taskDefinitions } from '../tasks/chat.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { declarationsFor } from '../tools/declarations.js';
import { chatCapabilities } from '../chat/context.js';
import { compilePrompt, validatePreferences, PROMPT_VERSION } from '../prompt/index.js';
import { createHash } from 'node:crypto';
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

function helperSurface(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'task-declarations-synthetic-'));
  const store = new Store(directory, domainMigrations);
  const runtime = hostTaskFactory({ store, credentials: { resolve: async () => undefined }, models: resolveTaskModels(undefined),
    bindings: () => [], timeZone: 'UTC', effectCheck: async () => true })('synthetic-declarations', new FakeDelivery());
  const revision = runtime.begin('Synthetic declaration audit', 1, 1);
  const registry = taskDefinitions(runtime, revision.identity, {
    journal: { fail: () => { throw Error('declaration audit must not execute'); } },
    taskVisible: () => true,
    runTask: () => { throw Error('declaration audit must not execute'); },
    complete: () => { throw Error('declaration audit must not execute'); },
    taskIntent: () => { throw Error('declaration audit must not execute'); },
  });
  t.after(() => { runtime.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return registry;
}
test('shared helper and chat declarations conform to the provider schema dialect', t => {
  const registry = helperSurface(t);
  const { declarations } = declarationsFor(registry);
  assert.equal(declarations.length, registry.length);
  for (const declaration of declarations) assert.deepEqual(violations(declaration.parameters, declaration.name), []);
  assert.ok(declarations.some(tool => tool.name === 'open'));
  assert.ok(declarations.some(tool => tool.name === 'find_file'));
  for (const retired of ['research', 'get_insight', 'open_source', 'open_home', 'open_app', 'open_web']) {
    assert.equal(declarations.some(tool => tool.name === retired), false, `${retired} is not a helper declaration`);
  }
});
test('knowledge reads expose their canonical id/cursor schema, not backend-specific options', t => {
  const registry = helperSurface(t), knowledge = registry.find(tool => tool.name === 'read_knowledge')!;
  assert.ok(knowledge);
  assert.equal(knowledge.validate({ id: '7', cursor: null }), true);
  assert.equal(knowledge.validate({ id: '7', cursor: null, include_links: true }), false);
  const declaration = declarationsFor(registry).declarations.find(tool => tool.name === 'read_knowledge')!;
  assert.deepEqual(Object.keys(declaration.parameters['properties'] as object).sort(), ['cursor', 'id']);
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
  assert.match(enabled.system, /TOOLS: Use only the approved read tools advertised for this turn when the question needs external evidence/);
  const capabilityText = enabled.system.split('[capabilities]\n')[1]!;
  assert.equal(enabled.manifest.sections.find(section => section.id === 'capabilities')?.hash, createHash('sha256').update(capabilityText).digest('hex'));
  const disabled = compilePrompt({ ...base, capabilities: chatCapabilities([], []) });
  assert.doesNotMatch(disabled.system, /TOOLS:/);
});
