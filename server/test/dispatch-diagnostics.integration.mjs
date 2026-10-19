import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {Server,WebStandardStreamableHTTPServerTransport} from '@modelcontextprotocol/server';
const dist=new URL(process.env.DIDI_DISPATCH_DIST??'../dist/',import.meta.url);
const {Store}=await import(new URL('runtime/store.js',dist)),{hostMigrations}=await import(new URL('host/runtime.js',dist));
const {createToolsOwner}=await import(new URL('tools/index.js',dist)),{McpRegistry}=await import(new URL('adapters/mcp/registry.js',dist));
const {createMcpAdapter}=await import(new URL('adapters/mcp/adapter.js',dist)),{MemoryResultStore}=await import(new URL('adapters/mcp/store.js',dist));
const {createLiveSessionOwner,validateLiveProfile}=await import(new URL('live/index.js',dist));
const {runToolCalls}=await import(new URL('tools/declarations.js',dist));
const sha=s=>createHash('sha256').update(s).digest('hex');
const tail='UNIQUE_END_β_'+'z'.repeat(200),text='Synthetic source '.repeat(2000)+' token sk-synthetic-document-content '+tail;
const profile=validateLiveProfile({provider:'openai',liveModelId:'gpt-live-1',voice:'marin',keyReference:'openai-primary',route:{enabled:true,provider:'openai',modelId:'gpt-live-1',dataClasses:['ordinary']},prompt:{text:'Synthetic source diagnostics.',dataClass:'ordinary'}});
export async function fixture(name,args,response,callHook,toolset){
 const calls=[];const sdk=new Server({name:'synthetic-source',version:'1'},{capabilities:{tools:{}}});
 sdk.setRequestHandler('tools/list',()=>({tools:toolset??[{name,inputSchema:{type:'object',properties:Object.fromEntries(Object.entries(args).map(([k,v])=>[k,{type:Array.isArray(v)?'array':typeof v,...(Array.isArray(v)?{items:{type:'integer'}}:{})}])),required:Object.keys(args)},annotations:{readOnlyHint:true}}]}));
 sdk.setRequestHandler('tools/call',async request=>{calls.push(request.params);const value=callHook?await callHook(request.params,calls.length):response;return {...(typeof value==='string'?{content:[{type:'text',text:value}]}:value),_meta:{authorization:'synthetic-transport-secret-sentinel'}};});
 const transport=new WebStandardStreamableHTTPServerTransport({sessionIdGenerator:()=>randomUUID(),enableJsonResponse:true});await sdk.connect(transport);
 const listener=createServer(async(req,res)=>{try{const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks);const headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);const response=await transport.handleRequest(new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers,...(body.length?{body:new Uint8Array(body)}:{})}));res.writeHead(response.status,Object.fromEntries(response.headers));res.end(response.body?Buffer.from(await response.arrayBuffer()):undefined);}catch{res.writeHead(500);res.end();}});
 listener.listen(0,'127.0.0.1');await once(listener,'listening');return{calls,url:`http://127.0.0.1:${listener.address().port}/mcp`,close:async()=>{await sdk.close();await new Promise(r=>listener.close(r));}};
}
export async function replay(connector,name,args,response,{unavailable=false}={}){
 const f=await fixture(name,args,response),dir=mkdtempSync('/tmp/didi-source-durable-');let store=new Store(dir,hostMigrations),live,adapter;
 try{
  const registry=new McpRegistry(),endpoint={id:'synthetic-source',url:f.url,account:'synthetic-account',resource:connector==='google'?'gmail':'synthetic-resource'};registry.register(endpoint);registry.enable(endpoint.id);registry.allowEgress(endpoint.id);
  const ephemeral=new MemoryResultStore({maxBytes:2_000_000,maxEntries:16,ttlMs:10000});adapter=createMcpAdapter({registry,store:ephemeral});const discovered=await adapter.discover(endpoint.id);assert.equal(discovered.state,'discovered',JSON.stringify({state:discovered.state,reason:discovered.reason,exception:discovered.exception}));
  let authority;const owner=createToolsOwner({store,registry,port:adapter,ownerId:store.assistantId,lookupAuthority:async()=>authority,grantMode:'owner-trusted-reads'});
  const policy={schemaVersion:1,ownerId:store.assistantId,connectionId:'synthetic-connection',generation:1,enabled:true,connector,endpoint:{...endpoint,credentialRef:null},toolNames:[name],schemaDigest:discovered.schemaDigest,sourcePolicy:{id:'synthetic-source',revision:1,unknownClass:'ordinary',allowedClasses:['ordinary']},route:{identity:'synthetic-route',allowedClasses:['ordinary']},bounds:{maxQueryChars:500,maxSearchLimit:10,maxGetIds:3,maxEntityBytes:1_000_000,maxResultBytes:60000}};
  owner.applyConnection(policy);const refreshed=await adapter.discover(endpoint.id);assert.equal(refreshed.state,'discovered');assert.equal(refreshed.schemaDigest,policy.schemaDigest);owner.projectConnection(policy.connectionId);
  live=createLiveSessionOwner({store,voice:{},profile,timeZone:'UTC'});const created=live.create({inputClass:'ordinary',idempotencyKey:'synthetic'},{clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch});
  const accepted={ownerId:store.assistantId,actorId:'synthetic',runId:created.liveSessionId,authorityEpoch:store.authorityEpoch,revision:1,route:{identity:'synthetic-route',provider:'openai',modelId:'gpt-live-1',allowedClasses:['ordinary']},allowedClasses:['ordinary'],connectionIds:[policy.connectionId]};const hash=store.transaction(tx=>owner.snapshotRun(tx,accepted).sha256);authority={...accepted,acceptedRunHash:hash};
  const definitions=owner.definitions(accepted.runId),host={runId:accepted.runId,actorId:accepted.actorId,authorityEpoch:store.authorityEpoch,revision:1,grants:definitions.map(t=>({tool:t.name,effect:t.effect,accountId:t.accountId,resourceId:t.resourceId}))};
  const batch=await runToolCalls(owner,[{id:'source-one',name,args}],{registry:definitions,host,authority:{isCurrent:async()=>true},control:{signal:new AbortController().signal,deadlineMs:Date.now()+10000},step:0,contentIndex:0,seenIds:new Set(),baseClasses:['ordinary'],authorize:true});
  assert.equal(batch.error,undefined);assert.equal(batch.accepted.length,1);assert.equal(f.calls.length,1);
  const bounded=store.transaction(tx=>tx.get('SELECT * FROM tool_calls WHERE run_id=?',[accepted.runId]));assert(!bounded.result_json.includes(tail),'bounded model snapshot does not retain unique source tail');
  const table=store.transaction(tx=>tx.get("SELECT name FROM sqlite_schema WHERE name='tool_dispatches'"));assert(table,'RED: canonical full-source dispatch storage absent despite completed bounded model result');assert.equal(bounded.input_sha256,sha(bounded.input_json));assert.equal(bounded.input_key_count,Object.keys(args).length);
  const before=store.transaction(tx=>tx.get('SELECT * FROM tool_dispatches WHERE run_id=?',[accepted.runId]));
  if(unavailable){assert.equal(before.state,'unavailable');assert.equal(before.reason,'structured_source_projection_unavailable');assert.equal(before.source_json,null);return{connector,state:before.state,reason:before.reason};}
  assert.equal(before.state,'completed');assert(before.source_json.includes(tail));assert.equal(before.source_sha256,sha(before.source_json));assert.equal(before.source_bytes,Buffer.byteLength(before.source_json));assert.equal(before.wire_state,'observed');assert(!before.source_json.includes('synthetic-transport-secret-sentinel'));assert(before.wire_at>=before.started_at);assert(before.wire_mono_ms>=before.started_mono_ms);
  const projected=JSON.parse(before.source_json);if(typeof response==='object')assert.deepEqual(projected.content,response.content,'all original meaningful text is preserved exactly');
  assert.deepEqual(JSON.parse(before.arguments_json),f.calls[0].arguments);assert.equal(before.arguments_sha256,sha(before.arguments_json));assert.equal(before.arguments_key_count,Object.keys(f.calls[0].arguments).length);
  await live.shutdown();live=undefined;await adapter.close();adapter=undefined;store.close();store=new Store(dir,hostMigrations);
  const empty=new MemoryResultStore();assert.equal(empty.read({handle:'missing',endpointId:endpoint.id,generation:1,account:endpoint.account,resource:endpoint.resource,offset:0,length:1},()=>true).state,'unavailable');
  const {readDiagnosticDispatches}=await import(new URL('tools/dispatch.js',dist));
  const report=store.transaction(tx=>readDiagnosticDispatches(tx,accepted.runId,{ownerId:store.assistantId,allowedClasses:['ordinary']}));assert.equal(report.access.state,'allowed');assert.equal(report.dispatches.length,1);assert.equal(report.dispatches[0].read_state,'allowed');assert(report.dispatches[0].source_json.includes(tail));assert.equal(sha(report.dispatches[0].source_json),before.source_sha256);
  assert(report.dispatches[0].source_json.includes('sk-synthetic-document-content'),'authorized document words remain intact');assert(!report.dispatches[0].source_json.includes('jsonrpc'),'RPC framing excluded');
  store.transaction(tx=>tx.run("INSERT INTO history_exclusions VALUES('live',?,?)",[accepted.runId,Date.now()]));assert.equal(store.transaction(tx=>readDiagnosticDispatches(tx,accepted.runId,{ownerId:store.assistantId,allowedClasses:['ordinary']})).dispatches.length,0);
  return{connector,sourceBytes:before.source_bytes,entityBytes:before.entity_bytes,tailBeyond20k:before.source_json.indexOf(tail)>20000,wire:before.wire_state,reopenedEmptyAdapter:true,canonicalExclusionDenied:true};
 }finally{await live?.shutdown();await adapter?.close();store.close();await f.close();rmSync(dir,{recursive:true,force:true});}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
const cases=[];cases.push(await replay('lux-knowledge','get_insight',{ids:[101]},text));cases.push(await replay('mongoose','get_knowledge_item',{id:'synthetic-item'},text));cases.push(await replay('google','gmail_read',{id:'synthetic-message',format:'full'},JSON.stringify({data:{id:'synthetic-message',subject:'Synthetic',body:text,from:'synthetic@example.invalid'}})));console.log(JSON.stringify({case:'canonical_full_source_close_reopen',cases}));

}
export {profile,text,tail};
