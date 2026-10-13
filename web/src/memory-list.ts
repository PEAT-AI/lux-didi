const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** The owner list route shape: the domain carries an explicit kind and origin per entry. */
export interface MemoryListItem {
  id: string;
  text?: string;
  snippet?: string;
  role?: string;
  kind?: string;
  origin?: string;
  capturedAt?: string | null;
  sourceTimestamp?: string | null;
}

const REAL_KINDS = new Set(['fact', 'preference', 'task']);
const createdAt = (item: MemoryListItem) => item.capturedAt ?? item.sourceTimestamp ?? '';

/** The explicit kind the domain already carries; `note` when none was given. */
export function memoryItemKind(item: MemoryListItem): string {
  return item.kind ?? 'note';
}

/** The badge kind: only a real remember kind earns a badge, `note` shows none (W-FIX2). */
export function memoryItemKindNote(item: MemoryListItem): string | null {
  return item.kind && REAL_KINDS.has(item.kind) ? item.kind : null;
}

/** The origin line: every entry names where it came from, `unknown` included. */
export function memoryItemOrigin(item: MemoryListItem): string {
  switch (item.origin) {
    case 'live-voice': return 'Live voice via remember_note';
    case 'chat': return 'Saved from chat';
    case 'page': return 'Saved from the page';
    default: return 'Origin unknown';
  }
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
  return items.filter(item => [memoryItemText(item), memoryItemKind(item), memoryItemOrigin(item)].join(' ').toLowerCase().includes(needle));
}

const newestFirst = <T extends MemoryListItem>(items: T[]): T[] => [...items].sort((a, b) => Date.parse(createdAt(b)) - Date.parse(createdAt(a)));

export function memoryListItemMarkup(item: MemoryListItem, disabled = false): string {
  const kind = memoryItemKindNote(item);
  const origin = memoryItemOrigin(item);
  const created = memoryItemCreated(item);
  const stamp = createdAt(item);
  return `<article class="memory-item" data-memory-id="${escape(item.id)}"><header class="memory-meta">${kind ? `<span class="memory-kind">${escape(kind)}</span>` : ''}<span class="memory-source">${escape(origin)}</span>${created ? `<time datetime="${escape(stamp)}">${escape(created)}</time>` : ''}</header><p>${escape(memoryItemText(item))}</p>${memoryDeleteControl(item.id, disabled)}</article>`;
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
