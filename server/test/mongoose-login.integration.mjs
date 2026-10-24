import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {runMongooseLogin} from '../dist/host/mongoose-login.js';
import {main} from '../dist/host/index.js';
const json=(response,value)=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(value));};
for(const mode of ['success','state','discovery','discovery-body','registration','registration-body','callback','exchange','exchange-body']){
 const dir=mkdtempSync('/tmp/didi-oauth-'),requests=[],pending=[],sockets=new Set();let shown=0,opened=0,redirect,challenge,exchange,origin;
 const server=createServer(async(req,res)=>{const url=new URL(req.url,origin);requests.push(url.pathname);
  const hanging=(mode.startsWith('discovery')&&url.pathname.includes('protected-resource'))||(mode.startsWith('registration')&&url.pathname==='/register')||(mode.startsWith('exchange')&&url.pathname==='/token');
  if(hanging){if(mode.endsWith('-body')){res.writeHead(200,{'content-type':'application/json'});res.write('{');}return;}
  if(url.pathname.includes('protected-resource'))return json(res,{resource:'mongoose:knowledge',authorization_servers:[origin]});
  if(url.pathname.includes('authorization-server'))return json(res,{authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register'});
  let body='';for await(const bytes of req)body+=bytes;
  if(url.pathname==='/register'){const value=JSON.parse(body);assert.equal(value.token_endpoint_auth_method,'none');assert.equal(value.scope,'mcp');redirect=value.redirect_uris[0];return json(res,{client_id:'synthetic-client'});}
  if(url.pathname==='/token'){exchange=Object.fromEntries(new URLSearchParams(body));return json(res,{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});}
  res.writeHead(404).end();
 });server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 const started=Date.now();try{
  const operation=runMongooseLogin({configDir:dir,reference:'mongoose-knowledge',resourceUrl:origin+'/mcp/knowledge',endpoint:'knowledge',account:'synthetic',redirectPort:0,timeoutMs:mode==='success'||mode==='state'?2000:100,
   openBrowser:()=>{opened++;throw Error('must not open a browser');},showAuthorizationUrl:url=>{shown++;const auth=new URL(url);challenge=auth.searchParams.get('code_challenge');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert.equal(auth.searchParams.get('redirect_uri'),redirect);
    if(mode!=='callback'){const callback=new URL(redirect);callback.searchParams.set('code','synthetic-code');callback.searchParams.set('state',mode==='state'?'wrong':auth.searchParams.get('state'));pending.push(fetch(callback).then(r=>r.text()));}
   }});
  if(mode==='success'){const record=await operation;assert.equal(record.accessToken,'synthetic-access');assert.equal(challenge,createHash('sha256').update(exchange.code_verifier).digest('base64url'));assert.equal(statSync(dir+'/mongoose-knowledge.json').mode&0o777,0o600);assert.equal(JSON.parse(readFileSync(dir+'/mongoose-knowledge.json')).account,'synthetic');assert.equal(shown,1);}
  else{await assert.rejects(operation,e=>e.code===(mode==='state'?'state-mismatch':'timeout'));assert.deepEqual(readdirSync(dir),[]);assert(Date.now()-started<1500);}
  assert.equal(opened,0);await Promise.all(pending);
  if(redirect){const probe=createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(Number(new URL(redirect).port),'127.0.0.1',resolve);});await new Promise(resolve=>probe.close(resolve));}
 }finally{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
}
await assert.rejects(main(['--no-browser']),/Invalid sign-in configuration/);
await assert.rejects(main(['--mongoose-login','--no-browser','--no-browser']),/Invalid sign-in configuration/);
// Actual host CLI composition, with synthetic endpoint discovery and a real loopback callback.
const dir=mkdtempSync('/tmp/didi-login-cli-'),originalFetch=globalThis.fetch,originalWrite=process.stdout.write;let output='',callback;
writeFileSync(dir+'/mcp.json',JSON.stringify({schemaVersion:1,grantMode:'owner-trusted-reads',endpoints:[{id:'mongoose-knowledge',transport:'streamable-http',url:'https://synthetic.invalid/mcp/knowledge',connector:'mongoose',account:'synthetic',resource:'mongoose:knowledge',credentialRef:'mongoose-knowledge',enabled:true,allowEgress:true,unknownClass:'ordinary'},{id:'mongoose-data',transport:'streamable-http',url:'https://synthetic.invalid/mcp/data',connector:'mongoose',account:'synthetic',resource:'mongoose:data',credentialRef:'mongoose-data',enabled:true,allowEgress:true,unknownClass:'ordinary'},{id:'mongoose-crm',transport:'streamable-http',url:'https://synthetic.invalid/mcp/crm',connector:'mongoose',account:'synthetic',resource:'mongoose:crm',credentialRef:'mongoose-crm',enabled:true,allowEgress:true,unknownClass:'ordinary'}]}),{mode:0o600});
try{
 globalThis.fetch=async(url,options)=>{const path=new URL(url).pathname;if(path.includes('protected-resource'))return Response.json({resource:new URL(url).pathname.endsWith('/knowledge')?'mongoose:knowledge':new URL(url).pathname.endsWith('/data')?'mongoose:data':'mongoose:crm',authorization_servers:['https://synthetic.invalid']});if(path.includes('authorization-server'))return Response.json({authorization_endpoint:'https://synthetic.invalid/authorize',token_endpoint:'https://synthetic.invalid/token',registration_endpoint:'https://synthetic.invalid/register'});if(path==='/register')return Response.json({client_id:'synthetic-client'});if(path==='/token')return Response.json({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600});throw Error('unexpected URL');};
 process.stdout.write=function(chunk,...args){const text=String(chunk);output+=text;const match=text.match(/https:\/\/synthetic\.invalid\/authorize\?[^\s]+/);if(match){const auth=new URL(match[0]),url=new URL(auth.searchParams.get('redirect_uri'));url.searchParams.set('code','synthetic-code');url.searchParams.set('state',auth.searchParams.get('state'));callback=originalFetch(url).then(r=>r.text());}return true;};
 await main(['--mongoose-login','--no-browser','--config-dir',dir]);await callback;assert.match(output,/Mongoose sign-in complete/);assert(!output.includes('synthetic-access'));assert(!output.includes('synthetic-refresh'));assert.equal(JSON.parse(readFileSync(dir+'/mongoose-knowledge.json')).account,'synthetic');
}finally{globalThis.fetch=originalFetch;process.stdout.write=originalWrite;rmSync(dir,{recursive:true,force:true});}
console.log(JSON.stringify({case:'bounded_no_browser_oauth',actualCli:true,noBrowserOpens:true,stateAndPkcePreserved:true,deadlineStages:7,closedCallbacks:true,privateRecord:true,noTokensPrinted:true}));
