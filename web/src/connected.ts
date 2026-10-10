import { ApiError, request, stream } from './api';
import type { Entry, Session, Recall, MemorySelectionSnapshot, ConnectedRouteStatus, ConnectionStatus, Status } from './protocol';
interface RouteStatus extends ConnectedRouteStatus {}
interface Conversation { sessionId: string; provider: string; model: string; state: 'active' | 'revoked' | 'route_changed'; revision: number; permittedClasses: string[]; latestRunId: string | null }
interface Run { runId: string; sessionId: string; state: 'accepted' | 'dispatch_intent' | 'terminal'; outcome: string | null; finalText: string | null; partialText: string; mayHaveBeenSent: boolean; sequence: number; memorySelection: MemorySelectionSnapshot | null }
type RecalledNote = Recall['hits'][number];
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export class ConnectedView {
  #lastActive = false;
  #displayName = 'Lux Didi';
  constructor(readonly onState: () => void) {}
  get active() { return this.#busy || !!this.#run && this.#run.state !== 'terminal'; }
  #owner = ''; #status: RouteStatus = { status: 'unconfigured' }; #conversation: Conversation | undefined;
  #connections: ConnectionStatus[] = [];
  #conversations: { title: string; conversation: Conversation }[] = []; #entries: Entry[] = [];
  #run: Run | undefined; #draft = ''; #pending: { key: string; text: string; sessionId: string; selectedMemoryEntryIds: string[] } | undefined;
  #memoryQuery = ''; #memoryHits: RecalledNote[] = []; #memorySelected: RecalledNote[] = []; #memoryError = ''; #memoryBusy = false; #memoryOpen = false;
  #error = ''; #busy = false; #controller: AbortController | undefined; #generation = 0; #consent = false;
  #conversationController: AbortController | undefined; #selectionToken = 0;
  #opChain: Promise<void> = Promise.resolve(); #attaching = new Set<string>();
  #storage() { return `didi-connected:${this.#owner}`; }
  #save() {
    if (this.#owner) localStorage.setItem(this.#storage(), JSON.stringify({ sessionId: this.#conversation?.sessionId, draft: this.#draft, pending: this.#pending }));
  }
  detach() { this.#controller?.abort(); this.#controller = undefined; this.#generation++; }
  reset() { this.detach(); this.#closeConversationStream(); this.#owner = ''; this.#displayName = 'Lux Didi'; this.#conversation = undefined; this.#run = undefined; this.#entries = []; this.#conversations = []; this.#draft = ''; this.#pending = undefined; this.#memoryQuery = ''; this.#memoryHits = []; this.#memorySelected = []; this.#memoryError = ''; this.#memoryBusy = false; this.#memoryOpen = false; }
  async refresh(owner: string) {
    if (owner !== this.#owner) { this.reset(); this.#owner = owner; }
    const token = this.#selectionToken;
    try {
      const status = await request<Status>('/status');
      this.#displayName = status.ownerProfile.displayName;
      this.#connections = Array.isArray(status.connections) ? status.connections : [];
      this.#status = await request<RouteStatus>('/chat/status');
      const sessions = await request<{ items: Session[] }>('/sessions');
      this.#conversations = [];
      for (const session of sessions.items) {
        try { this.#conversations.push({ title: session.title, conversation: await request<Conversation>(`/conversations/${session.id}`) }); }
        catch (error) { if (!(error instanceof ApiError) || !['CONFLICT', 'NOT_FOUND'].includes(error.code)) throw error; }
      }
      const saved = JSON.parse(localStorage.getItem(this.#storage()) ?? '{}');
      this.#draft = typeof saved.draft === 'string' ? saved.draft : '';
      if (saved.pending && typeof saved.pending.key === 'string' && typeof saved.pending.text === 'string' && typeof saved.pending.sessionId === 'string') this.#pending = { key: saved.pending.key, text: saved.pending.text, sessionId: saved.pending.sessionId, selectedMemoryEntryIds: Array.isArray(saved.pending.selectedMemoryEntryIds) ? saved.pending.selectedMemoryEntryIds.filter((id: unknown): id is string => typeof id === 'string') : [] };
      const selected = this.#conversations.find(c => c.conversation.sessionId === saved.sessionId) ?? this.#conversations[0];
      // A choice the user made while this refresh was loading always wins over the restored one.
      if (token === this.#selectionToken) { if (selected) await this.select(selected.conversation.sessionId); else await this.clearSelection(); }
      this.#error = '';
    } catch (error) { this.#error = error instanceof Error ? error.message : 'Connected status could not be read.'; }
    this.attach();
  }
  async select(sessionId: string) {
    this.detach(); this.#closeConversationStream(); this.#run = undefined;
    const generation = this.#generation, token = ++this.#selectionToken;
    // Establish the conversation subscription before the durable snapshot/gap fill.
    await this.#openConversationStream(sessionId);
    if (generation !== this.#generation) return;
    const conversation = await request<Conversation>(`/conversations/${sessionId}`);
    const entries = (await request<{ entries: Entry[] }>(`/sessions/${sessionId}`)).entries;
    if (generation !== this.#generation) return;
    this.#conversation = conversation; this.#entries = entries;
    if (conversation.latestRunId) { const run = await request<Run>(`/chat/${conversation.latestRunId}`); if (generation !== this.#generation) return; this.#run = run; }
    this.#save(); this.attach();
    await this.#publishSelection(sessionId, token);
    if (generation !== this.#generation) return;
    if (this.#run?.state !== 'terminal' && this.#run) void this.#watch(this.#run.runId);
  }
  /** One FIFO chain for every run/selection application; a later user action always applies last. */
  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#opChain.then(task, task);
    this.#opChain = next.catch(() => undefined);
    return next;
  }
  /** Publish the last explicitly chosen conversation; a superseded write never reaches the service. */
  async #publishSelection(sessionId: string, token: number) {
    await this.#enqueue(async () => {
      if (token !== this.#selectionToken) return;
      const title = this.#conversations.find(item => item.conversation.sessionId === sessionId)?.title ?? sessionId;
      try { await request('/conversation-selection', { method: 'POST', body: { sessionId, title } }); }
      catch { /* a routing hint that could not be published never blocks the conversation */ }
    });
  }
  /** Clear only this principal's record; a failed clear never blocks logout or history. */
  async clearSelection() {
    const token = ++this.#selectionToken;
    await this.#enqueue(async () => {
      if (token !== this.#selectionToken) return;
      try { await request('/conversation-selection/clear', { method: 'POST', body: {} }); }
      catch { /* logout/expiry drops the record server-side anyway */ }
    });
  }
  #closeConversationStream() { this.#conversationController?.abort(); this.#conversationController = undefined; }
  async #openConversationStream(sessionId: string): Promise<void> {
    const controller = new AbortController(); this.#conversationController = controller;
    let settle!: () => void; const subscribed = new Promise<void>(resolveOpen => { settle = resolveOpen; });
    void stream(`/conversations/${sessionId}/events`, controller.signal, value => {
      if (this.#conversationController !== controller) return;
      const event = value as { type?: string; sessionId?: string; runId?: string };
      if (event.type === 'run' && event.sessionId === sessionId && typeof event.runId === 'string') void this.#attachExternal(sessionId, event.runId, controller);
    }, () => settle()).catch(() => { /* reconnection stays explicit; the durable snapshot closes any gap */ }).finally(() => settle());
    await subscribed;
  }
  /** A durable run accepted elsewhere appears here without a refresh; page B is never retargeted to A. */
  async #attachExternal(sessionId: string, runId: string, controller: AbortController) {
    if (this.#run?.runId === runId || this.#attaching.has(runId)) return;
    this.#attaching.add(runId);
    try {
      await this.#enqueue(async () => {
        if (this.#conversationController !== controller || this.#conversation?.sessionId !== sessionId || this.#run?.runId === runId) return;
        const run = await request<Run>(`/chat/${runId}`);
        if (this.#conversationController !== controller || this.#conversation?.sessionId !== sessionId) return;
        this.#run = run; this.#save();
        this.#entries = (await request<{ entries: Entry[] }>(`/sessions/${sessionId}`)).entries;
        if (this.#conversationController !== controller) return;
        this.attach();
        if (run.state !== 'terminal') void this.#watch(run.runId);
      });
    } catch (error) { if (this.#conversationController === controller) { this.#error = error instanceof Error ? error.message : 'Could not load the accepted run.'; this.attach(); } }
    finally { this.#attaching.delete(runId); }
  }
  /** Gentle, escaped optional-integration status. Never a credential, account payload or catalog. */
  #connectionsHtml() {
    if (!this.#connections.length) return '<p id="connected-connections-empty" class="connected-connections">No optional integrations configured. Local notes, Today and recall still work.</p>';
    const rows = this.#connections.map(connection => `<li><span class="connected-name">${escape(connection.label)}</span> <span class="connected-state connected-${escape(connection.state)}">${escape(connection.state.replace('_', ' '))}${connection.lastKnown ? ' (last known)' : ''}</span></li>`).join('');
    return `<div class="connected-connections"><p class="eyebrow">OPTIONAL INTEGRATIONS · THEY NEVER BLOCK LOCAL NOTES</p><ul id="connected-connections">${rows}</ul></div>`;
  }
  attach() {
    if (this.#lastActive !== this.active) { this.#lastActive = this.active; this.onState(); }
    const panel = document.getElementById('connected-panel');
    if (!panel) { this.detach(); return; }
    const c = this.#conversation, r = this.#run, available = this.#status.status === 'configured';
    panel.innerHTML = `<section class="panel connected-conversation" aria-label="Connected Naya conversation">
      <p class="eyebrow">EXPLICITLY CONNECTED · SEPARATE FROM LOCAL NOTES</p><h2>Talk with ${escape(this.#displayName)}</h2>
      <p id="connected-route" role="status">${available ? `Locally configured: ${escape(this.#status.provider)} / ${escape(this.#status.model)}. This is not a reachability check.` : `Model ${escape(this.#status.status)}${this.#status.code ? ` (${escape(this.#status.code)})` : ''}. Local notes, Today and recall still work.`}</p>
      ${this.#connectionsHtml()}
      <p class="connected-disclosure">Starting a connected conversation sends its current and earlier selected turns to <strong>${escape(this.#status.provider ?? 'the configured provider')} / ${escape(this.#status.model ?? 'no model')}</strong>. It does not send other sessions, Today, recall or tools. It sends stored local notes only when you explicitly select them for that message, under this connection's existing route and consent; no note is ever included silently and no new permission is granted. Only private conversation material and ordinary material you deliberately review here are permitted. Revocation cannot retract bytes already sent.</p>
      <label class="connected-consent"><input id="connected-consent" type="checkbox" ${this.#consent ? 'checked' : ''} ${!available ? 'disabled' : ''}> I agree to this route for a new conversation.</label>
      <button id="connected-start" class="secondary" ${!available || !this.#consent || this.#busy ? 'disabled' : ''}>Start connected conversation</button>
      ${this.#conversations.length ? `<label>Connected history<select id="connected-history">${this.#conversations.map(item => `<option value="${escape(item.conversation.sessionId)}" ${c?.sessionId === item.conversation.sessionId ? 'selected' : ''}>${escape(item.title)} · ${escape(item.conversation.model)} · ${escape(item.conversation.state)}</option>`).join('')}</select></label>` : ''}
      ${c ? `<div class="connected-state"><span class="tag">${escape(c.provider)} / ${escape(c.model)} · ${escape(c.state)}</span>${c.state !== 'active' ? '<p>This conversation is paused. History remains here. Start a new explicitly disclosed conversation to send again.</p>' : ''}<button id="connected-recover" class="quiet">Recover saved history</button><button id="connected-revoke" class="quiet" ${c.state === 'revoked' || this.#busy ? 'disabled' : ''}>Revoke conversation consent</button></div>
      <div id="connected-entries" class="connected-entries">${this.#entries.map(entry => `<article class="entry ${entry.role}"><header><strong>${entry.role === 'assistant' ? 'Naya · saved answer' : 'You · saved locally'}</strong></header><p>${escape(entry.text)}</p></article>`).join('')}</div>
      ${r ? `<div id="connected-run" class="callout" role="status" data-run-id="${escape(r.runId)}">${r.state === 'terminal' ? r.outcome === 'complete' ? 'Answer saved durably.' : `No saved answer: ${escape(r.outcome)}.${r.mayHaveBeenSent ? ' Content may have been sent.' : ''}` : 'User turn accepted durably; waiting for a saved answer.'}${r.partialText && r.outcome !== 'complete' ? `<p class="provisional"><strong>Provisional · not a saved answer</strong><br>${escape(r.partialText)}</p>` : ''}${r.state !== 'terminal' ? '<button id="connected-cancel" class="quiet">Cancel model run</button>' : ''}${this.#usage(r)}</div>` : ''}
      ${c.state === 'active' ? this.#notesSection() : ''}
      <form id="connected-send-form"><label for="connected-draft">Message for this connected conversation</label><textarea id="connected-draft" rows="3" placeholder="One small next step…" ${c.state !== 'active' ? 'disabled' : ''}>${escape(this.#draft)}</textarea><button id="connected-send" ${c.state !== 'active' || this.#busy || (r && r.state !== 'terminal') ? 'disabled' : ''}>Send to ${escape(c.provider)} / ${escape(c.model)}</button><small>Send captures exactly one user turn. Local Save does not send. A failed acceptance keeps your draft; nothing is automatically retried.</small></form>` : ''}
      ${this.#error ? `<p id="connected-error" role="alert">${escape(this.#error)}</p>` : ''}
    </section>`;
    panel.querySelector<HTMLInputElement>('#connected-consent')?.addEventListener('change', event => { this.#consent = (event.target as HTMLInputElement).checked; this.attach(); });
    panel.querySelector('#connected-start')?.addEventListener('click', () => { void this.#action(async () => {
      if (!this.#consent) return;
      const grant = await request<Conversation>('/conversations', { method: 'POST', body: { title: 'Naya connected conversation', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, signal: AbortSignal.timeout(8000) });
      this.#consent = false; this.#draft = ''; this.#pending = undefined;
      this.#conversations.unshift({ title: 'Naya connected conversation', conversation: grant }); await this.select(grant.sessionId);
    }); });
    panel.querySelector<HTMLSelectElement>('#connected-history')?.addEventListener('change', event => { const next = (event.target as HTMLSelectElement).value; void this.select(next).catch(error => { this.#error = error instanceof Error ? error.message : 'Could not open that connected conversation.'; this.attach(); }); });
    panel.querySelector('#connected-recover')?.addEventListener('click', () => { if (c) void this.#action(() => this.select(c.sessionId)); });
    panel.querySelector('#connected-revoke')?.addEventListener('click', () => { if (c) void this.#action(async () => { await request(`/conversations/${c.sessionId}/revoke`, { method: 'POST', body: {} }); await this.select(c.sessionId); }); });
    panel.querySelector<HTMLTextAreaElement>('#connected-draft')?.addEventListener('input', event => { this.#draft = (event.target as HTMLTextAreaElement).value; this.#save(); });
    panel.querySelector('#connected-send-form')?.addEventListener('submit', event => { event.preventDefault(); if (c) void this.#send(c); });
    panel.querySelector<HTMLInputElement>('#connected-notes-query')?.addEventListener('input', event => { this.#memoryQuery = (event.target as HTMLInputElement).value; });
    panel.querySelector('#connected-notes-search')?.addEventListener('submit', event => { event.preventDefault(); void this.#findNotes(); });
    panel.querySelectorAll<HTMLElement>('[data-add]').forEach(button => button.addEventListener('click', () => { this.#selectNote(button.dataset.add!); }));
    panel.querySelectorAll<HTMLElement>('[data-remove]').forEach(button => button.addEventListener('click', () => { this.#removeNote(button.dataset.remove!); }));
    panel.querySelector('#connected-notes-clear')?.addEventListener('click', () => { this.#memorySelected = []; this.attach(); });
    panel.querySelector<HTMLDetailsElement>('#connected-notes')?.addEventListener('toggle', event => { this.#memoryOpen = (event.target as HTMLDetailsElement).open; });
    panel.querySelector('#connected-cancel')?.addEventListener('click', () => { if (r && c) void this.#action(async () => { await request(`/chat/${r.runId}/cancel`, { method: 'POST', body: {} }); await this.select(c.sessionId); }); });
  }
  async #action(action: () => Promise<void>) {
    if (this.#busy) return; this.#busy = true; this.#error = ''; this.attach();
    try { await action(); } catch (error) { this.#error = error instanceof Error ? error.message : 'Could not confirm this action. Your draft remains; recover history before explicitly sending again.'; }
    finally { this.#busy = false; this.attach(); }
  }
  /** A short local excerpt for display; never the whole stored record. */
  #excerpt(snippet: string): string { return snippet.length > 160 ? `${snippet.slice(0, 159)}…` : snippet; }
  /** Local note labels for selected records: stored excerpt when this page holds it, else a neutral id only. */
  #noteLabel(id: string): string {
    const hit = [...this.#memorySelected, ...this.#memoryHits].find(item => item.entryId === id);
    return hit ? this.#excerpt(hit.snippet) : `stored note ${id.slice(0, 8)}… (not loaded in this browser session)`;
  }
  /** Canonical requested/used/omitted metadata from the run snapshot; omitted is never shown as used. */
  #usage(r: Run): string {
    const selection = r.memorySelection;
    if (!selection) return '';
    const frozen = selection.frozen ? '' : ' Not evaluated yet; omitted notes appear after the prompt freezes.';
    return `<div class="notes-usage" id="connected-notes-usage"><p><strong>Requested notes:</strong> ${selection.counts.requested} · <strong>used notes:</strong> ${selection.counts.used} · <strong>omitted notes:</strong> ${selection.counts.omitted}.${frozen}</p>${selection.usedIds.length ? `<p>Used notes: ${selection.usedIds.map(id => escape(this.#noteLabel(id))).join('; ')}</p>` : ''}${selection.omitted.length ? `<p>Omitted notes: ${selection.omitted.map(item => `${escape(this.#noteLabel(item.id))} — ${escape(item.reason)}`).join('; ')}</p>` : ''}</div>`;
  }
  /** Compact expandable note selection. Local recall results only; no content is persisted by this page. */
  #notesSection(): string {
    const chosen = new Set(this.#memorySelected.map(hit => hit.entryId).filter((id): id is string => !!id));
    return `<details class="connected-notes" id="connected-notes"${this.#memorySelected.length || this.#memoryOpen ? ' open' : ''}>
      <summary id="connected-notes-summary">${this.#memorySelected.length ? `Selected notes (${this.#memorySelected.length})` : 'Select local notes for this message'}</summary>
      <p class="muted">Choose exact stored notes for this one message. This is separate from the conversation history already included, and nothing is sent until you press Send.</p>
      <form id="connected-notes-search"><label for="connected-notes-query">Find a stored note</label><div class="search-row"><input id="connected-notes-query" type="search" maxlength="500" value="${escape(this.#memoryQuery)}" placeholder="A phrase you stored…"><button ${this.#memoryBusy ? 'disabled' : ''}>Find notes</button></div></form>
      ${this.#memoryError ? `<p id="connected-notes-error" role="alert">${escape(this.#memoryError)}</p>` : ''}
      ${this.#memorySelected.length ? `<ul id="connected-notes-selected" class="notes-selected">${this.#memorySelected.map(hit => `<li data-selected-id="${escape(hit.entryId)}"><span>${escape(this.#excerpt(hit.snippet))}</span> <small>${escape(hit.sourceTimestamp ?? 'no source date')}</small> <button type="button" class="quiet" data-remove="${escape(hit.entryId)}">Remove</button></li>`).join('')}</ul><button type="button" id="connected-notes-clear" class="quiet">Clear selected notes</button><p class="muted">Removing a note only leaves it out of the next message; it stays in your memory.</p>` : '<p id="connected-notes-none" class="muted">No notes selected. This message uses the conversation history only.</p>'}
      ${this.#memoryHits.length ? `<ul id="connected-notes-results" class="notes-results">${this.#memoryHits.map(hit => { const id = hit.entryId; return `<li data-result-id="${escape(id)}"><span>${escape(this.#excerpt(hit.snippet))}</span> <small>${escape(hit.sourceTimestamp ?? 'no source date')}</small>${id ? ` <button type="button" class="quiet" data-add="${escape(id)}" ${chosen.has(id) ? 'disabled' : ''}>${chosen.has(id) ? 'Selected' : 'Select'}</button>` : ' <small>Not selectable: no stored note id</small>'}</li>`; }).join('')}</ul>` : ''}
    </details>`;
  }
  async #findNotes() {
    if (this.#memoryBusy) return;
    this.#memoryBusy = true; this.#memoryError = ''; this.#memoryOpen = true; this.attach();
    try { this.#memoryHits = (await request<Recall>(`/recall?q=${encodeURIComponent(this.#memoryQuery)}&limit=20`)).hits; }
    catch (error) { this.#memoryError = error instanceof Error ? error.message : 'Local notes could not be read.'; }
    finally { this.#memoryBusy = false; this.attach(); }
  }
  #selectNote(id: string) {
    if (this.#memorySelected.some(hit => hit.entryId === id)) return;
    const hit = this.#memoryHits.find(item => item.entryId === id);
    if (hit) { this.#memorySelected = [...this.#memorySelected, hit]; this.attach(); }
  }
  #removeNote(id: string) { this.#memorySelected = this.#memorySelected.filter(hit => hit.entryId !== id); this.attach(); }
  async #send(c: Conversation) {
    const text = this.#draft.trim(); if (!text || c.state !== 'active' || this.#run && this.#run.state !== 'terminal') return;
    // Freeze the message now: later draft or selection edits affect only a future message.
    const selectedIds = [...new Set(this.#memorySelected.map(hit => hit.entryId).filter((id): id is string => !!id))].sort();
    await this.#action(async () => {
      const frozen = this.#pending && this.#pending.text === text && this.#pending.sessionId === c.sessionId
        && JSON.stringify(this.#pending.selectedMemoryEntryIds) === JSON.stringify(selectedIds);
      if (!frozen) this.#pending = { key: crypto.randomUUID(), text, sessionId: c.sessionId, selectedMemoryEntryIds: selectedIds };
      const pending = this.#pending!;
      this.#save();
      let run: Run;
      try {
        run = await request<Run>('/chat', { method: 'POST', body: { sessionId: c.sessionId, text, ...(selectedIds.length ? { selectedMemoryEntryIds: selectedIds } : {}) }, idempotencyKey: pending.key, signal: AbortSignal.timeout(8000) });
      } catch (error) {
        if (selectedIds.length && error instanceof ApiError && error.code === 'MODEL_NOT_CONFIGURED') throw new Error('A selected note could not be included: it has no stored classification for this connection, or its class is not permitted by the current grant. Nothing was sent; deselect it or pick another note.');
        throw error;
      }
      this.#run = run; this.#draft = ''; this.#pending = undefined; this.#save();
      this.#entries = (await request<{ entries: Entry[] }>(`/sessions/${c.sessionId}`)).entries;
      void this.#watch(run.runId);
    });
  }
  async #watch(runId: string) {
    this.detach(); const generation = this.#generation, controller = new AbortController(); this.#controller = controller;
    try {
      await stream(`/chat/${runId}/events`, controller.signal, value => {
        if (!value || typeof value !== 'object' || generation !== this.#generation) return;
        const event = value as { type?: string; run?: Run; text?: string; sequence?: number };
        if (event.type === 'snapshot' && event.run) this.#run = event.run;
        else if (event.type === 'text' && typeof event.text === 'string' && this.#run && Number(event.sequence) > this.#run.sequence) { this.#run.partialText += event.text; this.#run.sequence = Number(event.sequence); }
        else if (event.type === 'resync_required') this.#error = 'Stream detached. Recover the saved run; no message was resent.';
        this.attach();
      });
      if (generation !== this.#generation || !this.#conversation) return;
      this.#run = await request<Run>(`/chat/${runId}`);
      this.#entries = (await request<{ entries: Entry[] }>(`/sessions/${this.#conversation.sessionId}`)).entries;
      if (this.#run.state !== 'terminal') this.#error = 'Stream closed. Recover saved history after reconnecting; no automatic send or retry.';
    } catch (error) { if (!controller.signal.aborted) this.#error = error instanceof Error ? error.message : 'Stream disconnected; recover the saved run.'; }
    finally { if (generation === this.#generation) { this.#controller = undefined; this.attach(); } }
  }
}
