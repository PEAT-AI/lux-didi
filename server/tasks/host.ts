import type { VaultWriter } from '../tools/vault-write.js';
import { createHash } from 'node:crypto';
import type { Store } from '../runtime/store.js';
import type { Credentials } from '../adapters/model/types.js';
import type { WebSearchPort } from '../tools/web-search.js';
import * as memory from '../domain/memory.js';
import * as labels from '../domain/labels.js';
import { Authority, type AuthorityPorts } from './authority.js';
import type { Delivery } from './controller.js';
import { connectorExecutor, configuredCompanyTools, type BoundConnector, type ExistingExecutors } from './connectors.js';
import { createEffectRole, createModelPort, type RoleModels } from './model.js';
import { documentResult, failed } from './results.js';
import { TaskRuntime } from './runtime.js';
import { canonical, type Infer } from './worker.js';
export interface HostTaskOptions {
  store: Store; credentials: Credentials; models: RoleModels;
  bindings(): readonly BoundConnector[];
  contentAllowed(): boolean;
  timeZone: string;
  executors?(sessionId: string): ExistingExecutors;
  web?: WebSearchPort;
  vault?: VaultWriter;
  infer?: Infer;
  effectCheck?: AuthorityPorts['checkEffect'];
  log?(event: Record<string, unknown>): void;
}
/** Production task composition. Store is the only writer; connector readers keep their own configured boundary. */
export function hostTaskFactory(options: HostTaskOptions): (sessionId: string, delivery: Delivery) => TaskRuntime {
  const infer = options.infer ?? createModelPort({ role: options.models.worker, credentials: options.credentials });
  const checkEffect = options.effectCheck ?? createEffectRole({ role: options.models.effect_check, credentials: options.credentials });
  return (sessionId, delivery) => {
    const authority = new Authority({ checkEffect, journal: options.store.taskEffectJournal(options.contentAllowed),
      log: code => options.log?.({ event: 'task_effect_check', code }) });
    const existing = options.executors?.(sessionId) ?? {};
    const runtime = new TaskRuntime({ store: options.store, delivery, authority, infer, contentAllowed: options.contentAllowed,
      configuredTools: configuredCompanyTools(options.bindings()), ...(options.log ? { log: options.log } : {}),
      execute: async (name, args, signal, exposed, identity) => {
        if (signal.aborted) return failed('This revision was cancelled. Use the current task.');
        if (existing[name]) return existing[name]!(args, signal, { identity, outsideTextSeen: exposed ?? false });
        if (name === 'remember_note' || name === 'draft_chat' || name === 'stage_lux_note') {
          const now = Date.now(), clock = { now: () => now };
          return options.store.transaction(tx => {
            const session = memory.createSession(tx, { title: name === 'draft_chat' ? `Draft for ${String(args.target)}` : typeof args.title === 'string' ? args.title : 'Task note', startedAt: now, timeZone: options.timeZone }, clock);
            const entry = memory.appendEntry(tx, { sessionId: session.id, text: String(args.text), capturedAt: now, timeZone: options.timeZone,
              source: { label: 'task note', provider: 'live-voice', accountId: sessionId, externalId: `${identity?.task_id}:${identity?.operation_id}`, sourceTimestamp: now, availability: 'present', note: 'kind:fact' } }, clock);
            labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'private' }, now);
            labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'private' }, now);
            return { status: 'ok', text: name === 'draft_chat' ? 'Draft saved locally. Nothing was sent.' : name === 'stage_lux_note' ? 'Knowledge note staged locally. Not sent to the vault.' : 'Saved to local notes.', references: [{ id: entry.id }], next_cursor: null, coverage: 'One note committed.', repair: null };
          });
        }
        if (name === 'save_to_vault') {
          if (!options.vault || !identity) return failed('The vault write port or task identity is unavailable. Nothing was saved.');
          const receipt = await options.vault.saveTask({ sessionId, identity, content: String(args.text), title: String(args.title), outsideTextSeen: exposed ?? false });
          if (receipt.saved) return documentResult(JSON.stringify(receipt), 'vault-receipt');
          return { ...failed(receipt.guidance ?? 'The vault did not confirm this save.'), receipt: { operation_id: identity.operation_id, state: receipt.code === 'outcome_unknown' ? 'unknown' : 'failed' } };
        }
        if (name === 'search_memory') return documentResult(JSON.stringify(options.store.transaction(tx => memory.recall(tx, String(args.query)))), 'local-memory');
        if (name === 'read_memory') {
          const entry = options.store.transaction(tx => memory.readEntry(tx, String(args.ref)));
          return documentResult(entry.text, entry.id, typeof args.cursor === 'string' ? args.cursor : '0');
        }
        const bindings = options.bindings();
        const writes: Record<string, { tool: string; arguments: Record<string, unknown> }> = {
          draft_email: { tool: 'gmail_create_draft', arguments: { to: args.to, subject: args.subject, body: args.body } },
          create_event: { tool: 'calendar_create_event', arguments: { summary: args.title, start: args.start, end: args.end, timeZone: options.timeZone,
            clientRequestId: createHash('sha256').update(`${identity?.task_id}:${canonical(args)}`).digest('hex') } },
          delete_event: { tool: 'calendar_delete_event', arguments: { eventId: args.id } },
        };
        const write = writes[name];
        if (write) {
          const binding = bindings.find(item => item.connector === 'google' && item.policy.toolNames.includes(write.tool));
          if (!binding) return failed('This Google write capability is not configured. Nothing was written.');
          const result = await binding.reader.call(write.tool, write.arguments, signal);
          return result.state === 'completed' ? documentResult(JSON.stringify(result.decodedResult), name) : failed('The connector did not acknowledge this write. Report the unresolved outcome rather than retrying blindly.');
        }
        if (name === 'search_web' && options.web) {
          const result = await options.web.search({ query: String(args.query), signal, exposed: !!exposed });
          return documentResult(JSON.stringify(result), 'web');
        }
        const execute = connectorExecutor(bindings, existing);
        return execute(name, args, signal, exposed, identity);
      },
    });
    return runtime;
  };
}
