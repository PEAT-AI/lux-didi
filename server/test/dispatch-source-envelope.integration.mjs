import {replay,text} from './dispatch-diagnostics.integration.mjs';
const content=[{type:'text',text}];
const body={id:'synthetic-item',body:text,whole_body:true,coverage:{next_cursor:'synthetic-next',complete:false}};
const mongoose={content:[{type:'text',text:JSON.stringify(body,null,2)}],structuredContent:body,isError:false};
const cases=[];
cases.push(await replay('lux-knowledge','get_insight',{ids:[101]},{content,structuredContent:{result:text},isError:false}));
cases.push(await replay('mongoose','get_knowledge_item',{id:'synthetic-item'},mongoose));
// W10: one recorded lux-google-mcp result shape: the helper's own envelope (google_mcp/server.py _envelope),
// same keys, fake values. text and structuredContent are the same object, so equivalence is provable.
const googleEnvelope={family:'gmail',tool:'gmail_search_messages',method:'users.messages.list',account:{configured:'configured',provider:null},data:{messages:[{id:'synthetic-message',snippet:text}]},coverage:{complete:true,nextPageToken:null},diagnostics:[]};
const google={content:[{type:'text',text:JSON.stringify(googleEnvelope)}],structuredContent:googleEnvelope,isError:false};
cases.push(await replay('google','gmail_search_messages',{q:'synthetic',maxResults:5},google));
for(const structuredContent of [{...googleEnvelope,coverage:{complete:false,nextPageToken:null}},{...googleEnvelope,data:{messages:[]}}]){
 cases.push(await replay('google','gmail_search_messages',{q:'synthetic',maxResults:5},{...google,structuredContent},{unavailable:true}));
}
// Not the helper's envelope even though text and structured agree: a bare dictionary is not vouched for.
const flat={result:text};
cases.push(await replay('google','gmail_search_messages',{q:'synthetic',maxResults:5},{content:[{type:'text',text:JSON.stringify(flat)}],structuredContent:flat,isError:false},{unavailable:true}));
for(const structuredContent of [{result:text+' mismatch'},{result:text,extra:'meaningful omitted field'}]){
 cases.push(await replay('lux-knowledge','get_insight',{ids:[101]},{content,structuredContent},{unavailable:true}));
}
for(const structuredContent of [{...body,body:text+' mismatch'},{...body,extra:{body:'meaningful structured-only tail'}}]){
 cases.push(await replay('mongoose','get_knowledge_item',{id:'synthetic-item'},{...mongoose,structuredContent},{unavailable:true}));
}
console.log(JSON.stringify({case:'paired_source_equivalence',cases}));
