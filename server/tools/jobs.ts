import { randomUUID } from 'node:crypto';
import type { StorePort } from '../contracts/storage.js';
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
}
export type JobTimer = (callback: () => void, ms: number) => { unref(): void; cancel(): void };
const prefix = 'live-job:';

/** Outbox-backed execution receipts, not a replay queue. Store reopen turns claims into unknown. */
export class LiveToolJobs {
  constructor(private readonly store: StorePort, private readonly now: () => number) {}

  list(): ToolJob[] {
    return this.store.transaction(tx => tx.all('SELECT id,payload,state FROM runtime_outbox WHERE entity_id LIKE ? ORDER BY due_at,id', [`${prefix}%`])
      .map(row => {
        const job = JSON.parse(String(row.payload)) as ToolJob;
        if (row.state === 'unknown') return { ...job, state: 'unknown' as const };
        return job;
      }));
  }

  pending(): ToolJob[] { return this.list().filter(job => !job.delivered); }
  forSession(sessionId: string): ToolJob | undefined { return this.list().find(job => job.deliverySessionId === sessionId); }

  save(job: ToolJob): void {
    this.store.transaction(tx => {
      tx.run('UPDATE runtime_outbox SET payload=? WHERE id=?', [JSON.stringify(job), job.id]);
    });
  }

  async run(host: HostContext, authority: LiveAuthority, budgetMs: number, schedule: JobTimer,
    work: () => Promise<ToolJobResult>): Promise<{ job: ToolJob; result?: ToolJobResult }> {
    const id = randomUUID(), now = this.now();
    const job: ToolJob = { id, originSessionId: host.runId, state: 'in_progress', createdAt: now,
      host: structuredClone(host), authority: structuredClone(authority), delivered: false };
    this.store.transaction(tx => {
      Outbox.insert(tx, { id, entityId: `${prefix}${id}`, entityRevision: 1, authorityEpoch: host.authorityEpoch,
        requiredGrant: 'live-tool-job', payload: JSON.stringify(job), sourceTimeZone: 'UTC',
        dueAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString() });
      tx.run("UPDATE runtime_outbox SET state='claimed',claim_token=?,lease_until=? WHERE id=?", [id, now + 86_400_000, id]);
    });
    let timer: ReturnType<JobTimer> | undefined;
    const completion = Promise.resolve().then(work).then(result => {
      job.result = result;
      job.state = result.error ? 'failed' : 'completed';
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
    if (result) { job.delivered = true; this.save(job); }
    // Observe persistence failures even after deferral; the durable claim then remains unknown on reopen.
    void completion.catch(() => undefined);
    return { job, ...(result ? { result } : {}) };
  }

  private finish(job: ToolJob): void {
    this.store.transaction(tx => {
      tx.run("UPDATE runtime_outbox SET payload=?,state=?,claim_token=NULL,lease_until=NULL WHERE id=? AND state='claimed' AND claim_token=?",
        [JSON.stringify(job), job.state === 'completed' ? 'acknowledged' : 'failed', job.id, job.id]);
    });
  }
}
