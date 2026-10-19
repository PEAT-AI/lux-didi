import assert from 'node:assert/strict';
import {replay,text} from './dispatch-diagnostics.integration.mjs';
const cases=[];
for(const [name,args]of [
 ['read_knowledge_body',{ref:'synthetic-reference',max_chars:8000,cursor:'synthetic-cursor'}],
 ['get_ticket',{number:42,detail:'full',limit:3,offset:2,body_offset:4000}],
 ['get_company_profile',{company_name:'Synthetic Company',detail:'full',flagship_only:true,launch_year:2025}],
 ['search_mongoose',{query:'synthetic query',scope:'knowledge',domain:'engineering',limit:3,offset:2,include:'knowledge',include_strong:true}],
 ['get_knowledge_item',{item_id:'synthetic-item',detail:'full'}],
])cases.push(await replay('mongoose',name,args,text));
const {projectDiagnosticInput}=await import(new URL(process.env.DIDI_DISPATCH_DIST??'../dist/',import.meta.url).href+'tools/diagnostic-input.js');
for(const name of ['read_knowledge_body','get_ticket','get_company_profile','search_mongoose','get_knowledge_item']){
 const projected=projectDiagnosticInput(name,{authorization:'synthetic-secret',unknown:{body:'never persisted'}});
 assert.equal(projected.fidelity,'hash_only_unsupported_v1');assert.equal(projected.json,null);assert.equal(projected.keyCount,2);
}
console.log(JSON.stringify({case:'current_mongoose_input_capture',cases,unknownFields:'hash_only'}));
