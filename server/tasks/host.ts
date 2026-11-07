import { ServiceError } from '../contracts/errors.js';
import { readerFailure } from './results.js';
import type { ComposeDispatch, ComposeOutcome } from '../tools/types.js';
import type { VaultWriter } from '../tools/vault-write.js';
import { createHash } from 'node:crypto';
import { readPublishedCatalogues, type Store } from '../runtime/store.js';
import { join } from 'node:path';
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
  now?: () => number;
  store: Store; credentials: Credentials; models: RoleModels;
  bindings(): readonly BoundConnector[];
  draftChat?(input: Parameters<ComposeDispatch['draftChat']>[0], connectionIds?: readonly string[]): Promise<ComposeOutcome>;
  timeZone: string;
  executors?(sessionId: string): ExistingExecutors;
  web?: WebSearchPort;
  vault?: VaultWriter;
  infer?: Infer;
  effectCheck?: AuthorityPorts['checkEffect'];
  log?(event: Record<string, unknown>): void;
}
export type HostTaskFactory = (sessionId: string, delivery: Delivery, connectionIds?: readonly string[]) => TaskRuntime;
/**
 * M2: the zone this task's own session was composed in, read off the session row rather than resolved again
 * from the host process, so the helper prompt states the same instant the live instruction does. A text
 * session or a row without a recorded zone falls back to the configured zone.
 */
export function sessionClockZone(store: Store, sessionId: string): string | undefined {
  try {
    const row = store.transaction(tx => tx.get('SELECT time_zone FROM live_sessions WHERE live_session_id=?', [sessionId]));
    return String(row?.['time_zone'] ?? '') || undefined;
  } catch (error) {
    // A host store with no live table at all (text only) composes no live clock and the configured zone stands.
    // Anything else, a locked or corrupt store, is a real failure and is thrown, never read as "no session".
    if (error instanceof Error && /no such table: live_sessions\b/u.test(error.message)) return undefined;
    throw error;
  }
}

/** Production task composition. Store is the only writer; connector readers keep their own configured boundary. */
export function hostTaskFactory(options: HostTaskOptions): HostTaskFactory {
  const infer = options.infer ?? createModelPort({ role: options.models.worker, credentials: options.credentials });
  const checkEffect = options.effectCheck ?? createEffectRole({ role: options.models.effect_check, credentials: options.credentials });
  return (sessionId, delivery, connectionIds) => {
    const bindings = () => options.bindings().filter(binding => !connectionIds || connectionIds.includes(binding.policy.connectionId));
    const authority = new Authority({ checkEffect, journal: options.store.taskEffectJournal(),
      log: code => options.log?.({ event: 'task_effect_check', code }) });
    const existing = options.executors?.(sessionId) ?? {};
    const runtime = new TaskRuntime({ store: options.store, nativeSessionId: sessionId, delivery, authority, infer,
      timeZone: sessionClockZone(options.store, sessionId) ?? options.timeZone, ...(options.now ? { now: options.now } : {}), configuredTools: configuredCompanyTools(bindings(), readPublishedCatalogues(join(options.store.directory, 'state.sqlite'))), ...(options.log ? { log: options.log } : {}),
      execute: async (name, args, signal, exposed, identity) => {
        if (signal.aborted) return failed('This revision was cancelled. Use the current task.');
        if (existing[name]) return existing[name]!(args, signal, { identity, outsideTextSeen: exposed ?? false });
        if (name === 'draft_chat') {
          if (!options.draftChat || !identity) return failed('Mattermost drafts are not configured. Configure the Mattermost draft connector; nothing was saved.');
          const target = String(args.target).trim(), thread = /^thread:([^:]+):([^:]+)$/.exec(target);
          const destination = thread ? { channel: thread[1]!, rootId: thread[2]! } : target.startsWith('#') ? { channel: target.slice(1) } : target.startsWith('@') ? { person: target.slice(1) } : undefined;
          if (!destination) return failed('Resolve the target to an exact Mattermost @username, #channel or thread:<channel-id>:<root-post-id>. Nothing was saved.');
          const outcome = await options.draftChat({ ...destination, message: String(args.text), clientRequestId: identity.operation_id }, connectionIds);
          if (outcome.state === 'done') return documentResult(JSON.stringify(outcome.response), 'mattermost-draft');
          if (outcome.state === 'unknown') throw Error('Mattermost draft acknowledgement is unknown; check the reply box before retrying.');
          return failed(outcome.state === 'not_authorized' ? 'Mattermost drafts are not configured or authorized. Configure the Mattermost draft connector; nothing was saved.' : outcome.state === 'recipient' ? 'The Mattermost target is unresolved or ambiguous. Use its exact username or channel id; nothing was saved.' : 'Mattermost did not save the draft: ' + outcome.reason);
        }
        if (name === 'remember_note') {
          const now = Date.now(), clock = { now: () => now };
          return options.store.transaction(tx => {
            const session = memory.createSession(tx, { title: typeof args.title === 'string' ? args.title : 'Task note', startedAt: now, timeZone: options.timeZone }, clock);
            const entry = memory.appendEntry(tx, { sessionId: session.id, text: String(args.text), capturedAt: now, timeZone: options.timeZone,
              source: { label: 'task note', provider: 'live-voice', accountId: sessionId, externalId: `${identity?.task_id}:${identity?.operation_id}`, sourceTimestamp: now, availability: 'present', note: 'kind:fact' } }, clock);
            labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'private' }, now);
            labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'private' }, now);
            return { status: 'ok', text: 'Saved to local notes.', references: [{ id: entry.id }], next_cursor: null, coverage: 'One note committed.', repair: null };
          });
        }
        if (name === 'vault_save' || name === 'vault_update') {
          if (!options.vault) return failed('The vault write port is unavailable. Nothing was saved.');
          const write = options.vault.writeTask({ sessionId, tool: name, args }).then(receipt => documentResult(JSON.stringify(receipt), 'vault-receipt'));
          // Cancellation stops waiting, not a write that may already have reached lux.
          let onAbort: (() => void) | undefined;
          const pending = new Promise<ReturnType<typeof documentResult>>(resolve => {
            onAbort = () => resolve(documentResult(JSON.stringify({ disposition: 'pending' }), 'vault-receipt'));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          });
          try { return await Promise.race([write, pending]); }
          finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
        }
        if (name === 'search_memory') return documentResult(JSON.stringify(options.store.transaction(tx => memory.recall(tx, String(args.query)))), 'local-memory');
        if (name === 'read_memory') {
          try {
            const entry = options.store.transaction(tx => memory.readEntry(tx, String(args.ref)));
            return documentResult(entry.text, entry.id, typeof args.cursor === 'string' ? args.cursor : '0');
          } catch (error) { return readerFailure(name, error instanceof ServiceError && error.code === 'NOT_FOUND' ? 'not_found' : 'upstream_error'); }
        }
        const bound = bindings();
        const writes: Record<string, { tool: string; arguments: Record<string, unknown> }> = {
          draft_email: { tool: 'gmail_create_draft', arguments: { to: args.to, subject: args.subject, body: args.body } },
          create_event: { tool: 'calendar_create_event', arguments: { summary: args.title, start: args.start, end: args.end, timeZone: options.timeZone,
            clientRequestId: createHash('sha256').update(`${identity?.task_id}:${canonical(args)}`).digest('hex') } },
          delete_event: { tool: 'calendar_delete_event', arguments: { eventId: args.id } },
        };
        const write = writes[name];
        if (write) {
          const binding = bound.find(item => item.connector === 'google' && item.policy.toolNames.includes(write.tool));
          if (!binding) return failed('This Google write capability is not configured. Nothing was written.');
          const result = await binding.reader.call(write.tool, write.arguments, signal);
          return result.state === 'completed' ? documentResult(JSON.stringify(result.decodedResult), name) : failed('The connector did not acknowledge this write. Report the unresolved outcome rather than retrying blindly.');
        }
        if (name === 'search_web' && options.web) {
          const result = await options.web.search({ query: String(args.query), signal, exposed: !!exposed });
          return documentResult(JSON.stringify(result), 'web');
        }
        const execute = connectorExecutor(bound, existing);
        return execute(name, args, signal, exposed, identity);
      },
    });
    return runtime;
  };
}
