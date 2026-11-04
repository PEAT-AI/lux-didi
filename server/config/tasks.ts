import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseJson, readPrivate } from './files.js';
import { slotFor } from './index.js';
import { DEFAULT_WORKER_MODEL, DEFAULT_WORKER_EFFORT, type ModelRole, type RoleModels } from '../tasks/model.js';
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** One model configuration per role; voice-provider selection does not change either default. */
export function resolveTaskModels(value: unknown): RoleModels {
  if (value !== undefined && (!object(value) || Object.keys(value).some(key => key !== 'worker' && key !== 'effect_check'))) throw new Error('invalid_task_models');
  const config = value as Record<string, unknown> | undefined;
  const role = (input: unknown): ModelRole => {
    if (input !== undefined && (!object(input) || Object.keys(input).some(key => !['provider', 'model', 'effort', 'keyReference'].includes(key)))) throw new Error('invalid_task_role');
    const fields = input as Record<string, unknown> | undefined;
    const provider = fields?.provider ?? 'openai';
    if (provider !== 'openai' && provider !== 'gemini') throw new Error('invalid_task_provider');
    const model = fields?.model ?? (provider === 'gemini' ? 'gemini-3.8-flash' : DEFAULT_WORKER_MODEL);
    const effort = fields?.effort ?? DEFAULT_WORKER_EFFORT;
    const keyReference = fields?.keyReference ?? slotFor(provider).keyReference;
    if (typeof model !== 'string' || !model.trim() || typeof keyReference !== 'string' || !keyReference.trim()
      || !['low', 'medium', 'high'].includes(String(effort))) throw new Error('invalid_task_role');
    return { provider, model, effort: effort as ModelRole['effort'], keyReference };
  };
  return { worker: role(config?.worker), effect_check: role(config?.effect_check) };
}
export function loadTaskModels(configDir: string): RoleModels {
  const path = join(configDir, 'tasks.json');
  return resolveTaskModels(existsSync(path) ? parseJson(readPrivate(path, 16_384)) : undefined);
}
