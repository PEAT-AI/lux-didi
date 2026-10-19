import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync('/tmp/didi-route-config-'),key='SYNTHETIC_KEY_SENTINEL_501';
const put=(name,value)=>writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
const preferences={dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'};
const scope={provider:'gemini',modelId:'gemini-synthetic',endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'gemini-primary',allowedClasses:['ordinary','private']};
const profile={schemaVersion:1,enabled:true,provider:'gemini',modelId:scope.modelId,keyReference:scope.keyReference,dataClasses:scope.allowedClasses,preferences};
const live={schemaVersion:1,enabled:true,provider:'openai',modelId:'gpt-live-1',keyReference:'openai-primary',voice:'marin',dataClasses:scope.allowedClasses,preferences,playbackRate:1.1};
const binding={schemaVersion:1,configuredAccount:'synthetic-account',routeScope:{...scope,allowedClasses:['ordinary','private','sensitive']},bindingGeneration:'next'};
function seed(){put('profile.json',profile);put('live.json',live);put('gemini-primary.json',{schemaVersion:2,keyReference:scope.keyReference,key,configuredAccount:binding.configuredAccount,routeScope:scope,bindingGeneration:'previous'});put('binding.json',binding);put('unrelated.json','{"private":"synthetic unchanged"}\n');}
const cli=(extra=[],surface='text')=>spawnSync(process.execPath,['server/dist/config/cli.js','set-route-classes','--config-dir',dir,'--owner-id','synthetic-owner','--surface',surface,'--binding-input',join(dir,'binding.json'),'--expected-generation','previous',...extra],{encoding:'utf8'});
try{seed();const before=readFileSync(join(dir,'gemini-primary.json'),'utf8');let result=cli(['--dry-run']);assert.equal(result.status,0,result.stderr);assert.equal(readFileSync(join(dir,'gemini-primary.json'),'utf8'),before);assert(!result.stdout.includes(key));
 result=cli();assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(readFileSync(join(dir,'gemini-primary.json'),'utf8')).key,key);assert.equal(JSON.parse(readFileSync(join(dir,'gemini-primary.json'),'utf8')).bindingGeneration,'next');assert.deepEqual(JSON.parse(readFileSync(join(dir,'profile.json'),'utf8')),{...profile,dataClasses:binding.routeScope.allowedClasses});assert.equal(readFileSync(join(dir,'unrelated.json'),'utf8'),'{"private":"synthetic unchanged"}\n');assert.deepEqual(JSON.parse(readFileSync(join(dir,'live.json'),'utf8')),live);assert(!result.stdout.includes(key));assert(!result.stderr.includes(key));assert.equal(cli().status,1);
 for(const [field,value] of [['configuredAccount','other'],['bindingGeneration','previous']]){seed();put('binding.json',{...binding,[field]:value});assert.equal(cli().status,1);assert.equal(readFileSync(join(dir,'gemini-primary.json'),'utf8'),before);}
 for(const [field,value] of [['provider','openai'],['modelId','wrong'],['endpoint','https://wrong.invalid'],['apiVersion','wrong'],['keyReference','openai-primary']]){seed();put('binding.json',{...binding,routeScope:{...binding.routeScope,[field]:value}});assert.equal(cli().status,1);assert.equal(readFileSync(join(dir,'gemini-primary.json'),'utf8'),before);}
 seed();const liveScope={...scope,provider:'openai',modelId:'gpt-live-1',endpoint:'https://api.openai.com/v1',apiVersion:'v1',keyReference:'openai-primary'};
 put('openai-primary.json',{schemaVersion:2,keyReference:liveScope.keyReference,key,configuredAccount:binding.configuredAccount,routeScope:liveScope,bindingGeneration:'previous'});
 put('binding.json',{...binding,routeScope:{...liveScope,allowedClasses:binding.routeScope.allowedClasses}});
 result=cli([],'live');assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(readFileSync(join(dir,'live.json'),'utf8')),{...live,dataClasses:binding.routeScope.allowedClasses});assert.deepEqual(JSON.parse(readFileSync(join(dir,'profile.json'),'utf8')),profile);assert.equal(JSON.parse(readFileSync(join(dir,'openai-primary.json'),'utf8')).key,key);
 seed();put('live.json',{...live,limits:{idleMs:0}});assert.equal(cli().status,1);
 assert(!readdirSync(dir).some(name=>name.startsWith('.route-classes') && name !== '.route-classes.lock.sqlite'));console.log(JSON.stringify({case:'canonical_route_class_cli',dryRun:true,textAndLive:true,invalidLiveLimitsRefused:true,exactFieldsRefused:7,keyPreserved:true,unrelatedPreserved:true,reusedGenerationRefused:true}));
}finally{rmSync(dir,{recursive:true,force:true});}
