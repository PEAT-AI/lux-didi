/**
 * Build a synthetic state store for the memory test from `fixture.json`.
 *
 * The store is written through the same migrations and domain writer the host
 * uses, so the harness scores real tables rather than a hand-made schema. Two
 * variants exist: `defect` keeps the two planted defects, `clean` repairs them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../../runtime/store.js';
import { domainMigrations } from '../../../domain/schema.js';
import { liveMigrations } from '../../../live/schema.js';
import * as memory from '../../../domain/memory.js';
import * as summaries from '../../../domain/summaries.js';
import { recordHistorySession } from '../../../domain/history-lifecycle.js';

export type FixtureVariant = 'defect' | 'clean';

interface FixtureEntry { id: string; text: string; capturedAt: string; forget?: boolean; defectOnly?: boolean }
interface FixtureTurn { id: number; role: 'owner' | 'assistant'; text: string; at: string }
interface FixtureSession {
  id: string;
  startedAt: string;
  endedAt: string;
  turns: FixtureTurn[];
  memorySession: { id: string; title: string; entries: FixtureEntry[] };
  summary?: { defect: string; clean: string };
}
interface Fixture { timeZone: string; liveSessions: FixtureSession[] }

export const FIXTURE_DIR = join(process.cwd(), 'server', 'test', 'fixtures', 'memory-eval');
export const GOLDEN_FILE = join(FIXTURE_DIR, 'golden.jsonl');
export function answersFile(variant: FixtureVariant): string {
  return join(FIXTURE_DIR, variant === 'defect' ? 'answers.json' : 'answers-clean.json');
}

const CLOCK = { now: () => Date.parse('2026-11-06T08:30:00Z') };

/** Build the store at `directory` (created empty by the caller) for one variant. */
export function buildEvalStore(directory: string, variant: FixtureVariant): Store {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, 'fixture.json'), 'utf8')) as Fixture;
  const store = new Store(directory, [...domainMigrations, ...liveMigrations]);
  store.transaction(tx => {
    const ownerId = store.assistantId;
    for (const session of fixture.liveSessions) {
      const endedAt = Date.parse(session.endedAt);
      const startedAt = Date.parse(session.startedAt);
      tx.run(
        `INSERT INTO live_sessions (live_session_id, owner_assistant_id, authority_epoch, idempotency_key, fingerprint,
            client_id, audit_id, profile_identity, prompt_identity, lifecycle, dispatch_intent, ready, journal_events, journal_bytes,
            journal_complete, consumer_state, terminal_outcome, terminal_at, created_at, updated_at, memory_provenance)
          VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,1,'ended',?,?,?,?,NULL)`,
        [session.id, ownerId, store.authorityEpoch, `key-${session.id}`, `fp-${session.id}`, 'client', `audit-${session.id}`,
          'profile', 'prompt', 'terminal', JSON.stringify({ state: 'closed', code: 'normal' }), endedAt, startedAt, endedAt],
      );
      recordHistorySession(tx, session.id, ownerId, ['ordinary'], [], startedAt);
      tx.run("INSERT INTO routing_labels(subject_kind,subject_id,revision,data_class,writer,recorded_at) VALUES('session',?,1,'ordinary','owner_review',?)",
        [session.id, startedAt]);
      for (const turn of session.turns) {
        tx.run('INSERT INTO history_turns(id,live_session_id,journal_first,journal_last,role,text,at) VALUES(?,?,?,?,?,?,?)',
          [turn.id, session.id, turn.id, turn.id, turn.role, turn.text, Date.parse(turn.at)]);
        tx.run('INSERT INTO history_turns_fts(rowid,text) VALUES(?,?)', [turn.id, turn.text]);
      }
      const durable = memory.createSession(tx, {
        title: session.memorySession.title, startedAt, endedAt, timeZone: fixture.timeZone,
      }, CLOCK, session.memorySession.id);
      tx.run("INSERT INTO routing_labels(subject_kind,subject_id,revision,data_class,writer,recorded_at) VALUES('session',?,1,'ordinary','owner_review',?)",
        [durable.id, startedAt]);
      for (const entry of session.memorySession.entries) {
        if (entry.defectOnly === true && variant === 'clean') continue;
        const capturedAt = Date.parse(entry.capturedAt);
        memory.appendEntry(tx, { sessionId: durable.id, text: entry.text, capturedAt, timeZone: fixture.timeZone }, CLOCK, entry.id);
        tx.run("INSERT INTO routing_labels(subject_kind,subject_id,revision,data_class,writer,recorded_at) VALUES('entry',?,1,'ordinary','owner_review',?)",
          [entry.id, capturedAt]);
        if (entry.forget === true) memory.deleteEntry(tx, entry.id, new Date(capturedAt).toISOString(), 'owner');
      }
      if (session.summary !== undefined) {
        const summary = session.summary[variant];
        summaries.insertSummary(tx, {
          liveSessionId: session.id, status: 'complete', summary, dataClass: 'ordinary', sourceRevision: 1,
          endedAt, promptVersion: 'synthetic', model: 'synthetic', inputChars: summary.length, now: CLOCK.now(),
        });
      }
    }
  });
  return store;
}
