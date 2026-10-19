import {replay,text} from './dispatch-diagnostics.integration.mjs';
const content=[{type:'text',text}];
const body={id:'synthetic-item',body:text,whole_body:true,coverage:{next_cursor:'synthetic-next',complete:false}};
const mongoose={content:[{type:'text',text:JSON.stringify(body,null,2)}],structuredContent:body,isError:false};
const cases=[];
cases.push(await replay('lux-knowledge','get_insight',{ids:[101]},{content,structuredContent:{result:text},isError:false}));
cases.push(await replay('mongoose','get_knowledge_item',{id:'synthetic-item'},mongoose));
for(const structuredContent of [{result:text+' mismatch'},{result:text,extra:'meaningful omitted field'}]){
 cases.push(await replay('lux-knowledge','get_insight',{ids:[101]},{content,structuredContent},{unavailable:true}));
}
for(const structuredContent of [{...body,body:text+' mismatch'},{...body,extra:{body:'meaningful structured-only tail'}}]){
 cases.push(await replay('mongoose','get_knowledge_item',{id:'synthetic-item'},{...mongoose,structuredContent},{unavailable:true}));
}
console.log(JSON.stringify({case:'paired_source_equivalence',cases}));
