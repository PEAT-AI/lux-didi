import { ApiError, authorityVersion, assertAuthority, request, stream } from './api';
import { renderToolEvidence } from './markdown.ts';
import type { Entry, Session, Recall, MemorySelectionSnapshot, ConnectedRouteStatus, ConnectedConsent, Status, ToolEvidence } from './protocol';
interface RouteStatus extends ConnectedRouteStatus {}
interface Conversation { scope: 'conversation' | 'standing'; sessionId: string; provider: string; model: string; state: 'active' | 'revoked' | 'route_changed'; revision: number; permittedClasses: string[]; latestRunId: string | null }
interface Run { toolEvidence?: ToolEvidence[]; finalEntryId: string | null; runId: string; sessionId: string; state: 'accepted' | 'dispatch_intent' | 'terminal'; outcome: string | null; finalText: string | null; partialText: string; mayHaveBeenSent: boolean; sequence: number; memorySelection: MemorySelectionSnapshot | null }
interface ViewLifetime { owner: string; generation: number; authority: AbortSignal; local: AbortSignal }
type RecalledNote = Recall['hits'][number];
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export class ConnectedView {
  #lastActive = false;
  #displayName = 'Lux Didi';
  constructor(readonly onState: () => void) {}
  get active() { return this.#busy || !!this.#run && this.#run.state !== 'terminal'; }
  get remember() { return this.#remember; }
  get busy() { return this.#busy; }
  get history() { return this.#conversations.map(item => ({ title: item.title, sessionId: item.conversation.sessionId, model: item.conversation.model, state: item.conversation.state })); }
  setRemember(value: boolean) { this.#remember = value; }
  get standingRevoke() { return this.#status.consent?.scope === 'standing' && this.#status.consent.state === 'active'; }
  get conversationState() { return this.#conversation?.state; }
  async revokeStanding() { const grant = this.#status.consent; if (!grant) return; await this.#action(async lifetime => {
    await request(`/conversations/${grant.sessionId}/revoke`, { method: 'POST', body: {}, signal: lifetime.local }); this.#check(lifetime);
    const status = await request<RouteStatus>('/chat/status', { signal: lifetime.local }); this.#check(lifetime); this.#status = status; this.#consent = false;
  }); }
  async revokeConversation() { const c = this.#conversation; if (!c) return; await this.#action(async lifetime => {
    await request(`/conversations/${c.sessionId}/revoke`, { method: 'POST', body: {}, signal: lifetime.local }); this.#check(lifetime);
    const status = await request<RouteStatus>('/chat/status', { signal: lifetime.local }); this.#check(lifetime); this.#status = status;
    return this.select(c.sessionId, lifetime);
  }); }
  async recoverHistory() { if (this.#pending) return this.#action(lifetime => this.#recoverPending(lifetime)); const c = this.#conversation; if (c) return this.#action(lifetime => this.select(c.sessionId, lifetime)); }
  #owner = ''; #status: RouteStatus = { status: 'unconfigured' }; #conversation: Conversation | undefined;
  #conversations: { title: string; conversation: Conversation }[] = []; #entries: Entry[] = [];
  #run: Run | undefined; #draft = ''; #pending: { key: string; text: string; sessionId: string; selectedMemoryEntryIds: string[] } | undefined;
  #memoryQuery = ''; #memoryHits: RecalledNote[] = []; #memorySelected: RecalledNote[] = []; #memoryError = ''; #memoryBusy = false; #memoryOpen = false;
  #error = ''; #busy = false; #controller: AbortController | undefined; #generation = 0; #consent = false; #remember = true;
  #conversationController: AbortController | undefined; #selectionToken = 0;
  #opChain: Promise<void> = Promise.resolve(); #attaching = new Map<string, object>();
  #lifecycleController = new AbortController();
  #storage() { return `didi-connected:${this.#owner}`; }
  #save() {
    if (this.#owner) localStorage.setItem(this.#storage(), JSON.stringify({ sessionId: this.#pending?.sessionId ?? this.#conversation?.sessionId, draft: this.#draft, pending: this.#pending }));
  }
  #lifetime(): ViewLifetime { return { owner: this.#owner, generation: this.#generation, authority: authorityVersion(), local: this.#lifecycleController.signal }; }
  #current(lifetime: ViewLifetime) { return lifetime.owner === this.#owner && lifetime.generation === this.#generation && lifetime.authority === authorityVersion() && !lifetime.local.aborted; }
  #check(lifetime: ViewLifetime) {
    assertAuthority(lifetime.authority);
    if (!this.#current(lifetime)) throw new ApiError('VIEW_CHANGED', 'The conversation changed. Recover its current history before trying again.', 0);
  }
  detach(preserveBusy = false) { this.#controller?.abort(); this.#controller = undefined; this.#lifecycleController.abort(); this.#lifecycleController = new AbortController(); this.#generation++; if (!preserveBusy) this.#busy = false; this.#memoryBusy = false; }
  reset() { this.#consent = false; this.#remember = true; this.detach(); this.#selectionToken++; this.#closeConversationStream(); this.#attaching.clear(); this.#owner = ''; this.#displayName = 'Lux Didi'; this.#status = { status: 'unconfigured' }; this.#error = ''; this.#conversation = undefined; this.#run = undefined; this.#entries = []; this.#conversations = []; this.#draft = ''; this.#pending = undefined; this.#memoryQuery = ''; this.#memoryHits = []; this.#memorySelected = []; this.#memoryError = ''; this.#memoryBusy = false; this.#memoryOpen = false; }
  async refresh(owner: string) {
    if (owner !== this.#owner) { this.reset(); this.#owner = owner; }
    const lifetime = this.#lifetime(), token = this.#selectionToken, draft = this.#draft, restoring = !this.#conversation;
    try {
      const status = await request<Status>('/status', { signal: lifetime.local }); this.#check(lifetime);
      if (status.assistantId !== owner) throw new ApiError('VIEW_CHANGED', 'The current owner changed. Reconnect before restoring this conversation.', 0);
      const route = await request<RouteStatus>('/chat/status', { signal: lifetime.local }); this.#check(lifetime);
      const sessions = await request<{ items: Session[] }>('/sessions', { signal: lifetime.local }); this.#check(lifetime);
      const conversations: { title: string; conversation: Conversation }[] = [];
      for (const session of sessions.items) {
        try {
          const conversation = await request<Conversation>(`/conversations/${session.id}`, { signal: lifetime.local }); this.#check(lifetime);
          conversations.push({ title: session.title, conversation });
        } catch (error) { this.#check(lifetime); if (!(error instanceof ApiError) || !['CONFLICT', 'NOT_FOUND'].includes(error.code)) throw error; }
      }
      this.#check(lifetime);
      const saved = JSON.parse(localStorage.getItem(this.#storage()) ?? '{}');
      const savedConversation = conversations.find(c => c.conversation.sessionId === saved.sessionId);
      this.#displayName = status.ownerProfile.displayName; this.#status = route; this.#conversations = conversations;
      const pending = saved.pending && typeof saved.pending.sessionId === 'string' && typeof saved.pending.key === 'string' && typeof saved.pending.text === 'string'
        ? { key: saved.pending.key, text: saved.pending.text, sessionId: saved.pending.sessionId, selectedMemoryEntryIds: Array.isArray(saved.pending.selectedMemoryEntryIds) ? saved.pending.selectedMemoryEntryIds.filter((id: unknown): id is string => typeof id === 'string') : [] } : undefined;
      if (pending && pending.sessionId !== savedConversation?.conversation.sessionId) {
        this.#pending ??= pending;
        this.#error = 'Recover saved history before choosing another conversation. The pending session could not be verified; its acceptance key is retained.';
        this.attach(); return;
      }
      if (restoring && savedConversation && draft === this.#draft && token === this.#selectionToken) {
        this.#draft = typeof saved.draft === 'string' ? saved.draft : '';
        if (pending) this.#pending = pending;
      }
      const selected = conversations.find(c => c.conversation.sessionId === this.#conversation?.sessionId) ?? savedConversation ?? conversations[0];
      this.#error = '';
      this.#check(lifetime);
      if (token === this.#selectionToken) {
        if (selected) { await this.select(selected.conversation.sessionId, lifetime); return; }
        await this.clearSelection(); this.#check(lifetime);
      }
      this.attach();
    } catch (error) { if (this.#current(lifetime)) { this.#error = error instanceof Error ? error.message : 'Connected status could not be read.'; this.attach(); } }
  }
  async select(sessionId: string, actionLifetime?: ViewLifetime): Promise<ViewLifetime | undefined> {
    if (!this.#owner || this.#busy && !actionLifetime) return;
    if (actionLifetime) this.#check(actionLifetime);
    this.detach(!!actionLifetime); this.#closeConversationStream(); this.#run = undefined;
    const lifetime = this.#lifetime(), token = ++this.#selectionToken;
    if (actionLifetime) Object.assign(actionLifetime, lifetime);
    try {
      await this.#openConversationStream(sessionId); this.#check(lifetime);
      const conversation = await request<Conversation>(`/conversations/${sessionId}`, { signal: lifetime.local }); this.#check(lifetime);
      const entries = (await request<{ entries: Entry[] }>(`/sessions/${sessionId}`, { signal: lifetime.local })).entries; this.#check(lifetime);
      const run = conversation.latestRunId ? await request<Run>(`/chat/${conversation.latestRunId}`, { signal: lifetime.local }) : undefined; this.#check(lifetime);
      this.#conversation = conversation; this.#entries = entries; this.#run = run;
      this.#save(); this.attach();
      await this.#publishSelection(sessionId, token); this.#check(lifetime);
      if (run && run.state !== 'terminal') void this.#watch(run.runId, actionLifetime);
      return this.#lifetime();
    } catch (error) { if (this.#current(lifetime)) throw error; }
  }
  /** One FIFO chain for every run/selection application; a later user action always applies last. */
  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#opChain.then(task, task);
    this.#opChain = next.catch(() => undefined);
    return next;
  }
  /** Publish the last explicitly chosen conversation; a superseded write never reaches the service. */
  async #publishSelection(sessionId: string, token: number) {
    const lifetime = this.#lifetime();
    await this.#enqueue(async () => {
      if (!this.#current(lifetime) || token !== this.#selectionToken) return;
      const title = this.#conversations.find(item => item.conversation.sessionId === sessionId)?.title ?? sessionId;
      try { await request('/conversation-selection', { method: 'POST', body: { sessionId, title }, signal: lifetime.local }); }
      catch { /* a routing hint that could not be published never blocks the conversation */ }
    });
  }
  /** Clear only this principal's record; a failed clear never blocks logout or history. */
  async clearSelection() {
    const token = ++this.#selectionToken, lifetime = this.#lifetime();
    await this.#enqueue(async () => {
      if (!this.#current(lifetime) || token !== this.#selectionToken) return;
      try { await request('/conversation-selection/clear', { method: 'POST', body: {}, signal: lifetime.local }); }
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
    const lifetime = this.#lifetime();
    const marker = {}; this.#attaching.set(runId, marker);
    const current = () => this.#current(lifetime) && this.#conversationController === controller && this.#conversation?.sessionId === sessionId;
    try {
      await this.#enqueue(async () => {
        if (!current() || this.#run?.runId === runId) return;
        const run = await request<Run>(`/chat/${runId}`, { signal: lifetime.local }); if (!current()) return;
        const entries = (await request<{ entries: Entry[] }>(`/sessions/${sessionId}`, { signal: lifetime.local })).entries; if (!current()) return;
        this.#run = run; this.#entries = entries; this.#save(); this.attach();
        if (run.state !== 'terminal') void this.#watch(run.runId);
      });
    } catch (error) { if (current()) { this.#error = error instanceof Error ? error.message : 'Could not load the accepted run.'; this.attach(); } }
    finally { if (this.#attaching.get(runId) === marker) this.#attaching.delete(runId); }
  }
  attach() {
    if (this.#lastActive !== this.active) { this.#lastActive = this.active; this.onState(); }
    const panel = document.getElementById('connected-panel');
    if (!panel) { this.detach(); return; }
    const c = this.#conversation, r = this.#run, available = this.#status.status === 'configured';
    const grant = this.#status.consent, ready = available && (!!grant || this.#consent);
    const provider = this.#status.provider, model = this.#status.model;
    panel.innerHTML = `<section class="panel connected-conversation" aria-label="Connected Naya conversation">
      <h2>Talk with ${escape(this.#displayName)}</h2>
      ${grant ? '' : `<p class="connected-disclosure">Starting a connected conversation sends its current and earlier selected turns to <strong>${escape(provider ?? 'the connected provider')}</strong>. Nothing leaves this Mac until you agree.</p>
      <label class="connected-consent" for="connected-consent"><input id="connected-consent" type="checkbox" ${this.#consent ? 'checked' : ''}> I agree to send this conversation through ${escape(provider ?? 'the configured provider')}${model ? ` / ${escape(model)}` : ''}.</label>`}
      <div id="connected-entries" class="connected-entries">${this.#entries.map(entry => `${entry.id === r?.finalEntryId ? renderToolEvidence(r.toolEvidence ?? []) : ''}<article class="entry ${entry.role}"><header><strong>${entry.role === 'assistant' ? 'Naya · saved answer' : 'You · saved locally'}</strong></header><p>${escape(answerText(entry))}</p></article>`).join('')}${r && !r.finalEntryId ? renderToolEvidence(r.toolEvidence ?? []) : ''}</div>
      ${r ? this.#runSection(r) : ''}
      <form id="connected-send-form"><label for="connected-draft">Message for this connected conversation</label><textarea id="connected-draft" rows="3" placeholder="One small next step…" ${!ready || this.#busy ? 'disabled' : ''}>${escape(this.#draft)}</textarea><div class="composer-toolbar">${c && c.state === 'active' ? this.#notesSection() : ''}<button id="connected-send" ${!ready || this.#busy || (r && r.state !== 'terminal') ? 'disabled' : ''}>Send</button></div><small>Enter sends; Shift+Enter makes a new line. A failed acceptance keeps your draft; nothing is automatically retried.</small></form>
      ${this.#error ? `<p id="connected-error" role="alert">${escape(this.#error)}</p>` : ''}
      ${this.#pending && !c ? `<div id="connected-recovery" role="alert" data-recovery="pending-conversation-missing"><p>Unresolved turn: its conversation is not in the current list. The pending acceptance key and text are retained; nothing was resent.</p><button id="connected-retry" class="quiet">Retry the saved turn</button><button id="connected-reload" class="quiet">Reload history</button></div>` : ''}
    </section>`;
    panel.querySelector<HTMLInputElement>('#connected-consent')?.addEventListener('change', event => { this.#consent = (event.target as HTMLInputElement).checked; this.attach(); });
    panel.querySelector<HTMLInputElement>('#connected-remember')?.addEventListener('change', event => { this.#remember = (event.target as HTMLInputElement).checked; });
    panel.querySelector<HTMLTextAreaElement>('#connected-draft')?.addEventListener('input', event => { this.#draft = (event.target as HTMLTextAreaElement).value; this.#save(); });
    panel.querySelector<HTMLTextAreaElement>('#connected-draft')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void this.#send(); } });
    panel.querySelector('#connected-retry')?.addEventListener('click', () => { void this.recoverHistory(); });
    panel.querySelector('#connected-reload')?.addEventListener('click', () => { void this.refresh(this.#owner); });
    panel.querySelector('#connected-send-form')?.addEventListener('submit', event => { event.preventDefault(); void this.#send(); });
    panel.querySelector<HTMLInputElement>('#connected-notes-query')?.addEventListener('input', event => { this.#memoryQuery = (event.target as HTMLInputElement).value; });
    panel.querySelector('#connected-notes-search')?.addEventListener('submit', event => { event.preventDefault(); void this.#findNotes(); });
    panel.querySelectorAll<HTMLElement>('[data-add]').forEach(button => button.addEventListener('click', () => { this.#selectNote(button.dataset.add!); }));
    panel.querySelectorAll<HTMLElement>('[data-remove]').forEach(button => button.addEventListener('click', () => { this.#removeNote(button.dataset.remove!); }));
    panel.querySelector('#connected-notes-clear')?.addEventListener('click', () => { this.#memorySelected = []; this.attach(); });
    panel.querySelector<HTMLDetailsElement>('#connected-notes')?.addEventListener('toggle', event => { this.#memoryOpen = (event.target as HTMLDetailsElement).open; });
    panel.querySelector('#connected-cancel')?.addEventListener('click', () => { if (r && c) void this.#action(async lifetime => { await request(`/chat/${r.runId}/cancel`, { method: 'POST', body: {}, signal: lifetime.local }); this.#check(lifetime); return this.select(c.sessionId, lifetime); }); });
  }
  #runSection(r: Run): string {
    const failed = r.state === 'terminal' && r.outcome !== 'complete';
    const message = failed ? `No saved answer: ${escape(r.outcome)}.${r.mayHaveBeenSent ? ' Content may have been sent.' : ''}` : '';
    const provisional = r.partialText && r.outcome !== 'complete' ? `<p class="provisional"><strong>Provisional · not a saved answer</strong><br>${escape(r.partialText)}</p>` : '';
    const cancel = r.state !== 'terminal' ? '<button id="connected-cancel" class="quiet">Cancel model run</button>' : '';
    const hidden = !message && !provisional && !cancel;
    return `<div id="connected-run" class="callout" role="status" data-run-id="${escape(r.runId)}"${hidden ? ' hidden' : ''}>${message}${provisional}${cancel}${hidden ? '' : this.#usage(r)}</div>`;
  }

  async #action(action: (lifetime: ViewLifetime) => Promise<ViewLifetime | void>) {
    if (this.#busy || !this.#owner) return;
    let lifetime = this.#lifetime(); this.#busy = true; this.#error = ''; this.attach();
    try { this.#check(lifetime); const selected = await action(lifetime); if (selected) lifetime = selected; }
    catch (error) { if (this.#current(lifetime)) this.#error = error instanceof Error ? error.message : 'Could not confirm this action. Your draft remains; recover history before explicitly sending again.'; }
    finally { if (this.#current(lifetime)) { this.#busy = false; this.attach(); if (this.#run && this.#run.state !== 'terminal' && !this.#controller) void this.#watch(this.#run.runId); } }
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
      <summary id="connected-notes-summary">${this.#memorySelected.length ? `Selected notes (${this.#memorySelected.length})` : 'Attach notes'}</summary>
      <p class="muted">Choose exact stored notes for this one message. This is separate from the conversation history already included, and nothing is sent until you press Send.</p>
      <form id="connected-notes-search"><label for="connected-notes-query">Find a stored note</label><div class="search-row"><input id="connected-notes-query" type="search" maxlength="500" value="${escape(this.#memoryQuery)}" placeholder="A phrase you stored…"><button ${this.#memoryBusy ? 'disabled' : ''}>Find notes</button></div></form>
      ${this.#memoryError ? `<p id="connected-notes-error" role="alert">${escape(this.#memoryError)}</p>` : ''}
      ${this.#memorySelected.length ? `<ul id="connected-notes-selected" class="notes-selected">${this.#memorySelected.map(hit => `<li data-selected-id="${escape(hit.entryId)}"><span>${escape(this.#excerpt(hit.snippet))}</span> <small>${escape(hit.sourceTimestamp ?? 'no source date')}</small> <button type="button" class="quiet" data-remove="${escape(hit.entryId)}">Remove</button></li>`).join('')}</ul><button type="button" id="connected-notes-clear" class="quiet">Clear selected notes</button><p class="muted">Removing a note only leaves it out of the next message; it stays in your memory.</p>` : '<p id="connected-notes-none" class="muted">No notes selected. This message uses the conversation history only.</p>'}
      ${this.#memoryHits.length ? `<ul id="connected-notes-results" class="notes-results">${this.#memoryHits.map(hit => { const id = hit.entryId; return `<li data-result-id="${escape(id)}"><span>${escape(this.#excerpt(hit.snippet))}</span> <small>${escape(hit.sourceTimestamp ?? 'no source date')}</small>${id ? ` <button type="button" class="quiet" data-add="${escape(id)}" ${chosen.has(id) ? 'disabled' : ''}>${chosen.has(id) ? 'Selected' : 'Select'}</button>` : ' <small>Not selectable: no stored note id</small>'}</li>`; }).join('')}</ul>` : ''}
    </details>`;
  }
  async #findNotes() {
    if (this.#memoryBusy || !this.#owner) return;
    const lifetime = this.#lifetime();
    this.#memoryBusy = true; this.#memoryError = ''; this.#memoryOpen = true; this.attach();
    try { const hits = (await request<Recall>(`/recall?q=${encodeURIComponent(this.#memoryQuery)}&limit=20`, { signal: lifetime.local })).hits; this.#check(lifetime); this.#memoryHits = hits; }
    catch (error) { if (this.#current(lifetime)) this.#memoryError = error instanceof Error ? error.message : 'Local notes could not be read.'; }
    finally { if (this.#current(lifetime)) { this.#memoryBusy = false; this.attach(); } }
  }
  #selectNote(id: string) {
    if (this.#memorySelected.some(hit => hit.entryId === id)) return;
    const hit = this.#memoryHits.find(item => item.entryId === id);
    if (hit) { this.#memorySelected = [...this.#memorySelected, hit]; this.attach(); }
  }
  #removeNote(id: string) { this.#memorySelected = this.#memorySelected.filter(hit => hit.entryId !== id); this.attach(); }
  async #send() {
    const text = this.#draft.trim();
    if (!text || this.#busy) return;
    const active = this.#conversation?.state === 'active';
    if (active && this.#run && this.#run.state !== 'terminal') return;
    if (!active && !this.#status.consent && !this.#consent) return;
    // Freeze the message now: later draft or selection edits affect only a future message.
    const selectedIds = [...new Set(this.#memorySelected.map(hit => hit.entryId).filter((id): id is string => !!id))].sort();
    await this.#action(async lifetime => {
      let c = this.#conversation;
      if (!c || c.state !== 'active') {
        if (this.#pending) throw new Error('Recover saved history before starting another conversation. The pending acceptance key is retained.');
        c = await request<Conversation>('/conversations', { method: 'POST', body: { title: 'Naya connected conversation', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ...(!this.#status.consent ? { consent: this.#consent, remember: this.#remember } : {}) }, signal: AbortSignal.any([lifetime.local, AbortSignal.timeout(8000)]) }); this.#check(lifetime);
        const status = await request<RouteStatus>('/chat/status', { signal: lifetime.local }); this.#check(lifetime);
        this.#status = status; this.#consent = false; this.#conversation = c; this.#run = undefined;
        this.#conversations.unshift({ title: 'Naya connected conversation', conversation: c });
      }
      if (this.#conversation?.sessionId !== c.sessionId) return;
      const frozen = this.#pending && this.#pending.text === text && this.#pending.sessionId === c.sessionId
        && JSON.stringify(this.#pending.selectedMemoryEntryIds) === JSON.stringify(selectedIds);
      if (this.#pending && !frozen) throw new Error('Recover saved history before sending a changed turn or selected notes. The pending acceptance key is retained; nothing was resent.');
      if (!frozen) this.#pending = { key: crypto.randomUUID(), text, sessionId: c.sessionId, selectedMemoryEntryIds: selectedIds };
      const pending = this.#pending!;
      this.#save();
      let run: Run;
      try {
        run = await request<Run>('/chat', { method: 'POST', body: { sessionId: c.sessionId, text, ...(selectedIds.length ? { selectedMemoryEntryIds: selectedIds } : {}) }, idempotencyKey: pending.key, signal: AbortSignal.any([lifetime.local, AbortSignal.timeout(8000)]) });
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) { this.#pending = undefined; this.#save(); }
        if (selectedIds.length && error instanceof ApiError && error.code === 'MODEL_NOT_CONFIGURED') throw new Error('A selected note could not be included: it has no stored classification for this connection, or its class is not permitted by the current grant. Nothing was sent; deselect it or pick another note.');
        throw error;
      }
      this.#check(lifetime);
      this.#run = run; if (this.#draft.trim() === text) this.#draft = ''; this.#pending = undefined; this.#save();
      const entries = (await request<{ entries: Entry[] }>(`/sessions/${c.sessionId}`, { signal: lifetime.local })).entries; this.#check(lifetime); this.#entries = entries;
      void this.#watch(run.runId, lifetime); return this.#lifetime();
    });
  }

  /** Retry the exact retained turn by its idempotency key; a list omission never deletes it. */
  async #recoverPending(lifetime: ViewLifetime) {
    const pending = this.#pending; if (!pending) return;
    let run: Run;
    try {
      run = await request<Run>('/chat', {
        method: 'POST',
        body: { sessionId: pending.sessionId, text: pending.text, ...(pending.selectedMemoryEntryIds.length ? { selectedMemoryEntryIds: pending.selectedMemoryEntryIds } : {}) },
        idempotencyKey: pending.key,
        signal: AbortSignal.any([lifetime.local, AbortSignal.timeout(8000)]),
      });
    } catch (error) {
      // A definitive refusal is not an unknown outcome: never retry it, and let start stay usable.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) { this.#pending = undefined; this.#save(); }
      throw error;
    }
    this.#check(lifetime);
    this.#pending = undefined; this.#save();
    return this.select(run.sessionId, lifetime);
  }
  async #watch(runId: string, actionLifetime?: ViewLifetime) {
    if (this.#busy && !actionLifetime) return;
    this.detach(true); const lifetime = this.#lifetime(), sessionId = this.#conversation?.sessionId, controller = new AbortController(); this.#controller = controller;
    if (actionLifetime) Object.assign(actionLifetime, lifetime);
    const current = () => this.#current(lifetime) && this.#controller === controller && this.#conversation?.sessionId === sessionId;
    try {
      await stream(`/chat/${runId}/events`, controller.signal, value => {
        if (!value || typeof value !== 'object' || !current()) return;
        const event = value as { type?: string; run?: Run; text?: string; sequence?: number };
        if (event.type === 'snapshot' && event.run) this.#run = event.run;
        else if (event.type === 'text' && typeof event.text === 'string' && this.#run && Number(event.sequence) > this.#run.sequence) { this.#run.partialText += event.text; this.#run.sequence = Number(event.sequence); }
        else if (event.type === 'resync_required') this.#error = 'Stream detached. Recover the saved run; no message was resent.';
        this.attach();
      });
      if (!current() || !sessionId) return;
      const run = await request<Run>(`/chat/${runId}`, { signal: lifetime.local }); if (!current()) return;
      const entries = (await request<{ entries: Entry[] }>(`/sessions/${sessionId}`, { signal: lifetime.local })).entries; if (!current()) return;
      this.#run = run; this.#entries = entries;
      if (run.state !== 'terminal') this.#error = 'Stream closed. Recover saved history after reconnecting; no automatic send or retry.';
    } catch (error) { if (current() && !controller.signal.aborted) this.#error = error instanceof Error ? error.message : 'Stream disconnected; recover the saved run.'; }
    finally { if (current()) { this.#controller = undefined; this.attach(); } }
  }
}

/** The entry already names the speaker, so a leading 'Naya:' from the model is dropped. */
function answerText(entry: Entry): string { return entry.role === 'assistant' ? entry.text.replace(/^\s*Naya:\s*/, '') : entry.text; }

/** Only a server-resolved grant is passed to this display boundary. */
export function connectedConsentIndicator(grant: ConnectedConsent): string {
  return `<p class="connected-consent-indicator" role="status">Connected as ${escape(grant.provider)}, ${escape(grant.scope)} consent${grant.scope === 'standing' && grant.state === 'active' ? ', <button id="connected-standing-revoke" class="secondary">Revoke</button>' : ''}</p>`;
}
