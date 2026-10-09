import type { Content, ContextSelection, DataClass, FunctionDeclaration } from '../adapters/model/types.js';
export interface Owned { schemaVersion: 1; ownerId: string; dataClass: DataClass }
export interface Preferences extends Owned {
  /** Canonical explicit BCP47 locale, validated with Intl.Locale; not fluency proof. */
  language: string; register: 'plain' | 'formal';
  humor: 'off' | 'dry'; verbosity: 'brief' | 'balanced' | 'detailed';
}
declare const validated: unique symbol;
export type ValidatedPreferences = Readonly<Preferences> & { readonly [validated]: true };
export interface SourceAvailability { id: string; state: 'available' | 'missing' | 'error' }
export interface CapabilitySnapshot {
  readonly schemaVersion: 1; readonly declarations: readonly FunctionDeclaration[];
  readonly sources: readonly SourceAvailability[]; readonly hash: string;
}
export type Receipt = { status: 'committed'; durable: true; commitId: string; receiptId: string }
  | { status: 'failed' | 'pending' | 'unknown' };
export type Evidence = Owned & { id: string; sourceId: string; provenance: string; priority: number } &
  ({ kind: 'source'; text: string } | { kind: 'receipt'; receipt: Receipt });
export interface HistoryItem extends Owned { id: string; role: 'user' | 'model'; text: string }
export interface CompileInput {
  ownerId: string; persona: 'didi'; promptVersion: string;
  preferences: ValidatedPreferences; capabilities: CapabilitySnapshot;
  evidence: readonly Evidence[]; history: readonly HistoryItem[];
  budgets: { trustedChars: number; contextChars: number; historyChars: number };
}
export interface CompiledPrompt {
  system: string; promptVersion: string; dataClasses: DataClass[];
  context: ContextSelection; declarations: FunctionDeclaration[]; contents: Content[];
  manifest: {
    ownerId: string;
    sections: { id: string; chars: number; hash: string }[];
    systemHash: string; preferenceHash: string; capabilityHash: string;
    contextChars: number; historyChars: number; selectedIds: string[];
    omitted: { id: string; reason: 'oversized' | 'budget' }[];
    historyIds: string[]; savedReceiptIds: string[];
  };
}
export type ErrorCode = 'schema' | 'owner' | 'classification' | 'version' | 'budget' | 'duplicate' | 'snapshot' | 'invalid_locale';
export class PromptCompileError extends Error {
  constructor(readonly code: ErrorCode) { super(`Prompt compilation failed: ${code}`); this.name = 'PromptCompileError'; }
}
