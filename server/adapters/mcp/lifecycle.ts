import { AsyncLocalStorage } from 'node:async_hooks';

/** One tool's adapter entries, including child reads, never another concurrent run's. */
class ResultScope {
  private readonly releases = new Set<() => void>();
  released = false;
  failureCode: 'result_store_full' | 'result_store_oversize' | 'result_store_unavailable' | undefined;
  run<T>(operation: () => T): T { return current.run(this, operation); }
  retain(release: () => void): void {
    if (this.released) release();
    else this.releases.add(release);
  }
  release(): void {
    this.released = true;
    for (const release of this.releases) release();
    this.releases.clear();
  }
}
const current = new AsyncLocalStorage<ResultScope>();
export function createResultScope(): ResultScope { return new ResultScope(); }
export function currentResultScope(): ResultScope | undefined { return current.getStore(); }
