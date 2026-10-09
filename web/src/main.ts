import './style.css';
import { Orb, type VoiceState } from './orb';
import { ApiError, request, pair, demoMode, onAuthorityChanged, clearAuthority, restoreSession, logout } from './api';
import type { Session, Entry, Commitment, CommitmentDetail, Plan, Recall, Status, Job } from './protocol';

type Tab = 'Conversation' | 'Today' | 'Memory' | 'Settings';
const root = document.querySelector<HTMLDivElement>('#app')!;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const tabs: Tab[] = ['Conversation', 'Today', 'Memory', 'Settings'];
let tab: Tab = 'Conversation';
let orb: Orb | undefined;
let status: Status | undefined;
let connection: 'Connecting' | 'Connected' | 'Disconnected' | 'Offline' | 'Pair this browser' = 'Connecting';
let sessions: Session[] = [], entries: Entry[] = [], session: Session | undefined;
let plan: Plan | undefined, recall: Recall | undefined;
let recent: Commitment[] = [], editing: Commitment | undefined, detail: CommitmentDetail | undefined;
let messageDraft = '', titleDraft = '', queryDraft = '', editTitle = '', editNotes = '', editDue = '';
let notice = '', error = '', busy = false, readBusy = false, pairingBusy = false;
let pairingRequired = false, sessionMore = false, entriesMore = false;
let controller: AbortController | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined, backoff = 30000;
let readGeneration = 0;
let jobTimer: ReturnType<typeof setTimeout> | undefined;
let jobId: string | undefined, jobStarted = 0, jobPaused = false;
const e = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const datetime = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'No due date';
function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function localInput(value: string | null) { if (!value) return ''; const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
function writable() { return connection === 'Connected' && !busy; }
const disabled = (condition: boolean) => condition ? 'disabled' : '';
function notify(message: string, failure = false) { notice = failure ? '' : message; error = failure ? message : ''; render(); }
function failure(err: unknown, mutation = false) {
  if (err instanceof ApiError && err.status === 401) { pairingRequired = true; connection = 'Pair this browser'; clearAuthority(); }
  if (err instanceof DOMException && err.name === 'AbortError') return 'Stopped waiting. A sent change may still have been saved. Refresh before trying again.';
  if (err instanceof ApiError) return err.message;
  connection = navigator.onLine ? 'Disconnected' : 'Offline';
  return mutation ? 'Could not confirm whether this was saved. Your draft is here. Reconnect and check before trying again.' : 'Didi can’t reach your service. Reconnect when you’re ready.';
}
function sourceMarkup(refs: Entry['sourceRefs']) { return refs.map(s => `<div class="source"><span>${e(s.label)}</span><small>${s.availability === 'missing' ? 'Source unavailable' : 'Source available'}${s.sourceTimestamp ? ` · ${e(datetime(s.sourceTimestamp))}` : ''}</small>${s.note ? `<p>${e(s.note)}</p>` : ''}</div>`).join(''); }
function entryMarkup(entry: Entry) { return `<article class="entry ${entry.role}"><header><strong>${entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Didi' : 'Update'}</strong><time datetime="${e(entry.capturedAt)}">${e(datetime(entry.capturedAt))}</time></header><p>${e(entry.text)}</p>${sourceMarkup(entry.sourceRefs)}${entry.role === 'user' ? `<button class="quiet" data-capture="${e(entry.id)}" ${disabled(!writable() || !status?.capabilities.commitments)}>Make a commitment</button>` : ''}</article>`; }
function orbState(): VoiceState {
  if(connection==='Offline'||connection==='Disconnected'||pairingRequired)return 'DISCONNECTED';
  if(connection==='Connecting')return 'CONNECTING';
  if(jobId&&!jobPaused||busy)return 'PROCESSING';
  if(error)return 'ERROR';
  return 'CONNECTED';
}
function orbMarkup() {
  const state=orbState();
  const label=state==='PROCESSING'?'Working on your request':state==='CONNECTING'?'Connecting':state==='DISCONNECTED'?'Waiting for connection':state==='ERROR'?'Needs your attention':'Ready when you are';
  return `<section class="orb-stage" aria-label="Didi voice and activity"><canvas id="didi-orb" width="440" height="440" aria-hidden="true"></canvas><div class="orb-caption"><p class="orb-label" role="status" aria-live="polite">${e(label)}</p><p class="voice-honesty"><strong>Not listening</strong><span>Voice stays on your Mac. Use its native record control.</span></p></div></section>`;
}
function conversation() {
  return `<section class="page-heading"><div><p class="eyebrow">SPACE TO THINK</p><h1>A little clarity.</h1><p>Put it into words. We’ll keep what matters.</p></div><button id="new-conversation" class="secondary" ${disabled(busy)}>New conversation</button></section>
  ${orbMarkup()}<div class="conversation-grid"><aside class="panel conversations" aria-label="Conversations"><h2>Your conversations</h2>${sessions.length ? sessions.map(s => `<button data-session="${e(s.id)}" class="session ${session?.id === s.id ? 'selected' : ''}"><strong>${e(s.title)}</strong><small>${e(datetime(s.startedAt))}</small></button>`).join('') : '<p class="muted">No conversations yet.</p>'}${sessionMore ? '<p class="muted">More conversations are available in the service. This view shows the first page.</p>' : ''}</aside>
  <section class="panel thread" aria-label="Conversation">${sessions.length ? `<div class="mobile-conversations"><label for="conversation-select">Choose a conversation</label><select id="conversation-select"><option value="">Start a new conversation</option>${sessions.map(s=>`<option value="${e(s.id)}" ${session?.id===s.id?'selected':''}>${e(s.title)}</option>`).join('')}</select></div>` : ''}<div class="thread-heading"><span class="dot"></span><h2>${e(session?.title ?? 'Start where you are')}</h2></div>
  <div class="entries">${entries.length ? entries.map(entryMarkup).join('') : `<div class="empty"><span class="empty-icon" aria-hidden="true">✳</span><h3>What’s on your mind?</h3><p>Save a thought, make a plan, or pick up a conversation.</p></div>`}${entriesMore ? '<p class="muted">There are more messages in this conversation. This view shows the first page.</p>' : ''}</div>
  <form id="message-form" class="composer"><label for="message">Your message</label><textarea id="message" rows="3" maxlength="12000" placeholder="A thought, a next step, a thing to remember…">${e(messageDraft)}</textarea><div class="composer-foot"><small>${status?.model.configured ? 'Save a message, or ask Didi for help.' : 'No model connected. You can still save messages and commitments.'}</small><div class="button-row"><button type="submit" ${disabled(!writable())}>${busy ? 'Working…' : 'Save message'}</button><button type="button" id="ask-didi" class="secondary" ${disabled(!writable() || !status?.model.configured || !status?.capabilities.model)}>Ask Didi</button></div></div></form>
  ${jobId ? `<div class="callout">${jobPaused ? 'Stopped waiting for a reply. The service may still be working.' : 'Didi is working. You can stop waiting without losing your message.'}<button id="stop-job" class="quiet">Stop waiting</button></div>` : ''}
  </section></div>`;
}
function commitmentMarkup(c: Commitment, overdue = false) {
  return `<article class="commitment"><div class="commitment-body"><span class="tag ${c.status === 'active' ? '' : 'completed'}">${c.status === 'completed' ? 'Completed' : c.status === 'cancelled' ? 'Cancelled' : overdue ? 'Overdue' : c.dueAt ? 'Planned' : 'Unscheduled'}</span><h3>${e(c.title)}</h3>${c.notes ? `<p>${e(c.notes)}</p>` : ''}<p class="muted">${e(datetime(c.dueAt))}${c.dueAt ? ` · ${e(c.timeZone)}` : ''}</p>${c.sourceSessionId ? `<button class="quiet" data-source="${e(c.sourceSessionId)}">Open conversation source</button>` : ''}</div><div class="commitment-actions">${c.status === 'active' ? `<button class="secondary" data-complete="${e(c.id)}" aria-label="Complete ${e(c.title)}" ${disabled(!writable())}>Complete</button><button class="quiet" data-edit="${e(c.id)}" aria-label="Edit ${e(c.title)}" ${disabled(busy)}>Edit</button><button class="quiet" data-cancel="${e(c.id)}" ${disabled(!writable())}>Cancel commitment</button>` : `<button class="secondary" data-reopen="${e(c.id)}" aria-label="Reopen ${e(c.title)}" ${disabled(!writable())}>Reopen</button>`}<button class="quiet" data-history="${e(c.id)}" ${disabled(readBusy)}>History</button></div></article>`;
}
function today() {
  const active = [...(plan?.items.map(i=>i.commitment) ?? []), ...(plan?.unscheduled ?? [])];
  const completed = recent.filter(c => c.status !== 'active');
  return `<section class="page-heading"><div><p class="eyebrow">ONE NEXT STEP</p><h1>Today, with room to breathe.</h1><p>${e(new Intl.DateTimeFormat(undefined,{dateStyle:'full'}).format(new Date()))} · ${e(zone)}</p></div><button id="refresh-plan" class="secondary" ${disabled(readBusy)}>Refresh</button></section>
  <div class="today-grid"><section class="panel"><div class="section-heading"><h2>Your commitments</h2><span class="count">${active.length}</span></div>${active.length ? `<div class="commitment-list">${plan?.items.map(i=>commitmentMarkup(i.commitment,i.isOverdue)).join('') ?? ''}${plan?.unscheduled.length ? '<h3 class="subheading">Without a due date</h3>' : ''}${plan?.unscheduled.map(c=>commitmentMarkup(c)).join('') ?? ''}</div>` : '<div class="empty"><h3>A clear slate.</h3><p>No commitments due today or waiting for a date.</p></div>'}${plan?.nextCursor ? '<p class="callout">More commitments are available. This view is incomplete; refresh does not load the next page.</p>' : ''}${completed.length ? `<h3 class="subheading">Recently updated in this visit</h3>${completed.map(c=>commitmentMarkup(c)).join('')}` : ''}</section>
  <aside class="panel capture"><p class="eyebrow">KEEP IT SIMPLE</p><h2>Make a commitment</h2><p class="muted">Something you want to follow through on.</p><form id="commitment-form"><label for="commitment-title">Commitment title</label><input id="commitment-title" maxlength="500" required value="${e(titleDraft)}" placeholder="What’s the next step?"><button type="submit" ${disabled(!writable() || !status?.capabilities.commitments)}>Add commitment</button></form><div class="aside-note">Dates can be added or corrected after saving. Nothing is scheduled by this browser while offline.</div></aside></div>
  ${editing ? `<section class="panel editor" aria-labelledby="edit-heading"><h2 id="edit-heading">Adjust your commitment</h2><form id="edit-form"><label for="edit-title">Title</label><input id="edit-title" required maxlength="500" value="${e(editTitle)}"><label for="edit-notes">Notes</label><textarea id="edit-notes" rows="2">${e(editNotes)}</textarea><label for="edit-due">Due date and time</label><input id="edit-due" type="datetime-local" value="${e(editDue)}"><small>Shown in ${e(zone)}. Leave empty to remove the due date.</small><div class="button-row"><button type="submit" ${disabled(!writable())}>Save changes</button><button type="button" id="close-edit" class="secondary">Keep current date</button></div></form></section>` : ''}
  ${detail ? `<section class="panel editor"><h2>Commitment history</h2><p>${e(detail.commitment.title)}</p>${detail.history.length ? detail.history.map(h=>`<p>Revision ${h.revision} · ${e(h.operation)} · ${e(datetime(h.recordedAt))}<br>${e(h.title)} · ${e(datetime(h.dueAt))}</p>`).join('') : '<p class="muted">No history returned by the service.</p>'}<button id="close-history" class="quiet">Close history</button></section>` : ''}`;
}
function memory() {
  return `<section class="page-heading"><div><p class="eyebrow">REMEMBER, WITH CONTEXT</p><h1>Pick up the thread.</h1><p>Your words, connected to where they came from.</p></div></section><section class="panel recall"><form id="recall-form"><label for="recall-query">Search your memory</label><div class="search-row"><input id="recall-query" type="search" value="${e(queryDraft)}" maxlength="500" placeholder="A phrase, a project, a thought…"><button ${disabled(connection !== 'Connected' || readBusy || !status?.capabilities.memory)}>Search</button></div></form>${recall ? `<p class="muted">${recall.totalMatches} ${recall.totalMatches === 1 ? 'match' : 'matches'}${recall.truncated || recall.nextCursor ? ' · Partial results; more are available in the service.' : ''}</p>${recall.hits.length ? recall.hits.map(hit=>`<article class="recall-hit"><p>${e(hit.snippet)}</p><small>${e(datetime(hit.sourceTimestamp))}</small>${sourceMarkup(hit.sourceRefs)}<button class="quiet" data-source="${e(hit.sessionId)}">Open conversation source</button></article>`).join('') : '<div class="empty"><h3>No matches yet.</h3><p>Try a different phrase. Didi won’t invent a memory to fill the gap.</p></div>'}` : '<div class="empty"><span class="empty-icon" aria-hidden="true">↗</span><h3>Find the words you kept.</h3><p>Search saved conversations. Unavailable sources stay clearly marked.</p></div>'}</section>`;
}
function settings() {
  const permissions = typeof Notification === 'undefined' ? 'Not supported in this browser' : Notification.permission === 'granted' ? 'Allowed by this browser; no delivery is configured' : Notification.permission === 'denied' ? 'Blocked in browser settings' : 'Not requested';
  return `<section class="page-heading"><div><p class="eyebrow">YOUR SETUP, PLAINLY</p><h1>Make yourself at home.</h1><p>Know what’s connected. Choose what’s allowed.</p></div></section><div class="settings-grid"><section class="panel"><h2>Connection</h2><dl><dt>Service</dt><dd>${e(connection)}</dd><dt>Address</dt><dd>${e(location.origin)} /api/v1</dd><dt>Time zone</dt><dd>${e(zone)}</dd><dt>Privacy</dt><dd>Messages stay in your service. This browser keeps only the app shell for offline opening.</dd></dl><div class="button-row"><button id="reconnect" class="secondary" ${disabled(readBusy)}>Reconnect</button><button id="logout" class="quiet" ${disabled(!writable())}>Unpair this browser</button></div><p class="muted">Browser pairing uses a secure cookie, not a saved token. ${demoMode ? 'This is an isolated synthetic test service.' : 'Ask your local service for a one-time pairing code.'}</p></section>
  <section class="panel"><h2>Conversation model</h2><span class="tag">${status?.model.configured ? 'Connected' : 'No model connected'}</span><p>${status?.model.configured ? `${e(status.model.provider ?? '')} ${e(status.model.model ?? '')}` : 'You can save thoughts, recall messages, and manage commitments. Replies need a model configured in your service.'}</p></section>
  <section class="panel"><h2>Permissions</h2><dl><dt>Notifications</dt><dd>${e(permissions)}</dd><dt>Delivery</dt><dd>${status?.capabilities.notifications ? 'Available through your service; browser delivery is not set up' : 'Not configured'}</dd><dt>Microphone</dt><dd>Not requested. Voice capture is not part of this browser version.</dd></dl><p class="muted">Nothing here listens in the background. Change denied permissions in your browser settings.</p></section><section class="panel companion"><span class="eyebrow">A HELPING HAND ON YOUR MAC</span><h2>Mac companion</h2><p>The native companion can provide local Mac notifications and device features when you allow them.</p><p class="muted">This browser cannot control your Mac, start its microphone, or grant permissions for it. Open the companion to manage those choices.</p></section></div>`;
}
function pairing() { return `<section class="panel pairing"><p class="eyebrow">A PRIVATE CONNECTION</p><h1>Hello. Let’s connect.</h1><p>Enter the one-time code shown by your local service. It stays out of the address bar and isn’t saved here.</p><form id="pair-form"><label for="pair-code">One-time pairing code</label><input id="pair-code" type="password" autocomplete="off" spellcheck="false" required><button ${disabled(pairingBusy || !navigator.onLine)}>Pair this browser</button></form><p class="muted">Open your local service or Mac companion to get a code. Codes expire after five minutes and can only be used once.</p><button id="reconnect" class="quiet">Check connection again</button></section>`; }
function render() {
  // Keep cursor and unsent text stable across connection checks and action completion.
  const focus = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusId = focus?.id; const selection = focus && (focus.tagName === 'TEXTAREA' || ['text','search','password'].includes(focus.type)) ? [focus.selectionStart,focus.selectionEnd] : null;
  orb?.destroy();orb=undefined;
  root.innerHTML = `<a class="skip" href="#main">Skip to content</a><div class="app-shell"><aside class="sidebar"><a class="brand" href="/" aria-label="Didi home"><img src="/icon.svg" alt="" width="38" height="38"><span>didi<span class="brand-dot">.</span></span></a><p class="brand-note">A little clarity.<br>A little follow-through.</p><nav aria-label="Main navigation">${tabs.map((t,i)=>`<button data-tab="${t}" aria-current="${tab===t?'page':'false'}"><span aria-hidden="true">${['◌','✓','↗','⚙'][i]}</span>${t}</button>`).join('')}</nav><div class="sidebar-foot">Here for the next step.<br><small>No rush. No pretending.</small></div></aside><div class="workspace"><header class="topbar"><span>YOUR SPACE</span><div class="connection"><span class="connection-dot ${connection==='Connected'?'online':''}"></span><span id="connection-state" role="status" aria-live="polite" aria-atomic="true">${e(connection)}</span><button id="reconnect-top" class="quiet" aria-label="Refresh connection">↻</button></div></header>${demoMode || status?.serviceMode==='synthetic-test' ? '<div class="demo-banner"><strong>Demo test mode</strong><span>Isolated synthetic data · not your personal service</span></div>' : ''}<main id="main" tabindex="-1">${error ? `<div class="alert" role="alert" aria-live="assertive">${e(error)}</div>` : ''}${notice ? `<div class="notice" role="status" aria-live="polite" aria-atomic="true">${e(notice)}</div>` : ''}${readBusy ? '<p class="loading" role="status" aria-live="polite" aria-atomic="true">Loading your records…</p>' : ''}${busy ? '<button id="cancel-request" class="quiet">Stop waiting</button>' : ''}${pairingRequired ? pairing() : ({Conversation:conversation,Today:today,Memory:memory,Settings:settings}[tab])()}</main><footer>Small steps count. <span>Your service is the source of truth.</span></footer></div></div>`;
  bind();
  const canvas=document.getElementById('didi-orb') as HTMLCanvasElement | null;
  if(canvas)orb=new Orb(canvas,orbState());
  if (focusId) { const next=document.getElementById(focusId) as HTMLInputElement | HTMLTextAreaElement | null; next?.focus({preventScroll:true}); if(selection && next && selection[0]!==null) next.setSelectionRange(selection[0],selection[1]); }
}
function button(id: string, action: () => void) { document.getElementById(id)?.addEventListener('click', action); }
function form(id: string, action: () => void) { document.getElementById(id)?.addEventListener('submit', ev => { ev.preventDefault(); action(); }); }
function input(id: string, action: (value: string) => void) { document.getElementById(id)?.addEventListener('input', ev=>action((ev.target as HTMLInputElement).value)); }
function findCommitment(id: string) { return [...(plan?.items.map(i=>i.commitment) ?? []), ...(plan?.unscheduled ?? []), ...recent].find(c=>c.id===id); }
function bind() {
  root.querySelectorAll<HTMLElement>('[data-tab]').forEach(el=>el.onclick=()=>{ tab=el.dataset.tab as Tab; notice='';error='';render(); document.getElementById('main')?.focus(); void loadTab(); });
  root.querySelectorAll<HTMLElement>('[data-session]').forEach(el=>el.onclick=()=>void openSession(el.dataset.session!));
  root.querySelectorAll<HTMLElement>('[data-source]').forEach(el=>el.onclick=()=>{tab='Conversation';void openSession(el.dataset.source!);});
  root.querySelectorAll<HTMLElement>('[data-edit]').forEach(el=>el.onclick=()=>{editing=findCommitment(el.dataset.edit!);if(editing){editTitle=editing.title;editNotes=editing.notes;editDue=localInput(editing.dueAt);}render();document.getElementById('edit-title')?.focus();});
  root.querySelectorAll<HTMLElement>('[data-history]').forEach(el=>el.onclick=()=>void loadHistory(el.dataset.history!));
  for(const action of ['complete','reopen','cancel'] as const) root.querySelectorAll<HTMLElement>(`[data-${action}]`).forEach(el=>el.onclick=()=>{const c=findCommitment(el.dataset[action]!);if(c) void changeCommitment(c,action);});
  root.querySelectorAll<HTMLElement>('[data-capture]').forEach(el=>el.onclick=()=>{const entry=entries.find(v=>v.id===el.dataset.capture);if(entry)void mutate(async signal=>{await request<Commitment>('/commitments',{method:'POST',body:{title:entry.text,notes:'',dueAt:null,timeZone:zone,sourceSessionId:entry.sessionId,sourceEntryId:entry.id},signal});notice='Commitment saved. Find it in Today.';});});
  document.getElementById('conversation-select')?.addEventListener('change',ev=>{const id=(ev.target as HTMLSelectElement).value;if(id)void openSession(id);else{session=undefined;entries=[];render();}});
  input('message',v=>messageDraft=v); input('commitment-title',v=>titleDraft=v);input('recall-query',v=>queryDraft=v);input('edit-title',v=>editTitle=v);input('edit-notes',v=>editNotes=v);input('edit-due',v=>editDue=v);
  form('message-form',()=>void sendMessage(false));button('ask-didi',()=>void sendMessage(true));
  form('commitment-form',()=>{if(!titleDraft.trim())return;void mutate(async signal=>{await request<Commitment>('/commitments',{method:'POST',body:{title:titleDraft.trim(),dueAt:null,timeZone:zone},signal});titleDraft='';await loadPlan();notice='Commitment saved.';});});
  form('edit-form',()=>{if(!editing || !editTitle.trim())return;void changeCommitment(editing,'edit');});
  form('recall-form',()=>void searchRecall());
  form('pair-form',()=>{const code=(document.getElementById('pair-code') as HTMLInputElement).value;void pairBrowser(code);});
  button('new-conversation',()=>{session=undefined;entries=[];entriesMore=false;notice='';render();document.getElementById('message')?.focus();});
  button('close-edit',()=>{editing=undefined;render();});button('close-history',()=>{detail=undefined;render();});
  button('refresh-plan',()=>void loadTab()); button('reconnect',()=>void connect());button('reconnect-top',()=>void connect());
  button('logout',()=>void mutate(async()=>{await logout();status=undefined;sessions=[];entries=[];session=undefined;plan=undefined;recall=undefined;recent=[];pairingRequired=true;connection='Pair this browser';notice='This browser is unpaired.';}));
  button('cancel-request',()=>controller?.abort());button('stop-job',()=>{if(jobTimer)clearTimeout(jobTimer);jobPaused=true;render();});
}
async function mutate(action: (signal: AbortSignal) => Promise<void>) {
  if(!writable())return;
  busy=true;error='';notice='';controller=new AbortController();render();
  const timeout=setTimeout(()=>controller?.abort(),20000);
  try {await action(controller.signal);} catch(err){error=failure(err,true);} finally{clearTimeout(timeout);busy=false;controller=undefined;render();}
}
async function ensureSession(signal: AbortSignal) {
  if(!session){session=await request<Session>('/sessions',{method:'POST',body:{title:'A new conversation',timeZone:zone},signal});sessions.unshift(session);entries=[];}
  return session;
}
async function sendMessage(model: boolean) {
  if(!messageDraft.trim())return;
  const text=messageDraft.trim();
  await mutate(async signal=>{
    const current=await ensureSession(signal);
    if(model){const accepted=await request<{jobId:string;status:string}>('/chat',{method:'POST',body:{sessionId:current.id,text,timeZone:zone},signal});jobId=accepted.jobId;jobStarted=Date.now();jobPaused=false;messageDraft='';notice='Message accepted. Waiting for the service reply.';void pollJob();}
    else{const entry=await request<Entry>(`/sessions/${encodeURIComponent(current.id)}/entries`,{method:'POST',body:{text,role:'user',timeZone:zone},signal});if(!entries.some(e=>e.id===entry.id))entries.push(entry);messageDraft='';notice='Message saved.';}
  });
}
async function changeCommitment(c: Commitment, action: 'edit'|'complete'|'reopen'|'cancel') {
  await mutate(async signal=>{
    try {
      const body=action==='edit'?{expectedRevision:c.revision,title:editTitle.trim(),notes:editNotes,dueAt:editDue?new Date(editDue).toISOString():null,timeZone:zone}:{expectedRevision:c.revision};
      const updated=await request<Commitment>(`/commitments/${encodeURIComponent(c.id)}${action==='edit'?'':`/${action}`}`,{method:action==='edit'?'PATCH':'POST',body,signal});
      recent=[updated,...recent.filter(r=>r.id!==updated.id)];editing=undefined;
      await loadPlan();notice=action==='edit'?'Due date updated.':action==='complete'?'Commitment completed.':action==='reopen'?'Commitment reopened.':'Commitment cancelled.';
    } catch(err) {
      if(err instanceof ApiError && err.status===409){
        const latest=await request<CommitmentDetail>(`/commitments/${encodeURIComponent(c.id)}`);
        recent=[latest.commitment,...recent.filter(r=>r.id!==c.id)];await loadPlan();
        // Preserve correction draft, but require explicit review with the new revision.
        if(action==='edit')editing=latest.commitment;
        throw new ApiError('REVISION_CONFLICT','This changed on another device. The latest version is loaded. Review it before trying again.',409);
      }
      throw err;
    }
  });
}
async function loadPlan() { plan=await request<Plan>(`/plan?date=${localDate()}&timeZone=${encodeURIComponent(zone)}`); }
async function loadTab() {
  if(connection!=='Connected')return;
  const generation=++readGeneration;readBusy=true;render();
  try {
    if(tab==='Today')await loadPlan();
    if(tab==='Conversation'){const list=await request<{items:Session[];nextCursor:string|null}>('/sessions');if(generation===readGeneration){sessions=list.items;sessionMore=!!list.nextCursor;}}
  } catch(err){if(generation===readGeneration)error=failure(err);} finally{if(generation===readGeneration){readBusy=false;render();}}
}
async function openSession(id: string) {
  const generation=++readGeneration;readBusy=true;render();
  try {const data=await request<{session:Session;entries:Entry[];nextCursor:string|null}>(`/sessions/${encodeURIComponent(id)}`);if(generation===readGeneration){session=data.session;entries=data.entries;entriesMore=!!data.nextCursor;tab='Conversation';notice='';error='';}}
  catch(err){if(generation===readGeneration)error=failure(err);}finally{if(generation===readGeneration){readBusy=false;render();}}
}
async function loadHistory(id: string){readBusy=true;render();try{detail=await request<CommitmentDetail>(`/commitments/${encodeURIComponent(id)}`);}catch(err){error=failure(err);}finally{readBusy=false;render();}}
async function searchRecall(){if(connection!=='Connected'||readBusy)return;readBusy=true;error='';render();try{recall=await request<Recall>(`/recall?q=${encodeURIComponent(queryDraft.trim())}&limit=20`);}catch(err){error=failure(err);}finally{readBusy=false;render();}}
async function pairBrowser(code: string){pairingBusy=true;error='';render();try{await pair(code);pairingRequired=false;await connect();}catch(err){error=failure(err);}finally{pairingBusy=false;render();}}
async function connect(background=false) {
  if(!navigator.onLine){connection='Offline';render();schedulePoll();return;}
  if(!background){connection='Connecting';error='';render();}
  try {
    await restoreSession();
    const current=await request<Status>('/status',{signal:AbortSignal.timeout(8000)});status=current;connection='Connected';pairingRequired=false;backoff=30000;
    if(!background)await loadTab();
  } catch(err){error=failure(err);if(!pairingRequired)connection='Disconnected';backoff=Math.min(backoff*2,120000);}
  render();schedulePoll();
}
function schedulePoll(){if(pollTimer)clearTimeout(pollTimer);if(!document.hidden&&!pairingRequired)pollTimer=setTimeout(()=>void connect(true),backoff);}
async function pollJob(){
  if(!jobId||jobPaused)return;
  if(document.hidden||!navigator.onLine){jobTimer=setTimeout(()=>void pollJob(),10000);return;}
  if(Date.now()-jobStarted>120000){jobPaused=true;notify('The reply is taking longer than expected. Reopen the conversation to check; no new message was queued.');return;}
  try{const job=await request<Job>(`/jobs/${encodeURIComponent(jobId)}`,{signal:AbortSignal.timeout(8000)});
    if(['completed','succeeded','failed','cancelled'].includes(job.status)){jobId=undefined;if(job.error){notify(job.error.message,true);}else if(session){await openSession(session.id);}return;}
  }catch(err){notify(failure(err),true);jobPaused=true;return;}
  jobTimer=setTimeout(()=>void pollJob(),2500);
}
onAuthorityChanged(()=>{status=undefined;sessions=[];entries=[];session=undefined;plan=undefined;recall=undefined;recent=[];connection='Disconnected';});
window.addEventListener('offline',()=>{connection='Offline';if(pollTimer)clearTimeout(pollTimer);render();});
window.addEventListener('online',()=>void connect());
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(pollTimer)clearTimeout(pollTimer);}else{void connect(true);}});
if('serviceWorker' in navigator && import.meta.env.PROD)void navigator.serviceWorker.register('/sw.js').catch(()=>{ /* Shell availability is optional; never imply offline saving. */ });
render();void connect();
