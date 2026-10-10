import { ApiError, request, stream } from './api';
import type { Entry, Session } from './protocol';
interface RouteStatus { status: 'unconfigured' | 'disabled' | 'error' | 'configured'; provider?: string; model?: string; code?: string }
interface Conversation { sessionId: string; provider: string; model: string; state: 'active' | 'revoked' | 'route_changed'; revision: number; permittedClasses: string[]; latestRunId: string | null }
interface Run { runId: string; sessionId: string; state: 'accepted' | 'dispatch_intent' | 'terminal'; outcome: string | null; finalText: string | null; partialText: string; mayHaveBeenSent: boolean; sequence: number }
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export class ConnectedView {
  #lastActive = false;
  constructor(readonly onState: () => void) {}
  get active() { return this.#busy || !!this.#run && this.#run.state !== 'terminal'; }
  #owner = ''; #status: RouteStatus = { status: 'unconfigured' }; #conversation: Conversation | undefined;
  #conversations: { title: string; conversation: Conversation }[] = []; #entries: Entry[] = [];
  #run: Run | undefined; #draft = ''; #pending: { key: string; text: string; sessionId: string } | undefined;
  #error = ''; #busy = false; #controller: AbortController | undefined; #generation = 0; #consent = false;
  #conversationController: AbortController | undefined; #selectionToken = 0;
  #opChain: Promise<void> = Promise.resolve(); #attaching = new Set<string>();
  #storage() { return `didi-connected:${this.#owner}`; }
  #save() {
    if (this.#owner) localStorage.setItem(this.#storage(), JSON.stringify({ sessionId: this.#conversation?.sessionId, draft: this.#draft, pending: this.#pending }));
  }
  detach() { this.#controller?.abort(); this.#controller = undefined; this.#generation++; }
  reset() { this.detach(); this.#closeConversationStream(); this.#owner = ''; this.#conversation = undefined; this.#run = undefined; this.#entries = []; this.#conversations = []; this.#draft = ''; this.#pending = undefined; }
  async refresh(owner: string) {
    if (owner !== this.#owner) { this.reset(); this.#owner = owner; }
    try {
      this.#status = await request<RouteStatus>('/chat/status');
      const sessions = await request<{ items: Session[] }>('/sessions');
      this.#conversations = [];
      for (const session of sessions.items) {
        try { this.#conversations.push({ title: session.title, conversation: await request<Conversation>(`/conversations/${session.id}`) }); }
        catch (error) { if (!(error instanceof ApiError) || !['CONFLICT', 'NOT_FOUND'].includes(error.code)) throw error; }
      }
      const saved = JSON.parse(localStorage.getItem(this.#storage()) ?? '{}');
      this.#draft = typeof saved.draft === 'string' ? saved.draft : '';
      if (saved.pending && typeof saved.pending.key === 'string' && typeof saved.pending.text === 'string' && typeof saved.pending.sessionId === 'string') this.#pending = saved.pending;
      const selected = this.#conversations.find(c => c.conversation.sessionId === saved.sessionId) ?? this.#conversations[0];
      if (selected) await this.select(selected.conversation.sessionId);
      else await this.clearSelection();
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
  attach() {
    if (this.#lastActive !== this.active) { this.#lastActive = this.active; this.onState(); }
    const panel = document.getElementById('connected-panel');
    if (!panel) { this.detach(); return; }
    const c = this.#conversation, r = this.#run, available = this.#status.status === 'configured';
    panel.innerHTML = `<section class="panel connected-conversation" aria-label="Connected Naya conversation">
      <p class="eyebrow">EXPLICITLY CONNECTED · SEPARATE FROM LOCAL NOTES</p><h2>Talk with Naya</h2>
      <p id="connected-route" role="status">${available ? `Locally configured: ${escape(this.#status.provider)} / ${escape(this.#status.model)}. This is not a reachability check.` : `Model ${escape(this.#status.status)}${this.#status.code ? ` (${escape(this.#status.code)})` : ''}. Local notes, Today and recall still work.`}</p>
      <p class="connected-disclosure">Starting a connected conversation sends its current and earlier selected turns to <strong>${escape(this.#status.provider ?? 'the configured provider')} / ${escape(this.#status.model ?? 'no model')}</strong>. It does not send other sessions, local notes, Today, recall or tools. Only private conversation material and ordinary material you deliberately review here are permitted. Revocation cannot retract bytes already sent.</p>
      <label class="connected-consent"><input id="connected-consent" type="checkbox" ${this.#consent ? 'checked' : ''} ${!available ? 'disabled' : ''}> I agree to this route for a new conversation.</label>
      <button id="connected-start" class="secondary" ${!available || !this.#consent || this.#busy ? 'disabled' : ''}>Start connected conversation</button>
      ${this.#conversations.length ? `<label>Connected history<select id="connected-history">${this.#conversations.map(item => `<option value="${escape(item.conversation.sessionId)}" ${c?.sessionId === item.conversation.sessionId ? 'selected' : ''}>${escape(item.title)} · ${escape(item.conversation.model)} · ${escape(item.conversation.state)}</option>`).join('')}</select></label>` : ''}
      ${c ? `<div class="connected-state"><span class="tag">${escape(c.provider)} / ${escape(c.model)} · ${escape(c.state)}</span>${c.state !== 'active' ? '<p>This conversation is paused. History remains here. Start a new explicitly disclosed conversation to send again.</p>' : ''}<button id="connected-recover" class="quiet">Recover saved history</button><button id="connected-revoke" class="quiet" ${c.state === 'revoked' || this.#busy ? 'disabled' : ''}>Revoke conversation consent</button></div>
      <div id="connected-entries" class="connected-entries">${this.#entries.map(entry => `<article class="entry ${entry.role}"><header><strong>${entry.role === 'assistant' ? 'Naya · saved answer' : 'You · saved locally'}</strong></header><p>${escape(entry.text)}</p></article>`).join('')}</div>
      ${r ? `<div id="connected-run" class="callout" role="status" data-run-id="${escape(r.runId)}">${r.state === 'terminal' ? r.outcome === 'complete' ? 'Answer saved durably.' : `No saved answer: ${escape(r.outcome)}.${r.mayHaveBeenSent ? ' Content may have been sent.' : ''}` : 'User turn accepted durably; waiting for a saved answer.'}${r.partialText && r.outcome !== 'complete' ? `<p class="provisional"><strong>Provisional · not a saved answer</strong><br>${escape(r.partialText)}</p>` : ''}${r.state !== 'terminal' ? '<button id="connected-cancel" class="quiet">Cancel model run</button>' : ''}</div>` : ''}
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
    panel.querySelector<HTMLSelectElement>('#connected-history')?.addEventListener('change', event => { void this.#action(() => this.select((event.target as HTMLSelectElement).value)); });
    panel.querySelector('#connected-recover')?.addEventListener('click', () => { if (c) void this.#action(() => this.select(c.sessionId)); });
    panel.querySelector('#connected-revoke')?.addEventListener('click', () => { if (c) void this.#action(async () => { await request(`/conversations/${c.sessionId}/revoke`, { method: 'POST', body: {} }); await this.select(c.sessionId); }); });
    panel.querySelector<HTMLTextAreaElement>('#connected-draft')?.addEventListener('input', event => { this.#draft = (event.target as HTMLTextAreaElement).value; this.#save(); });
    panel.querySelector('#connected-send-form')?.addEventListener('submit', event => { event.preventDefault(); if (c) void this.#send(c); });
    panel.querySelector('#connected-cancel')?.addEventListener('click', () => { if (r && c) void this.#action(async () => { await request(`/chat/${r.runId}/cancel`, { method: 'POST', body: {} }); await this.select(c.sessionId); }); });
  }
  async #action(action: () => Promise<void>) {
    if (this.#busy) return; this.#busy = true; this.#error = ''; this.attach();
    try { await action(); } catch (error) { this.#error = error instanceof Error ? error.message : 'Could not confirm this action. Your draft remains; recover history before explicitly sending again.'; }
    finally { this.#busy = false; this.attach(); }
  }
  async #send(c: Conversation) {
    const text = this.#draft.trim(); if (!text || c.state !== 'active' || this.#run && this.#run.state !== 'terminal') return;
    await this.#action(async () => {
      if (!this.#pending || this.#pending.text !== text || this.#pending.sessionId !== c.sessionId) this.#pending = { key: crypto.randomUUID(), text, sessionId: c.sessionId };
      this.#save();
      const run = await request<Run>('/chat', { method: 'POST', body: { sessionId: c.sessionId, text }, idempotencyKey: this.#pending.key, signal: AbortSignal.timeout(8000) });
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
