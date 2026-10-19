import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {openFixture,result} from '../dist/test/chat-process.js';
import {composeChat} from '../dist/host/connected.js';
import {liveMigrations} from '../dist/live/schema.js';
import {composeLive} from '../dist/host/live.js';
import {fixture} from '../dist/test/openai-live-voice-fixture.js';
const dir=mkdtempSync('/tmp/didi-route-enrollment-'),configDir=join(dir,'config');mkdirSync(configDir,{mode:0o700});
const classes=['ordinary','private'],preferences={dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'};
const put=(name,obj)=>writeFileSync(join(configDir,name),JSON.stringify(obj),{mode:0o600});
const scopes={text:{provider:'gemini',modelId:'gemini-3.8-flash',endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'gemini-primary',allowedClasses:classes},live:{provider:'openai',modelId:'gpt-live-1',endpoint:'https://api.openai.com/v1',apiVersion:'v1',keyReference:'openai-primary',allowedClasses:classes}};
put('profile.json',{schemaVersion:1,enabled:true,provider:'gemini',modelId:scopes.text.modelId,keyReference:scopes.text.keyReference,dataClasses:classes,preferences});
put('live.json',{schemaVersion:1,enabled:true,provider:'openai',modelId:'gpt-live-1',voice:'marin',keyReference:'openai-primary',dataClasses:classes,preferences,playbackRate:1,limits:{closeMs:10,handshakeMs:5000}});
const originals=new Map();for(const scope of Object.values(scopes)){put(scope.keyReference+'.json',{schemaVersion:1,keyReference:scope.keyReference,key:'SYNTHETIC_V1_KEY_991'});originals.set(scope.keyReference,readFileSync(join(configDir,scope.keyReference+'.json')));}
const receipt=routeScope=>({schemaVersion:1,configuredAccount:'synthetic-account',routeScope,bindingGeneration:'enrolled'});
const f=openFixture(join(dir,'store'),{generate:async request=>result(request)},{},undefined,liveMigrations),cleanups=[],wire=await fixture({after:callback=>cleanups.push(callback)});let chat,live,calls=0;
const cli=(surface)=>spawnSync(process.execPath,['server/dist/config/cli.js','migrate-binding','--config-dir',configDir,'--owner-id',f.store.assistantId,'--surface',surface,'--binding-input',join(configDir,'binding.json')],{encoding:'utf8'});
const transport=async()=>{calls++;return new Response('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text:'Synthetic enrolled answer'}]},finishReason:'STOP'}]})+'\n\n',{headers:{'content-type':'text/event-stream'}});};
try{
 let composed=composeChat(f.store,f.domain,configDir,{transport});chat=composed.chat;assert.equal(composed.status.status,'error');chat.shutdown();let voice=composeLive(f.store,configDir,{socketFactory:wire.socketFactory});live=voice.service;assert.equal(voice.status.status,'error');await live.shutdown();
 for(const surface of ['text','live']){
  const scope=scopes[surface],active=join(configDir,scope.keyReference+'.json');
  put('binding.json',receipt({...scope,modelId:surface==='text'?'wrong-model':'gpt-live-wrong'}));let attempt=cli(surface);assert.equal(attempt.status,1);assert.match(attempt.stderr,/invalid_secret/);assert.deepEqual(readFileSync(active),originals.get(scope.keyReference));
  put('binding.json',receipt(scope));attempt=cli(surface);assert.equal(attempt.status,0,attempt.stderr);assert.deepEqual(readFileSync(join(configDir,scope.keyReference+'.legacy.json')),originals.get(scope.keyReference));assert.equal(JSON.parse(readFileSync(active)).key,'SYNTHETIC_V1_KEY_991');
  const enrolled=readFileSync(active);attempt=cli(surface);assert.equal(attempt.status,1);assert.match(attempt.stderr,/invalid_secret/);assert.deepEqual(readFileSync(active),enrolled);
  writeFileSync(active,originals.get(scope.keyReference));attempt=cli(surface);assert.equal(attempt.status,1);assert.match(attempt.stderr,/destination_exists/);assert.deepEqual(readFileSync(active),originals.get(scope.keyReference));writeFileSync(active,enrolled);
  assert(!JSON.stringify(attempt).includes('SYNTHETIC_V1_KEY_991'));
 }
 composed=composeChat(f.store,f.domain,configDir,{transport});chat=composed.chat;assert.equal(composed.status.status,'configured');const session=chat.enroll({title:'Enrolled',timeZone:'UTC',idempotencyKey:'enroll'},f.context).sessionId;
 const run=chat.accept({sessionId:session,text:'Synthetic enrollment check',idempotencyKey:'turn'},f.context);for await(const event of chat.subscribe(run.runId,f.context))if(event.type==='snapshot'&&event.run.state==='terminal'){assert.equal(event.run.outcome,'complete');break;}assert.equal(calls,1);
 voice=composeLive(f.store,configDir,{socketFactory:wire.socketFactory});live=voice.service;assert.equal(voice.status.status,'configured');const context={clientId:'synthetic',auditId:'synthetic',authorityEpoch:f.store.authorityEpoch},created=live.create('ordinary','enrolled',context),attached=live.attach(created.liveSessionId,context);await wire.frame(1);wire.send({type:'session.started',session:{id:'synthetic'}});await attached.ready;assert.equal(wire.connections,1);await attached.close();
 console.log(JSON.stringify({case:'legacy_primary_enrollment',explicitSurfaces:2,exactBackups:2,wrongScopeAndV2AndBackupRefused:true,keyPreserved:true,actualChatCalls:calls,actualLiveConnections:wire.connections,pcmFramesSent:0}));
}finally{chat?.shutdown();await live?.shutdown();for(const cleanup of cleanups.reverse())await cleanup();f.chat.shutdown();f.store.close();rmSync(dir,{recursive:true,force:true});}
