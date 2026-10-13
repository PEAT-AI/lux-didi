const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export interface MemorySourceRef {
  label?: string;
  provider?: string;
  accountId?: string;
  externalId?: string;
  sourceTimestamp?: string | null;
  availability?: 'present' | 'missing';
  note?: string;
}

/** The owner list route shape: kind is either the source note (`kind:<x>`) or the entry role. */
export interface MemoryListItem {
  id: string;
  text?: string;
  snippet?: string;
  role?: string;
  capturedAt?: string | null;
  sourceTimestamp?: string | null;
  sourceRefs?: MemorySourceRef[];
}

const KIND_NOTE = /(?:^|\s)kind:([a-z]+)/i;
const createdAt = (item: MemoryListItem) => item.capturedAt ?? item.sourceTimestamp ?? '';

/** The domain carries the Live remember kind in the source note; every other entry keeps its role. */
export function memoryItemKind(item: MemoryListItem): string {
  const note = item.sourceRefs?.map(ref => ref.note).find(note => note && KIND_NOTE.test(note));
  const carried = note?.match(KIND_NOTE)?.[1];
  if (carried) return carried.toLowerCase();
  return item.role ?? 'note';
}

/** Name the origin only when the payload carries it: Live voice, otherwise the source label. */
export function memoryItemSource(item: MemoryListItem): string | null {
  const ref = item.sourceRefs?.find(ref => ref.provider ?? ref.label);
  if (!ref) return null;
  if (ref.provider === 'live-voice') return 'Live voice via remember_note';
  return ref.label ?? ref.provider ?? null;
}

export function memoryItemText(item: MemoryListItem): string {
  return item.text ?? item.snippet ?? '';
}

/** Local calendar time, never the raw ISO string the service returns. */
export function memoryItemCreated(item: MemoryListItem): string | null {
  const value = createdAt(item);
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : null;
}

/** Narrow the already-fetched list in the browser; nothing is sent to the service. */
export function filterMemoryItems<T extends MemoryListItem>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];
  return items.filter(item => [memoryItemText(item), memoryItemKind(item), memoryItemSource(item) ?? ''].join(' ').toLowerCase().includes(needle));
}

const newestFirst = <T extends MemoryListItem>(items: T[]): T[] => [...items].sort((a, b) => Date.parse(createdAt(b)) - Date.parse(createdAt(a)));

export function memoryListItemMarkup(item: MemoryListItem, disabled = false): string {
  const kind = memoryItemKind(item);
  const source = memoryItemSource(item);
  const created = memoryItemCreated(item);
  const stamp = createdAt(item);
  return `<article class="memory-item" data-memory-id="${escape(item.id)}"><header class="memory-meta"><span class="memory-kind">${escape(kind)}</span>${source ? `<span class="memory-source">${escape(source)}</span>` : ''}${created ? `<time datetime="${escape(stamp)}">${escape(created)}</time>` : ''}</header><p>${escape(memoryItemText(item))}</p>${memoryDeleteControl(item.id, disabled)}</article>`;
}

/** Render the page's whole memory list: count, client-side filter box, newest-first items, honest empty state. */
export function memoryListMarkup(items: MemoryListItem[], options: { filter?: string; disabled?: boolean } = {}): string {
  const filter = options.filter ?? '';
  const visible = filterMemoryItems(newestFirst(items), filter);
  const head = `<div class="memory-list-head"><h2>Your memories</h2><p class="memory-count" aria-live="polite">${items.length} ${items.length === 1 ? 'memory' : 'memories'}</p></div><input type="search" id="memory-filter" class="memory-filter" value="${escape(filter)}" placeholder="Filter memories" aria-label="Filter memories">`;
  if (!items.length) return `<section class="panel memory-list" aria-label="Memory list">${head}<p class="memory-empty">Didi remembers nothing yet.</p></section>`;
  if (!visible.length) return `<section class="panel memory-list" aria-label="Memory list">${head}<p class="memory-empty">No memories match your filter.</p></section>`;
  return `<section class="panel memory-list" aria-label="Memory list">${head}${visible.map(item => memoryListItemMarkup(item, options.disabled)).join('')}</section>`;
}

export function memoryDeleteControl(id: string, disabled = false): string {
  return `<button type="button" class="quiet memory-delete" data-delete-memory="${escape(id)}" ${disabled ? 'disabled' : ''}>Delete memory</button>`;
}

/** Keep the existing payload until both deletion and the authoritative reload succeed. */
export async function deleteMemoryAndReload<T>(id: string, actions: {
  confirm: () => boolean;
  remove: (id: string) => Promise<unknown>;
  reload: () => Promise<T>;
  apply: (payload: T) => void;
  deleted?: (message: string) => void;
}): Promise<boolean> {
  if (!actions.confirm()) return false;
  const response = await actions.remove(id);
  const payload = await actions.reload();
  actions.apply(payload);
  const retained = response !== null && typeof response === 'object'
    && 'liveSessionRetainsUntilRebuild' in response && response.liveSessionRetainsUntilRebuild === true;
  actions.deleted?.(retained
    ? "Naya's current live conversation still has this note until it reconnects or ends."
    : 'Memory deleted.');
  return true;
}

/** Extend the frozen selected-memory view without owning or filtering its records. */
export function attachMemoryDeleteControls(root: HTMLElement, disabled: boolean, remove: (id: string) => void): void {
  root.querySelectorAll<HTMLElement>('[data-selected-id], [data-result-id]').forEach(row => {
    const id = row.dataset.selectedId ?? row.dataset.resultId;
    if (id && !row.querySelector('[data-delete-memory]')) row.insertAdjacentHTML('beforeend', memoryDeleteControl(id, disabled));
  });
  root.querySelectorAll<HTMLButtonElement>('[data-delete-memory]').forEach(button => {
    button.disabled = disabled;
    button.onclick = () => remove(button.dataset.deleteMemory!);
  });
}
