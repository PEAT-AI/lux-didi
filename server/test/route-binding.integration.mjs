import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {openFixture,result} from '../dist/test/chat-process.js';
import {composeChat} from '../dist/host/connected.js';
const dir=mkdtempSync('/tmp/didi-route-binding-'),configDir=join(dir,'config');mkdirSync(configDir,{mode:0o700});
const classes=['ordinary','private','sensitive'],preferences={dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'};
const scope={provider:'gemini',modelId:'gemini-synthetic',endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'gemini-primary',allowedClasses:classes};
const put=(name,value)=>writeFileSync(join(configDir,name),JSON.stringify(value),{mode:0o600});
put('profile.json',{schemaVersion:1,enabled:true,provider:'gemini',modelId:scope.modelId,keyReference:scope.keyReference,dataClasses:classes,preferences});
const secret={schemaVersion:2,keyReference:scope.keyReference,key:'SYNTHETIC_BINDING_KEY_111',configuredAccount:'synthetic-account',routeScope:scope,bindingGeneration:'first'};
const f=openFixture(join(dir,'store'),{generate:async request=>result(request)});let calls=0,chat,finishFirst,rotatedDuringStream=false;
const frame=(text,finished=false)=>new TextEncoder().encode('data: '+JSON.stringify({candidates:[{content:{role:'model',parts:[{text}]},...(finished?{finishReason:'STOP'}:{})}]})+'\n\n');
const transport=async()=>{calls++;if(calls===1)return new Response(new ReadableStream({start(controller){controller.enqueue(frame('Synthetic first chunk. '));finishFirst=()=>{controller.enqueue(frame('Pinned invocation finishes.',true));controller.close();};}}),{headers:{'content-type':'text/event-stream'}});return new Response(frame('Synthetic answer',true),{headers:{'content-type':'text/event-stream'}});};
try{put('gemini-primary.json',{...secret,routeScope:{...scope,modelId:'wrong'}});let composed=composeChat(f.store,f.domain,configDir,{transport});chat=composed.chat;assert.equal(composed.status.status,'error');assert.equal(calls,0);chat.shutdown();
 put('gemini-primary.json',secret);composed=composeChat(f.store,f.domain,configDir,{transport});chat=composed.chat;assert.equal(composed.status.status,'configured');
 const session=chat.enroll({title:'Synthetic binding',timeZone:'UTC',idempotencyKey:'enroll'},f.context).sessionId;
 const turn=async key=>{const run=chat.accept({sessionId:session,text:'Synthetic question',idempotencyKey:key},f.context);for await(const event of chat.subscribe(run.runId,f.context)){if(key==='first'&&event.type==='text'&&!rotatedDuringStream){rotatedDuringStream=true;put('gemini-primary.json',{...secret,bindingGeneration:'second'});finishFirst();}if(event.type==='snapshot'&&event.run.state==='terminal')return event.run;}throw Error('no terminal');};
 const first=await turn('first');assert.equal(first.outcome,'complete');assert.match(first.finalText,/Pinned invocation finishes/);assert(rotatedDuringStream);assert.equal(calls,1);
 put('gemini-primary.json',{...secret,bindingGeneration:'second'});assert.notEqual((await turn('rotation')).outcome,'complete');assert.equal(calls,1);
 chat.shutdown();composed=composeChat(f.store,f.domain,configDir,{transport});chat=composed.chat;assert.equal(composed.status.status,'configured');assert.throws(()=>chat.accept({sessionId:session,text:'Old consent',idempotencyKey:'old'},f.context),/route_changed/);
 const newSession=chat.enroll({title:'Fresh binding',timeZone:'UTC',idempotencyKey:'new'},f.context).sessionId;const run=chat.accept({sessionId:newSession,text:'Fresh turn',idempotencyKey:'new-turn'},f.context);for await(const event of chat.subscribe(run.runId,f.context))if(event.type==='snapshot'&&event.run.state==='terminal'){assert.equal(event.run.outcome,'complete');break;}
 assert.equal(calls,2);assert(!JSON.stringify(chat.conversation(newSession,f.context)).includes('synthetic-account'));
 console.log(JSON.stringify({case:'actual_chat_bound_composition',wrongScopeDenied:true,pinnedMidstreamCompletion:true,rotationBeforeNextSendDenied:true,oldConsentDenied:true,freshEnrollment:true,transportCalls:calls}));
}finally{chat?.shutdown();f.chat.shutdown();f.store.close();rmSync(dir,{recursive:true,force:true});}
