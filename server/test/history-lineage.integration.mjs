import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {Store} from '../dist/runtime/store.js';
import {domainMigrations} from '../dist/domain/schema.js';
import {historySessionEvidence} from '../dist/domain/history-lifecycle.js';
const dir=mkdtempSync('/tmp/didi-history-lineage-'),store=new Store(dir,domainMigrations);
try{
 let reads=0;store.transaction(tx=>{
  for(let i=0;i<18;i++){tx.run('INSERT INTO history_sessions VALUES(?,?,?,1,0)',['source-'+i,store.assistantId,'private']);for(const parent of [i-1,i-2].filter(n=>n>=0))tx.run('INSERT INTO history_dependencies VALUES(?,?,1)',['source-'+i,'source-'+parent]);}
  const counted={run:(...args)=>tx.run(...args),get:(...args)=>{reads++;return tx.get(...args);},all:(...args)=>{reads++;return tx.all(...args);}};
  assert.deepEqual(historySessionEvidence(counted,'source-17'),{dataClass:'private',revision:1});
 });
 assert(reads<=100,'shared ancestors must be validated once per traversal, observed '+reads);
 console.log(JSON.stringify({case:'history_shared_ancestor_lineage',sessions:18,canonicalReads:reads}));
}finally{store.close();rmSync(dir,{recursive:true,force:true});}
