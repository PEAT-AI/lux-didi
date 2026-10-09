import type { ToolDefinition } from '../adapters/model/types.js';
import { PromptCompileError, type CapabilitySnapshot, type CompileInput, type CompiledPrompt, type SourceAvailability, type ValidatedPreferences } from './types.js';
export * from './types.js';
export const PUBLIC_PERSONA = '';
export const PROMPT_VERSION = 'unimplemented';
export function validatePreferences(_raw: unknown, _ownerId: string): ValidatedPreferences { throw new PromptCompileError('schema'); }
export function createCapabilitySnapshot(_registry: readonly ToolDefinition[], _sources: readonly SourceAvailability[]): CapabilitySnapshot { throw new PromptCompileError('snapshot'); }
export function compilePrompt(_input: CompileInput): CompiledPrompt { throw new PromptCompileError('schema'); }
