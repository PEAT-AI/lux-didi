import { randomUUID } from 'node:crypto';
import type { StorePort, Transaction } from '../contracts/storage.js';
import { Outbox } from '../runtime/outbox.js';
import type { HostContext } from '../adapters/model/types.js';
import type { LiveAuthority } from './types.js';
import type { runToolCalls } from './declarations.js';

export type ToolJobResult = Awaited<ReturnType<typeof runToolCalls>>;
export interface ToolJob {
  id: string;
  originSessionId: string;
  state: 'in_progress' | 'completed' | 'failed' | 'unknown';
  createdAt: number;
  host: HostContext;
  authority: LiveAuthority;
  result?: ToolJobResult;
  deliverySessionId?: string;
  delivered: boolean;
  deferred: boolean;
}
export type JobTimer = (callback: () => void, ms: number) => { unref(): void; cancel(): void };
const prefix = 'live-job:';

/** Outbox-backed execution receipts, not a replay queue. Store reopen turns claims into unknown. */
export class LiveToolJobs {
  constructor(private readonly store: StorePort, private readonly now: () => number) {}

  list(tx?: Transaction): ToolJob[] {
    const read = (tx: Transaction): ToolJob[] => {
      // Match the outbox's unknown-on-expired-claim rule without claiming unrelated reminder work.
      tx.run("UPDATE runtime_outbox SET state='unknown',claim_token=NULL,lease_until=NULL WHERE entity_id LIKE ? AND state='claimed' AND lease_until<=?", [`${prefix}%`, this.now()]);
      return tx.all('SELECT id,payload,state FROM runtime_outbox WHERE entity_id LIKE ? ORDER BY due_at,id', [`${prefix}%`])
      .map(row => {
        const job = JSON.parse(String(row.payload)) as ToolJob;
        if (row.state === 'unknown') return { ...job, state: 'unknown' as const };
        return job;
      });
    };
    return tx ? read(tx) : this.store.transaction(read);
  }

  pending(tx?: Transaction): ToolJob[] { return this.list(tx).filter(job => job.deferred && !job.delivered); }
  forSession(sessionId: string, tx?: Transaction): ToolJob | undefined { return this.list(tx).find(job => job.deliverySessionId === sessionId); }

  save(job: ToolJob, tx?: Transaction): void {
    const write = (tx: Transaction): void => {
      tx.run('UPDATE runtime_outbox SET payload=? WHERE id=?', [JSON.stringify(job), job.id]);
    };
    if (tx) write(tx); else this.store.transaction(write);
  }

  async run(host: HostContext, authority: LiveAuthority, budgetMs: number, schedule: JobTimer,
    work: () => Promise<ToolJobResult>): Promise<{ job: ToolJob; result?: ToolJobResult }> {
    const id = randomUUID(), now = this.now();
    const job: ToolJob = { id, originSessionId: host.runId, state: 'in_progress', createdAt: now,
      host: structuredClone(host), authority: structuredClone(authority), delivered: false, deferred: false };
    this.store.transaction(tx => {
      Outbox.insert(tx, { id, entityId: `${prefix}${id}`, entityRevision: 1, authorityEpoch: host.authorityEpoch,
        requiredGrant: 'live-tool-job', payload: JSON.stringify(job), sourceTimeZone: 'UTC',
        dueAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString() });
      tx.run("UPDATE runtime_outbox SET state='claimed',claim_token=?,lease_until=? WHERE id=?", [id, now + 86_400_000, id]);
    });
    let timer: ReturnType<JobTimer> | undefined;
    const completion = Promise.resolve().then(work).then(result => {
      job.result = result;
      job.state = result.tools.some(tool => tool.status === 'unknown') ? 'unknown'
        : result.error || result.tools.some(tool => tool.status !== 'completed') ? 'failed' : 'completed';
      this.finish(job);
      return result;
    }, () => {
      job.state = 'failed';
      this.finish(job);
      return undefined;
    });
    const timeout = new Promise<undefined>(resolve => { timer = schedule(() => resolve(undefined), budgetMs); timer.unref(); });
    const result = await Promise.race([completion, timeout]);
    timer?.cancel();
    if (!result) { job.deferred = true; this.save(job); }
    // Returning a batch is not delivery; the Live owner acknowledges the transport handoff.
    // Observe persistence failures even after deferral; the durable claim then remains unknown on reopen.
    void completion.catch(() => undefined);
    return { job, ...(result ? { result } : {}) };
  }

  private finish(job: ToolJob): void {
    this.store.transaction(tx => {
      tx.run("UPDATE runtime_outbox SET payload=?,state=?,claim_token=NULL,lease_until=NULL WHERE id=? AND state='claimed' AND claim_token=?",
        [JSON.stringify(job), job.state === 'completed' ? 'acknowledged' : job.state === 'unknown' ? 'unknown' : 'failed', job.id, job.id]);
    });
  }
}
