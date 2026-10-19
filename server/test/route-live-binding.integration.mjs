import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../dist/runtime/store.js';
import {hostMigrations} from '../dist/host/runtime.js';
import {composeLive} from '../dist/host/live.js';
import {fixture} from '../dist/test/openai-live-voice-fixture.js';
const dir=mkdtempSync('/tmp/didi-live-binding-'),configDir=join(dir,'config');mkdirSync(configDir,{mode:0o700});
const store=new Store(join(dir,'store'),hostMigrations),cleanups=[],wire=await fixture({after:callback=>cleanups.push(callback)}),classes=['ordinary','private'];let service;
const put=(name,value)=>writeFileSync(join(configDir,name),JSON.stringify(value),{mode:0o600});
const preferences={dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'};
const scope={provider:'openai',modelId:'gpt-live-1',endpoint:'https://api.openai.com/v1',apiVersion:'v1',keyReference:'openai-primary',allowedClasses:classes};
const secret={schemaVersion:2,keyReference:scope.keyReference,key:'SYNTHETIC_LIVE_BINDING_133',configuredAccount:'synthetic-account',routeScope:scope,bindingGeneration:'before'};
const live={schemaVersion:1,enabled:true,provider:'openai',voice:'marin',dataClasses:classes,preferences,accent:'voice-default',limits:{closeMs:10,handshakeMs:5000}};
const context={clientId:'synthetic',auditId:'synthetic',authorityEpoch:store.authorityEpoch};
try{
 put('live.json',live);put('openai-primary.json',secret);let composed=composeLive(store,configDir,{socketFactory:wire.socketFactory});service=composed.service;assert.equal(composed.status.status,'configured');
 const first=service.create('ordinary','first',context),identity=first.profileIdentity;assert.equal(composed.status.profileIdentity,identity);const attached=service.attach(first.liveSessionId,context);await wire.frame(1);wire.send({type:'session.started',session:{id:'synthetic'}});await attached.ready;assert.equal(wire.connections,1);assert.equal(wire.authorization,'Bearer '+secret.key);
 put('openai-primary.json',{...secret,bindingGeneration:'after'});assert.throws(()=>service.create('ordinary','rotation',context),/binding_changed/);assert.equal(service.lookupAuthority(first.liveSessionId),null);assert.equal(service.snapshot(first.liveSessionId).lifecycle,'terminal');assert.equal(wire.connections,1);await attached.close();await service.shutdown();
 composed=composeLive(store,configDir,{socketFactory:wire.socketFactory});service=composed.service;assert.equal(composed.status.status,'configured');const fresh=service.create('ordinary','fresh',context);assert.notEqual(fresh.profileIdentity,identity);assert.throws(()=>service.attach(first.liveSessionId,context));put('openai-primary.json',{...secret,bindingGeneration:'third'});assert.throws(()=>service.attach(fresh.liveSessionId,context),/binding_changed/);assert.equal(wire.connections,1);await service.shutdown();
 put('openai-primary.json',{...secret,routeScope:{...scope,allowedClasses:['ordinary']}});composed=composeLive(store,configDir,{socketFactory:wire.socketFactory});service=composed.service;assert.equal(composed.status.status,'error');assert.equal(wire.connections,1);await service.shutdown();
 put('live.json',{...live,provider:'gemini',voice:'Aoede',modelId:'models/gemini-synthetic'});composed=composeLive(store,configDir,{socketFactory:wire.socketFactory});service=composed.service;assert.equal(composed.status.code,'shared_slot_conflict');
 console.log(JSON.stringify({case:'actual_live_bound_composition',socketConnections:wire.connections,generationInIdentity:true,nextCreateInvalidatesOldSession:true,oldAttachDenied:true,rotationBeforeAttachDenied:true,wrongScopeDenied:true,sharedGeminiConflict:true,pcmFramesSent:0}));
}finally{await service?.shutdown();for(const cleanup of cleanups.reverse())await cleanup();store.close();rmSync(dir,{recursive:true,force:true});}
