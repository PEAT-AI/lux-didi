import {replay,text} from './dispatch-diagnostics.integration.mjs';
const cases=[];
cases.push(await replay('lux-knowledge','get_insight',{ids:[101]},{content:[{type:'text',text}],structuredContent:{result:text},isError:false},{cli:true}));
cases.push(await replay('mongoose','read_knowledge_body',{ref:'synthetic-reference',max_chars:8000,cursor:'synthetic-cursor'},text,{cli:true}));
cases.push(await replay('google','gmail_read_message',{id:'synthetic-message',format:'full'},JSON.stringify({data:{id:'synthetic-message',subject:'Synthetic',body:text,from:'synthetic@example.invalid'}}),{cli:true}));
console.log(JSON.stringify({case:'actual_cli_reopened_canonical_tool_results',cases,defaultMetadataOnly:true,optInExactContent:true,forgottenContentDenied:true,boundedModelResultDistinct:true}));
