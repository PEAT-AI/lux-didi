import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {Store} from '../dist/runtime/store.js';
import {domainMigrations} from '../dist/domain/schema.js';
import {createSession,appendEntry,deleteEntry} from '../dist/domain/memory.js';
import {correct} from '../dist/domain/labels.js';
import {parseImportFile,planImport,applyImport} from '../dist/memory/import.js';
import {createHistoryReader} from '../dist/domain/history-reader.js';
const dir=mkdtempSync('/tmp/didi-history-retention-'),now=Date.now(),clock={now:()=>now};let store=new Store(dir,domainMigrations);
const item={id:'0123456789abcdef',kind:'fact',label:'Synthetic',topic:'engineering',status:'current',importance:3,confidence:'high',capturedAt:'2026-08-20',text:'Synthetic zephyr imported decision.',sources:[]};
try{
 const parsed=parseImportFile(JSON.stringify(item));assert.equal(parsed.rejected.length,0,JSON.stringify(parsed));
 const imported=store.transaction(tx=>applyImport(tx,planImport(tx,parsed,'first',undefined),clock));assert.equal(imported.entryIds.length,1);
 let scope={ownerId:store.assistantId,runId:'retention-fixture',routeIdentity:'synthetic',authorityEpoch:store.authorityEpoch,revision:1,allowedClasses:['ordinary']};
 let reader=createHistoryReader();let read=args=>store.transaction(tx=>reader.read(tx,scope,args));
 assert.equal(read({query:'zephyr'}).response.hits[0].derivation,'imported_note');
 store.transaction(tx=>deleteEntry(tx,imported.entryIds[0],new Date(now).toISOString(),'synthetic'));
 store.close();store=new Store(dir,domainMigrations);reader=createHistoryReader();scope={...scope,authorityEpoch:store.authorityEpoch};
 const reimport=store.transaction(tx=>planImport(tx,parsed,'second',undefined));assert.equal(reimport.accepted.length,0);assert.equal(reimport.tombstoned.length,1);assert.equal(read({query:'zephyr'}).response.hits.length,0);
 store.transaction(tx=>{
  createSession(tx,{title:'Synthetic corpus',startedAt:now,timeZone:'UTC'},clock,'corpus');correct(tx,{subject:{kind:'session',id:'corpus'},expectedRevision:0,dataClass:'ordinary'},now);
  for(let n=0;n<1001;n++){const id='corpus-'+n;appendEntry(tx,{sessionId:'corpus',text:n===0?'Mira chose ultraviolet flags.':'Unrelated groceries record '+n,capturedAt:n===0?now-60*86400000:now+n,timeZone:'UTC'},clock,id);correct(tx,{subject:{kind:'entry',id},expectedRevision:0,dataClass:'ordinary'},now);}
 });
 const at=performance.now(),search=read({query:'Mira ultraviolet'}),elapsedMs=performance.now()-at;
 assert.equal(search.response.totalMatches,1);assert.equal(search.response.hits[0].sourceId,'corpus-0');
 console.log(JSON.stringify({case:'history_retention_and_corpus',restartReimportTombstones:reimport.tombstoned.length,retainedRecords:1001,olderRelevantMatches:search.response.totalMatches,searchMs:Math.round(elapsedMs)}));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
