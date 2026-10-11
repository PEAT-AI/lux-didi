// Isolated synthetic HTTP + real SQLite. Never run with private service storage.
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
import {join, extname} from 'node:path';
export async function startFixture() {
  const headers = JSON.parse(await readFile(join(import.meta.dirname, '../security-headers.json'),'utf8'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE records (id TEXT PRIMARY KEY, kind TEXT, value TEXT)');
  let orbAssets;
  const requests = []; const epoch = 'synthetic-authority-1'; let paired = false;
  let failEntry = false, conflict = false, heldEntry, heldPlan;
  const put = (kind, value) => { db.prepare('INSERT OR REPLACE INTO records VALUES(?,?,?)').run(value.id, kind, JSON.stringify(value)); return value; };
  const get = id => { const row = db.prepare('SELECT value FROM records WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; };
  const all = kind => db.prepare('SELECT value FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.value));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); const path = url.pathname;
    if(path.startsWith('/orb-proof/')){
      try {
        orbAssets??=await orbProofAssets();
        const data=orbAssets[path];
        if(data===undefined){res.writeHead(404).end();return;}
        res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.json')?'application/json':path.endsWith('.css')?'text/css':'text/html');
        for(const [name,value] of Object.entries(headers))res.setHeader(name,value);
        res.end(data);
      }catch(error){console.error('Orb reference producer refused:',error.message);res.writeHead(500).end('Reference producer unavailable');}
      return;
    }
    if (!path.startsWith('/api/')) {
      for(const [name,value] of Object.entries(headers))res.setHeader(name,value);
      const asset = path === '/' ? 'index.html' : path.slice(1);
      if (asset.includes('..')) { res.writeHead(400).end(); return; }
      try { let data = await readFile(join(import.meta.dirname, '../dist', asset)); if(asset==='index.html') data=Buffer.from(data.toString().replace('<head>','<head><meta name="didi-test-mode" content="synthetic">')); res.setHeader('Content-Type', ({'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[extname(asset)] || 'application/octet-stream'); res.end(data); }
      catch { res.writeHead(404).end(); } return;
    }
    let body = {}; try { let text=''; for await (const chunk of req) text += chunk; if (text) body=JSON.parse(text); } catch { res.writeHead(400).end(); return; }
    requests.push({path,method:req.method,body,headers:req.headers});
    res.setHeader('Content-Type','application/json'); res.setHeader('Cache-Control','no-store');
    const ok = data => res.end(JSON.stringify({data,requestId:randomUUID(),authorityEpoch:epoch}));
    const error = (code,message,status=400) => {res.statusCode=status; res.end(JSON.stringify({error:{code,message},requestId:randomUUID()}));};
    if (path === '/api/v1/auth/pair' && req.method === 'POST') {
      if (body.pairingCode !== 'synthetic-only') return error('PAIRING_INVALID','Pairing code is not valid.',401);
      paired=true; res.setHeader('Set-Cookie','didi=test-only; HttpOnly; SameSite=Strict; Path=/'); return ok({csrfToken:'synthetic-csrf'});
    }
    if (!paired || !req.headers.cookie?.includes('didi=test-only')) return error('UNAUTHORIZED','Pair this browser first.',401);
    if (path === '/api/v1/auth/session') return ok({csrfToken:'synthetic-csrf'});
    if (req.method !== 'GET' && req.headers['x-didi-csrf'] !== 'synthetic-csrf') return error('CSRF_INVALID','Missing CSRF token.',403);
    if (req.method !== 'GET' && (req.headers['x-didi-authority-epoch'] !== epoch || !req.headers['idempotency-key'])) return error('INVALID_HEADERS','Missing authority or idempotency key');
    if(path === '/api/v1/auth/logout') { paired=false; res.setHeader('Set-Cookie','didi=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'); return ok({loggedOut:true}); }
    if (path === '/api/v1/status') return ok({ownerProfile:{status:'default',displayName:'Lux Didi'},assistantId:'synthetic-didi',authorityEpoch:epoch,serviceMode:'synthetic-test',capabilities:{memory:true,commitments:true,notifications:false,model:false},model:{configured:false},sources:[]});
    if (path === '/api/v1/sessions' && req.method==='GET') return ok({items:all('session'),nextCursor:null});
    if (path === '/api/v1/sessions' && req.method==='POST') return ok(put('session',{id:randomUUID(),...body,startedAt:new Date().toISOString(),endedAt:null,revision:1}));
    const sessionPath=path.match(/^\/api\/v1\/sessions\/([^/]+)(\/entries)?$/);
    if (sessionPath) {
      const session=get(sessionPath[1]); if(!session) return error('NOT_FOUND','Conversation not found.',404);
      if (req.method==='GET') return ok({session,entries:all('entry').filter(e=>e.sessionId===session.id),nextCursor:null});
      if(heldEntry){const wait=heldEntry;heldEntry=undefined;await wait;}
      if (failEntry) {failEntry=false; return error('WRITE_FAILED','Could not save this message.',503);}
      if (body.role!=='user') return error('INVALID_ROLE','Only user entries are accepted');
      return ok(put('entry',{id:randomUUID(),sessionId:session.id,sequence:all('entry').length+1,role:'user',text:body.text,capturedAt:new Date().toISOString(),sourceRefs:[]}));
    }
    if(path==='/api/v1/chat') return error('MODEL_NOT_CONFIGURED','No model is connected.',503);
    if(path==='/api/v1/plan') { if(heldPlan){const wait=heldPlan;heldPlan=undefined;await wait;} return ok({date:url.searchParams.get('date'),timeZone:url.searchParams.get('timeZone'),items:all('commitment').filter(c=>c.status==='active'&&c.dueAt&&c.dueAt.slice(0,10)<=url.searchParams.get('date')).map(commitment=>({commitment,isOverdue:false})),unscheduled:all('commitment').filter(c=>c.status==='active'&&!c.dueAt),nextCursor:null}); }
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
  return {url:`http://127.0.0.1:${server.address().port}`,requests,failNextEntry:()=>{failEntry=true;},conflictNextWrite:()=>{conflict=true;},holdNextEntry:()=>{let release;heldEntry=new Promise(r=>release=r);return ()=>release();},holdNextPlan:()=>{let release;heldPlan=new Promise(r=>release=r);return ()=>release();},close:async()=>{await new Promise(resolve=>server.close(resolve)); db.close();}};
}

// Original pinned source shell shared by Node structural tests and the reference-only browser producer.
export function referenceSource(fixture){return `${fixture.helpers}
export class Reference {
  time=0; ambientTime=0; ambientNoiseOffset={x:0,y:0}; smoothedAudioLevel=0;
  smoothedPlaybackLevel=0; smoothedHue=null; targetPulse=0; currentPulse=0;
  smoothedLow=0; smoothedMid=0; smoothedHigh=0; smoothedFlux=0; smoothedActivity=1;
  wasSpeaking=false; state={status:'IDLE'}; microphone=0; playback={level:0,low:0,mid:0,high:0,flux:0}; audible=false;
  deviceTier={capabilities:()=>({maxAnimationLayers:10})}; ctx; noise;
  constructor(ctx, noise){this.ctx=ctx;this.noise={noise2D:noise};}
  _voiceState(){return this.state;} awaitingGreeting(){return false;}
  audioLevel(){return this.state.status==='LISTENING'?this.microphone:0;}
  playbackMeter={read:()=>this.playback,audible:()=>this.audible};
  isListening(){return this.state.status==='LISTENING';}
  isProcessing(){return this.state.status==='CONNECTING'||(this.state.status==='PROCESSING'&&!this.audible);}
  isSpeaking(){return this.state.status==='SPEAKING'||(this.state.status==='PROCESSING'&&this.audible);}
  baseHue(){${fixture.hueBody}}
  ease(current,target,attack,decay,dt){return current+(target-current)*smoothingAlpha(dt,target>current?attack:decay);}
  step(dt,status,playback,audible,microphone=0,size=600){
    this.state={status}; this.playback=playback; this.audible=audible; this.microphone=microphone;
    const state=this.state;
    ${fixture.frameBody}
    return {size,time:this.time,ambientTime:this.ambientTime,ambientNoiseOffset:{...this.ambientNoiseOffset},
      hue:primaryHue,activityMultiplier,glowIntensity,flareIntensity,
      smoothedAudioLevel:this.smoothedAudioLevel,smoothedPlaybackLevel:this.smoothedPlaybackLevel,
      smoothedLow:this.smoothedLow,smoothedMid:this.smoothedMid,smoothedHigh:this.smoothedHigh,smoothedFlux:this.smoothedFlux,
      smoothedActivity:this.smoothedActivity,targetPulse:this.targetPulse,currentPulse:this.currentPulse,
      listening:this.isListening(),speaking:this.isSpeaking(),processing:this.isProcessing()};
  }
  draw(frame){Object.assign(this,frame); this.state={status:frame.status}; this.audible=frame.audible;
    this.dispatchLayers(frame.size/2,frame.size/2,frame.size*.05,frame.hue,frame.activityMultiplier,frame.glowIntensity,frame.flareIntensity);}
  ${fixture.dispatch}
  ${fixture.classic}
}`;}

// Test-only producer: executes the original pinned noise in memory. It is never
// vendored into Didi, written to artifacts, or exposed by the product service.
async function orbProofAssets(){
  const fixture=JSON.parse(await readFile(join(import.meta.dirname,'fixtures/orb-reference.json'),'utf8'));
  const git=(args,cwd)=>execFileSync('git',['--no-pager',...args],{cwd,encoding:'utf8',env:{...process.env,GIT_PAGER:'cat',GIT_EDITOR:'true'}});
  const original=git(['show',`${fixture.referenceCommit}:${fixture.sourcePath}`],join(import.meta.dirname,'../../../vicuna'));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  if(hash(original)!==fixture.sourceSha256)throw Error('pinned original source hash mismatch');
  for(const key of ['classic','dispatch','frameBody','hueBody'])if(!original.includes(fixture[key]))throw Error(`non-original ${key} fixture`);
  const start=original.indexOf('class SimplexNoise {'),end=original.indexOf('\n}',start)+2;
  if(start<0||end<start)throw Error('original noise boundary absent');
  const originalNoise=original.slice(start,end);
  const transpile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const classic=await readFile(join(import.meta.dirname,'../src/orb-classic.ts'),'utf8');
  const frame=await readFile(join(import.meta.dirname,'../src/orb-frame.ts'),'utf8');
  const portCSS=await readFile(join(import.meta.dirname,'../src/style.css'),'utf8');
  const lifecycle=await readFile(join(import.meta.dirname,'../src/orb.ts'),'utf8');
  const assets={
    '/orb-proof/reference.js':transpile(`const Sentry={addBreadcrumb(){}};${originalNoise}\nexport {SimplexNoise};\n${referenceSource(fixture)}`),
    '/orb-proof/classic.js':transpile(classic).replace("from 'simplex-noise'","from '/orb-proof/noise.js'"),
    '/orb-proof/frame.js':transpile(frame).replace("from './orb-classic'","from '/orb-proof/classic.js'"),
    '/orb-proof/lifecycle.js':transpile(lifecycle).replace("from './orb-classic'","from '/orb-proof/classic.js'").replace("from './orb-frame'","from '/orb-proof/frame.js'"),
    '/orb-proof/noise.js':await readFile(join(import.meta.dirname,'../node_modules/simplex-noise/dist/esm/simplex-noise.js'),'utf8'),
    '/orb-proof/':`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/orb-proof/style.css"></head><body><h1>Pinned classic reference / self-variation / Didi</h1><div class="proof"><section><h2>Vicuna seed 23</h2><div class="voice-blob-container"><div class="blob-wrapper"><canvas class="blob-canvas" id="reference-a"></canvas></div></div></section><section><h2>Vicuna seed 187</h2><div class="voice-blob-container"><div class="blob-wrapper"><canvas class="blob-canvas" id="reference-b"></canvas></div></div></section><section><h2>Didi simplex-noise 4.0.3</h2><div class="orb-stage"><div class="orb-visual"><canvas id="port"></canvas></div></div></section></div><script type="module" src="/orb-proof/page.js"></script></body></html>`,
    '/orb-proof/style.css':fixture.wrapperCSS+portCSS+`body{margin:0;background:#071315;color:white;font:14px system-ui}.proof{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}canvas{display:block;width:100%;max-width:600px;height:auto;aspect-ratio:1}section{min-width:0}.proof h2{height:4.5em;line-height:1.25;margin:0}.proof .orb-stage{display:flex;min-height:0;margin:0;border:0;background:none;overflow:visible}.voice-blob-container{padding:0}h1,h2{font-size:14px}`,
    '/orb-proof/page.js':`
      import {Reference,SimplexNoise} from './reference.js';
      import {ClassicRenderer} from './classic.js';
      import {Orb} from './lifecycle.js';
      import {initialOrbFrame,stepOrbFrame} from './frame.js';
      const size=innerWidth<=767?400:600;
      const canvases=['reference-a','reference-b','port'].map(id=>document.getElementById(id));
      const contexts=canvases.map(c=>{c.width=c.height=size;return c.getContext('2d');});
      const a=new SimplexNoise(23),b=new SimplexNoise(187);
      const refs=[new Reference(contexts[0],(x,y)=>a.noise2D(x,y)),new Reference(contexts[1],(x,y)=>b.noise2D(x,y))];
      const port=new ClassicRenderer(contexts[2]);let temporal=initialOrbFrame(),last=0,deadline=0,raf,steps=0;
      let input={state:'CONNECTED',audible:false,microphoneLevel:0,audio:{level:0,low:0,mid:0,high:0,flux:0}};
      function advance(dt){
        const listening=input.state==='LISTENING',speaking=input.state==='SPEAKING'||(input.state==='PROCESSING'&&input.audible),processing=input.state==='CONNECTING'||(input.state==='PROCESSING'&&!input.audible);
        const neutral=['IDLE','DISCONNECTED','RECONNECTING','INTERRUPTED'].includes(input.state),disabled=['IDLE','DISCONNECTED','CONNECTING'].includes(input.state);
        for(const canvas of canvases.slice(0,2)){
          const wrapper=canvas.parentElement;wrapper.className='blob-wrapper'+(listening?' listening':'')+(speaking?' speaking':'')+(processing?' processing':'')+(neutral?' neutral':'')+(input.state==='RECONNECTING'?' reconnecting':'')+(['IDLE','DISCONNECTED'].includes(input.state)?' resting-breathe':'');
          wrapper.parentElement.className='voice-blob-container'+(disabled?' disabled':'');
        }
        canvases[2].dataset.state=input.state;canvases[2].dataset.posture=speaking?'speaking':listening?'listening':processing?'thinking':neutral?'quiet':input.state==='ERROR'?'error':'idle';
        if(input.state==='ERROR')delete canvases[2].dataset.disabled;else canvases[2].dataset.disabled=String(disabled);
        if(input.state==='ERROR')delete canvases[2].parentElement.dataset.disabled;else canvases[2].parentElement.dataset.disabled=String(disabled);
        contexts.forEach(ctx=>ctx.clearRect(0,0,size,size));
        refs.forEach(ref=>{const frame=ref.step(dt,input.state,input.audio,input.audible,input.microphoneLevel,size);ref.draw({...frame,status:input.state,audible:input.audible});});
        temporal=stepOrbFrame(temporal,input,dt,size);port.draw(temporal);steps++;
      }
      function tick(time){if(!deadline)deadline=time;if(time>=deadline){const dt=last?Math.min(.1,(time-last)/1000):0;last=time;advance(dt);const interval=1000/(['LISTENING','SPEAKING','PROCESSING','CONNECTING'].includes(input.state)?60:12);deadline+=(Math.floor(Math.max(0,time-deadline)/interval)+1)*interval;}raf=requestAnimationFrame(tick);}
      function measures(){
        const pixels=contexts.map(ctx=>ctx.getImageData(0,0,size,size).data);
        const difference=(a,b)=>{let sum=0,changed=0;for(let i=0;i<a.length;i++){sum+=Math.abs(a[i]-b[i]);if(a[i]!==b[i])changed++;}return {meanAbsoluteRGBA:sum/a.length,changedChannels:changed,channelCount:a.length};};
        const shape=data=>{let count=0,x0=size,y0=size,x1=-1,y1=-1,r=0,g=0,b=0;for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;if(data[i+3]){count++;x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);r+=data[i];g+=data[i+1];b+=data[i+2];}}return {paintedPixels:count,pixelCount:size*size,bounds:[x0,y0,x1,y1],meanRGB:[r/Math.max(1,count),g/Math.max(1,count),b/Math.max(1,count)]};};
        return {steps,state:input.state,audible:input.audible,logicalSize:size,tier:'high',budget:10,
          displaySizes:canvases.map(c=>({width:c.getBoundingClientRect().width,height:c.getBoundingClientRect().height,filter:getComputedStyle(c).filter,animation:getComputedStyle(c).animationName})),
          referenceSelfVariation:difference(pixels[0],pixels[1]),portVsReference:difference(pixels[0],pixels[2]),shapes:pixels.map(shape),
          frames:refs.map(ref=>({time:ref.time,ambientTime:ref.ambientTime,hue:ref.smoothedHue})).concat({time:temporal.time,ambientTime:temporal.ambientTime,hue:temporal.hue})};
      }
      globalThis.orbProof={pause(){cancelAnimationFrame(raf);raf=undefined;},resume(){last=0;deadline=0;raf=requestAnimationFrame(tick);},
        set(value){input=value;},step(dt){advance(dt);return measures();},measure:measures,
        connecting(){
          this.pause();
          // Compare constructor frames, not the reference's preceding ERROR history against a fresh Orb.
          input={state:'CONNECTING',audible:false,microphoneLevel:0,audio:{level:0,low:0,mid:0,high:0,flux:0}};
          refs[0]=new Reference(contexts[0],(x,y)=>a.noise2D(x,y));refs[1]=new Reference(contexts[1],(x,y)=>b.noise2D(x,y));
          temporal=initialOrbFrame();advance(0);
          const orb=new Orb(canvases[2],'CONNECTING');
          // Freeze every painter at the same initial source clock; CSS pulse remains independently observable.
          orb.destroy();return {dispose:()=>orb.destroy()};
        }};
      advance(0);raf=requestAnimationFrame(tick);
    `
  };
  const metadata={referenceCommit:fixture.referenceCommit,referenceSourceSha256:hash(original),originalNoiseSha256:hash(originalNoise),
    portCommit:git(['rev-parse','HEAD'],join(import.meta.dirname,'../..')).trim(),
    portSourceSha256:{classic:hash(classic),frame:hash(frame),lifecycle:hash(lifecycle),css:hash(portCSS)},pixelDomain:'unfiltered backing Canvas2D pixels; original and actual port CSS/filter/motion are separate screenshot/video evidence; ERROR recoverability unavailable',connectingComparison:'matching fresh CONNECTING constructor frames, time/ambientTime0 hue195; all painter clocks frozen, original and actual shipped CSS pulse independently observed',noise:{reference:'original inline implementation, test-only in memory, seeds 23/187',port:'shipped MIT simplex-noise4.0.3 xorshift32 seed20261009'},
    producer:'original-source standalone classic adapter, not the Angular chat application; original geometry/dispatch/state loop; matched controlled high-tier12idle60active trace, not the original lifecycle scheduler',
    servedAssets:Object.fromEntries(Object.entries(assets).map(([path,body])=>[path,hash(body)]))};
  assets['/orb-proof/metadata.json']=JSON.stringify(metadata);
  return assets;
}
