import type { Transaction } from '../contracts/storage.js';
import type { JsonObject } from '../adapters/model/types.js';

/** This identity belongs to the gateway, never to a remote MCP declaration. */
export const REMEMBER_IDENTITY = { name: 'remember_note', accountId: 'gateway:live-voice', resourceId: 'owner-memory' } as const;
export const REMEMBER_PARAMETERS = { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 500, description: 'The note in the owner’s own words.' }, kind: { type: 'string', enum: ['fact', 'preference', 'task'], description: 'fact, preference or task.' } }, required: ['text', 'kind'], additionalProperties: false };
export function validateRemember(args: unknown): args is { text: string; kind: 'fact' | 'preference' | 'task' } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const value = args as Record<string, unknown>;
  return Object.keys(value).length === 2 && typeof value.text === 'string' && value.text.length >= 1 && value.text.length <= 500
    && typeof value.kind === 'string' && ['fact', 'preference', 'task'].includes(value.kind);
}

export type RememberNoteArgs = { text: string; kind: 'fact' | 'preference' | 'task' };
/** Live supplies the domain boundary; the tools package owns no domain dependencies. */
export type RememberNotePort = (tx: Transaction, liveSessionId: string, args: RememberNoteArgs) => JsonObject;
