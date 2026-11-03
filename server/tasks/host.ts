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
import { documentResult, failed, type ToolResult } from './results.js';
import { TaskRuntime } from './runtime.js';
import { canonical, type Infer } from './worker.js';
export interface HostTaskOptions {
  store: Store; credentials: Credentials; models: RoleModels;
  bindings(): readonly BoundConnector[];
  contentAllowed(): boolean;
  timeZone: string;
  existing?: ExistingExecutors;
  web?: WebSearchPort;
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
    const runtime = new TaskRuntime({ store: options.store, delivery, authority, infer, contentAllowed: options.contentAllowed,
      configuredTools: configuredCompanyTools(options.bindings()), ...(options.log ? { log: options.log } : {}),
      execute: async (name, args, signal, exposed, identity) => {
        if (signal.aborted) return failed('This revision was cancelled. Use the current task.');
        if (name === 'remember_note') {
          const now = Date.now(), clock = { now: () => now };
          return options.store.transaction(tx => {
            const session = memory.createSession(tx, { title: 'Task note', startedAt: now, timeZone: options.timeZone }, clock);
            const entry = memory.appendEntry(tx, { sessionId: session.id, text: String(args.text), capturedAt: now, timeZone: options.timeZone,
              source: { label: 'task note', provider: 'live-voice', accountId: sessionId, externalId: `${identity?.task_id}:${identity?.operation_id}`, sourceTimestamp: now, availability: 'present', note: 'kind:fact' } }, clock);
            labels.correct(tx, { subject: { kind: 'session', id: session.id }, expectedRevision: 0, dataClass: 'private' }, now);
            labels.correct(tx, { subject: { kind: 'entry', id: entry.id }, expectedRevision: 0, dataClass: 'private' }, now);
            return { status: 'ok', text: 'Saved to local notes.', references: [{ id: entry.id }], next_cursor: null, coverage: 'One note committed.', repair: null };
          });
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
          const binding = bindings.find(item => item.connector === 'google');
          if (!binding) return failed('This Google write capability is not configured. Nothing was written.');
          const result = await binding.reader.call(write.tool, write.arguments, signal);
          return result.state === 'completed' ? documentResult(JSON.stringify(result.decodedResult), name) : failed('The connector did not acknowledge this write. Report the unresolved outcome rather than retrying blindly.');
        }
        if (name === 'search_web' && options.web) {
          const result = await options.web.search({ query: String(args.query), signal, exposed: !!exposed });
          return documentResult(JSON.stringify(result), 'web');
        }
        const execute = connectorExecutor(bindings, options.existing);
        return execute(name, args, signal, exposed, identity);
      },
    });
    return runtime;
  };
}
