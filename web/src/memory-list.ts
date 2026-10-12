const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function memoryDeleteControl(id: string, disabled = false): string {
  return `<button type="button" class="quiet memory-delete" data-delete-memory="${escape(id)}" ${disabled ? 'disabled' : ''}>Delete memory</button>`;
}

/** Keep the existing payload until both deletion and the authoritative reload succeed. */
export async function deleteMemoryAndReload<T>(id: string, actions: {
  confirm: () => boolean;
  remove: (id: string) => Promise<unknown>;
  reload: () => Promise<T>;
  apply: (payload: T) => void;
}): Promise<boolean> {
  if (!actions.confirm()) return false;
  await actions.remove(id);
  const payload = await actions.reload();
  actions.apply(payload);
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
