import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,lstatSync,symlinkSync,linkSync,chmodSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setRouteClasses} from '../dist/config/route-classes.js';
const module=pathToFileURL(resolve('server/dist/config/route-classes.js')).href;
const preferences={dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'},scope={provider:'gemini',modelId:'gemini-synthetic',endpoint:'https://generativelanguage.googleapis.com',apiVersion:'v1beta',keyReference:'gemini-primary',allowedClasses:['ordinary','private']};
function fixture(){const dir=mkdtempSync('/tmp/didi-route-lock-'),put=(n,v)=>writeFileSync(dir+'/'+n,typeof v==='string'?v:JSON.stringify(v),{mode:0o600});
 put('profile.json',{schemaVersion:1,enabled:true,provider:'gemini',modelId:scope.modelId,keyReference:scope.keyReference,dataClasses:scope.allowedClasses,preferences});
 put('gemini-primary.json',{schemaVersion:2,keyReference:scope.keyReference,key:'SYNTHETIC_LOCK_KEY',configuredAccount:'synthetic',routeScope:scope,bindingGeneration:'before'});
 put('binding.json',{schemaVersion:1,configuredAccount:'synthetic',routeScope:{...scope,allowedClasses:[...scope.allowedClasses,'sensitive']},bindingGeneration:'after'});
 return{dir,put,options:{configDir:dir,ownerId:'synthetic',surface:'text',bindingInputPath:dir+'/binding.json',expectedGeneration:'before'}};}
const f=fixture(),pause=new Int32Array(new SharedArrayBuffer(4)),original=DatabaseSync.prototype.exec;let child,stderr='',forced=false,childExit;
try{
 DatabaseSync.prototype.exec=function(sql){
  if(sql.includes('BEGIN EXCLUSIVE')&&!forced){forced=true;
   const code=`import{setRouteClasses}from${JSON.stringify(module)};import{writeFileSync,existsSync}from'node:fs';const p=new Int32Array(new SharedArrayBuffer(4));setRouteClasses(${JSON.stringify(f.options)},stage=>{if(stage==='marker'){writeFileSync(${JSON.stringify(f.dir+'/ready')},'ready');let n=0;while(!existsSync(${JSON.stringify(f.dir+'/go')})){if(n++>500)throw Error('bounded probe timeout');Atomics.wait(p,0,0,10);}}});`;
   child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',b=>stderr+=b);childExit=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})));let n=0;
   while(!existsSync(f.dir+'/ready')){if(n++>500)throw Error('child did not reach marker');Atomics.wait(pause,0,0,10);}
  }return original.call(this,sql);
 };
 assert.throws(()=>setRouteClasses(f.options),/configuration_pending/);process.kill(child.pid,0);assert(forced);DatabaseSync.prototype.exec=original;
 const inode=lstatSync(f.dir+'/.route-classes.lock.sqlite').ino;f.put('go','go');const exit=await childExit;assert.equal(exit.code,0,stderr);assert.equal(lstatSync(f.dir+'/.route-classes.lock.sqlite').ino,inode);assert.equal(JSON.parse(readFileSync(f.dir+'/gemini-primary.json')).bindingGeneration,'after');assert(!readFileSync(f.dir+'/.route-classes.lock.sqlite').includes(Buffer.from('SYNTHETIC_LOCK_KEY')));
 console.log(JSON.stringify({case:'overtaken_lock_contender',secondSetterRefusedWhileFirstAlive:true,firstSetterExit:exit.code,stableInode:true,exactSuccessor:true,noKeyInLock:true}));
}finally{DatabaseSync.prototype.exec=original;if(child&&child.exitCode===null){child.kill('SIGKILL');await childExit;}rmSync(f.dir,{recursive:true,force:true});}
for(const mode of ['symlink','hardlink','permissions','directory','oversize']){const f=fixture(),path=f.dir+'/.route-classes.lock.sqlite';try{
 if(mode==='symlink')symlinkSync(f.dir+'/binding.json',path);
 if(mode==='hardlink')linkSync(f.dir+'/binding.json',path);
 if(mode==='permissions'){f.put('.route-classes.lock.sqlite','');chmodSync(path,0o644);}
 if(mode==='directory')mkdirSync(path,{mode:0o700});
 if(mode==='oversize')f.put('.route-classes.lock.sqlite','x'.repeat(65537));
 const before=readFileSync(f.dir+'/gemini-primary.json');assert.throws(()=>setRouteClasses(f.options));assert.deepEqual(readFileSync(f.dir+'/gemini-primary.json'),before);
 }finally{rmSync(f.dir,{recursive:true,force:true});}}
console.log(JSON.stringify({case:'protected_stable_lock',invalidPathsRefused:5}));
