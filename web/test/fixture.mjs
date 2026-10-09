// Isolated synthetic HTTP + real SQLite. Never run with private service storage.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join, extname} from 'node:path';
export async function startFixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT, value TEXT)');
  const requests = []; const epoch = 'synthetic-authority-1'; let paired = false;
  let failEntry = false, conflict = false;
  const put = (kind, value) => { db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(value.id, kind, JSON.stringify(value)); return value; };
  const get = id => { const row = db.prepare('SELECT value FROM records WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; };
  const all = kind => db.prepare('SELECT value FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.value));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); const path = url.pathname;
    if (!path.startsWith('/api/')) {
      const asset = path === '/' ? 'index.html' : path.slice(1);
      if (asset.includes('..')) { res.writeHead(400).end(); return; }
      try { const data = await readFile(join(import.meta.dirname, '../dist', asset)); res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[extname(asset)] || 'application/octet-stream'); res.end(data); }
      catch { res.writeHead(404).end(); } return;
    }
    let body = {}; try { let text=''; for await (const chunk of req) text += chunk; if (text) body=JSON.parse(text); } catch { res.writeHead(400).end(); return; }
    requests.push({path,method:req.method,body,headers:req.headers});
    res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store');
    const ok = data => res.end(JSON.stringify({data,requestId:randomUUID(),authorityEpoch:epoch}));
    const error = (code,message,status=400) => {res.statusCode=status; res.end(JSON.stringify({error:{code,message},requestId:randomUUID()}));};
    if (path === '/api/v1/pair' && req.method === 'POST') {
      if (body.code !== 'synthetic-only') return error('PAIRING_INVALID','Pairing code is not valid.',401);
      paired=true; res.setHeader('Set-Cookie','didi=test-only; HttpOnly; SameSite=Strict; Path=/'); return ok({paired:true});
    }
    if (!paired || !req.headers.cookie?.includes('didi=test-only')) return error('UNAUTHORIZED','Pair this browser first.',401);
    if (req.method !== 'GET' && (req.headers['x-didi-authority-epoch'] !== epoch || !req.headers['idempotency-key'])) return error('INVALID_HEADERS','Missing authority or idempotency key');
    if (path === '/api/v1/status') return ok({assistantId:'synthetic-didi',authorityEpoch:epoch,serviceMode:'synthetic-test',capabilities:{memory:true,commitments:true,notifications:false,model:false},model:{configured:false},sources:[]});
    if (path === '/api/v1/sessions' && req.method==='GET') return ok({items:all('session'),nextCursor:null});
    if (path === '/api/v1/sessions' && req.method==='POST') return ok(put('session',{id:randomUUID(),...body,startedAt:new Date().toISOString(),endedAt:null,revision:1}));
    const sessionPath=path.match(/^\/api\/v1\/sessions\/([^/]+)(\/entries)?$/);
    if (sessionPath) {
      const session=get(sessionPath[1]); if(!session) return error('NOT_FOUND','Conversation not found.',404);
      if (req.method==='GET') return ok({session,entries:all('entry').filter(e=>e.sessionId===session.id),nextCursor:null});
      if (failEntry) {failEntry=false; return error('WRITE_FAILED','Could not save this message.',503);}
      if (body.role!=='user') return error('INVALID_ROLE','Only user entries are accepted');
      return ok(put('entry',{id:randomUUID(),sessionId:session.id,sequence:all('entry').length+1,role:'user',text:body.text,capturedAt:new Date().toISOString(),sourceRefs:[]}));
    }
    if(path==='/api/v1/chat') return error('MODEL_NOT_CONFIGURED','No model is connected.',503);
    if(path==='/api/v1/plan') return ok({date:url.searchParams.get('date'),timeZone:url.searchParams.get('timeZone'),items:all('commitment').filter(c=>c.status==='active'&&c.dueAt).map(commitment=>({commitment,isOverdue:false})),unscheduled:all('commitment').filter(c=>c.status==='active'&&!c.dueAt),nextCursor:null});
    if(path==='/api/v1/commitments' && req.method==='POST') return ok(put('commitment',{id:randomUUID(),notes:'',sourceSessionId:null,sourceEntryId:null,...body,status:'active',revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
    const cm=path.match(/^\/api\/v1\/commitments\/([^/]+)(?:\/(complete|reopen|cancel))?$/);
    if(cm){const c=get(cm[1]); if(!c) return error('NOT_FOUND','Commitment not found.',404);
      if(req.method==='GET') return ok({commitment:c,history:[]});
      if(conflict){conflict=false; c.revision++; c.title='Changed on another device'; put('commitment',c);}
      if(body.expectedRevision!==c.revision) return error('REVISION_CONFLICT','Changed on another device.',409);
      const {expectedRevision,...changes}=body;
      return ok(put('commitment',{...c,...changes,status:cm[2]?({complete:'completed',cancel:'cancelled',reopen:'active'})[cm[2]]:c.status,revision:c.revision+1,updatedAt:new Date().toISOString()}));}
    if(path==='/api/v1/recall') {const q=url.searchParams.get('q')||''; const entries=all('entry').filter(e=>q && e.text.toLowerCase().includes(q.toLowerCase())); return ok({hits:entries.map(e=>({sessionId:e.sessionId,entryId:e.id,snippet:e.text,sourceTimestamp:e.capturedAt,sourceRefs:[{id:'synthetic-source',label:'Synthetic notebook',sourceTimestamp:null,availability:'missing',note:'Original notebook unavailable'}]})),totalMatches:entries.length,truncated:false,nextCursor:null});}
    return error('NOT_FOUND','Route not found.',404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,requests,failNextEntry:()=>{failEntry=true;},conflictNextWrite:()=>{conflict=true;},close:async()=>{await new Promise(resolve=>server.close(resolve)); db.close();}};
}
