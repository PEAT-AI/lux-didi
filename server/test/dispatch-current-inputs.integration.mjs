import assert from 'node:assert/strict';
import {replay,text} from './dispatch-diagnostics.integration.mjs';
const cases=[];
for(const [name,args]of [
 ['read',{ref:'synthetic-reference',depth:'full',cursor:'synthetic-cursor'}],
 ['get_company',{ref:'synthetic-company',include:['profile']}],
 ['search',{query:'synthetic query',mode:'answer',limit:3,cursor:'synthetic-cursor',verbose:false}],
 ['list_companies',{filter:{name:'synthetic'},limit:3}],
])cases.push(await replay('mongoose',name,args,text));
const {projectDiagnosticInput}=await import(new URL(process.env.DIDI_DISPATCH_DIST??'../dist/',import.meta.url).href+'tools/diagnostic-input.js');
for(const name of ['read','get_company','search','list_companies']){
 const projected=projectDiagnosticInput(name,{authorization:'synthetic-secret',unknown:{body:'never persisted'}});
 assert.equal(projected.fidelity,'hash_only_unsupported_v1');assert.equal(projected.json,null);assert.equal(projected.keyCount,2);
}
console.log(JSON.stringify({case:'current_mongoose_input_capture',cases,unknownFields:'hash_only'}));
