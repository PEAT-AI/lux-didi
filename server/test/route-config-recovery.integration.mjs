import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setRouteClasses} from '../dist/config/route-classes.js';
import {loadProviderConfig,credentialsFor,credentialReceiptFor} from '../dist/config/index.js';
import {loadLiveConfig} from '../dist/config/live.js';
const key='SYNTHETIC_RECOVERY_KEY_822',classes=['ordinary','private'];
const preferences={dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'};
const scope={provider:'gemini',modelId:'gemini-synthetic',endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'gemini-primary',allowedClasses:classes};
function fixture(){const dir=mkdtempSync('/tmp/didi-route-recovery-'),put=(name,value)=>writeFileSync(join(dir,name),typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
 put('profile.json',{schemaVersion:1,enabled:true,provider:'gemini',modelId:scope.modelId,keyReference:scope.keyReference,dataClasses:classes,preferences});
 put('live.json',{schemaVersion:1,enabled:true,provider:'openai',voice:'marin',dataClasses:classes,preferences});
 put('gemini-primary.json',{schemaVersion:2,keyReference:scope.keyReference,key,configuredAccount:'synthetic-account',routeScope:scope,bindingGeneration:'before'});
 put('binding.json',{schemaVersion:1,configuredAccount:'synthetic-account',routeScope:{...scope,allowedClasses:[...classes,'sensitive']},bindingGeneration:'after'});
 return {dir,put,options:{configDir:dir,ownerId:'synthetic-owner',surface:'text',bindingInputPath:join(dir,'binding.json'),expectedGeneration:'before'}};}
const module=pathToFileURL(resolve('server/dist/config/route-classes.js')).href;
const stages=['marker','stage0','stage1','rename0','sync0','rename1','sync1'];
for(const stage of stages){const f=fixture();try{
 const script=`import {setRouteClasses} from ${JSON.stringify(module)};setRouteClasses(${JSON.stringify(f.options)},stage=>{if(stage===${JSON.stringify(stage)})process.kill(process.pid,'SIGKILL');});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.signal,'SIGKILL',child.stderr);
 assert.equal(loadProviderConfig(f.options).code,'configuration_pending');assert.equal(loadLiveConfig(f.options).code,'configuration_pending');await assert.rejects(credentialsFor(f.dir).resolve('gemini-primary'),/configuration_pending/);assert.throws(()=>credentialReceiptFor(f.dir,scope),/configuration_pending/);
 const active=readFileSync(join(f.dir,'gemini-primary.json'),'utf8');f.put('binding.json',JSON.parse(readFileSync(join(f.dir,'binding.json'),'utf8')));assert.equal(setRouteClasses(f.options).generation,'after');assert.equal(JSON.parse(readFileSync(join(f.dir,'gemini-primary.json'),'utf8')).key,key);assert.equal(loadProviderConfig(f.options).status,'ready');
 assert(!child.stdout.includes(key));assert(!child.stderr.includes(key));
 }finally{rmSync(f.dir,{recursive:true,force:true});}}
for(const mode of ['changed-input','unknown-predecessor','unknown-stage','concurrent','symlink','hardlink','mode','duplicate']){const f=fixture();try{
 const before=readFileSync(join(f.dir,'gemini-primary.json'),'utf8');
 if(['changed-input','unknown-predecessor','unknown-stage'].includes(mode)){assert.throws(()=>setRouteClasses(f.options,stage=>{if(stage==='marker')throw Error('synthetic interruption');}));
  if(mode==='changed-input'){const value=JSON.parse(readFileSync(f.options.bindingInputPath,'utf8'));value.bindingGeneration='different';f.put('binding.json',value);}
  if(mode==='unknown-predecessor'){const value=JSON.parse(before);value.key='OTHER_SYNTHETIC';f.put('gemini-primary.json',value);}
  if(mode==='unknown-stage')f.put('.route-classes.0','unknown');
  const preserved=readFileSync(join(f.dir,'gemini-primary.json'),'utf8');assert.throws(()=>setRouteClasses(f.options));assert.equal(readFileSync(join(f.dir,'gemini-primary.json'),'utf8'),preserved);
 }else if(mode==='concurrent'){setRouteClasses(f.options,stage=>{if(stage==='marker'){const result=spawnSync(process.execPath,['--input-type=module','-e',`import {setRouteClasses} from ${JSON.stringify(module)};setRouteClasses(${JSON.stringify(f.options)});`],{encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/configuration_pending/);}});
 }else{if(mode==='symlink'){f.options.bindingInputPath=join(f.dir,'alias');symlinkSync(join(f.dir,'binding.json'),f.options.bindingInputPath);}if(mode==='hardlink')linkSync(join(f.dir,'binding.json'),join(f.dir,'alias'));if(mode==='mode')chmodSync(join(f.dir,'binding.json'),0o644);if(mode==='duplicate')f.put('binding.json','{"schemaVersion":1,"schemaVersion":1}');assert.throws(()=>setRouteClasses(f.options));assert.equal(readFileSync(join(f.dir,'gemini-primary.json'),'utf8'),before);}
 }finally{rmSync(f.dir,{recursive:true,force:true});}}
console.log(JSON.stringify({case:'canonical_route_recovery',killedPublicationStages:stages.length,pendingReadersRefused:4,exactResume:true,mutationAndConcurrencyControls:8,keySentinelAbsent:true}));
