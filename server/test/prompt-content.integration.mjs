import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as prompt from '../dist/prompt/index.js';
import * as backend from '../dist/prompt/backend-procedure.js';
import {openAiInstructions} from '../dist/adapters/live-voice/openai.js';
import {HISTORY_IDENTITY,HISTORY_PARAMETERS,validateHistory} from '../dist/tools/history.js';
const approved=JSON.parse(readFileSync(new URL('./fixtures/prompt-final.json',import.meta.url)));
assert.equal(prompt.NAYA_CHARACTER,approved.NAYA_CHARACTER);
assert.equal(prompt.NAYA_VOICE_TOOLS,approved.NAYA_VOICE_TOOLS);
// VOICE-R1: the approved instructions carry the waiting rule once and no host-authored waiting text.
assert.equal(approved.NAYA_VOICE_TOOLS.split('Silence while you look something up is fine.').length-1,1,'the silence rule appears once');
assert.equal(approved.NAYA_VOICE_TOOLS.split('never use a stock waiting line').length-1,1,'and states the stock-line ban once');
for(const banned of ['never go silent','say one short line','Nothing has been sent or booked','Before an actual lookup']){
  assert.equal((approved.NAYA_CHARACTER+approved.NAYA_VOICE_TOOLS).includes(banned),false,`no waiting cue survives: ${banned}`);
}
assert.equal(backend.EVIDENCE_SOURCES_GUIDE,approved['Shared evidence guide for backend and Text']);
assert.equal(backend.NAYA_BACKEND_PROCEDURE,backend.EVIDENCE_SOURCES_GUIDE+'\n\n'+approved['NAYA_BACKEND_PROCEDURE surface suffix']);
assert(!/offer to keep looking|You can reach his/.test(prompt.NAYA_VOICE_TOOLS+backend.NAYA_BACKEND_PROCEDURE));
assert(prompt.PUBLIC_PERSONA.includes('Do not caricature an accent or pretend to be human.'));
const ownerId='synthetic-owner',preferences=prompt.validatePreferences({schemaVersion:1,ownerId,dataClass:'ordinary',language:'en-US',register:'plain',humor:'off',verbosity:'brief'},ownerId);
const tool={...HISTORY_IDENTITY,description:'Read canonical retained conversation evidence',parameters:HISTORY_PARAMETERS,effect:'read',validate:validateHistory,execute:async()=>{throw Error('not invoked by compiler');}};
const capabilities=prompt.createCapabilitySnapshot([tool],[{id:'memory',state:'available'},{id:'company',state:'missing'}]);
const input={ownerId,persona:'didi',promptVersion:prompt.PROMPT_VERSION,preferences,capabilities,evidence:[],history:[{schemaVersion:1,ownerId,dataClass:'ordinary',id:'turn',role:'user',text:'What did we decide sixty days ago?'}],budgets:{trustedChars:20000,contextChars:12000,historyChars:12000}};
const text=prompt.compilePrompt(input),empty=prompt.compilePrompt({...input,capabilities:prompt.createCapabilitySnapshot([],[])});
assert(text.system.includes(backend.EVIDENCE_SOURCES_GUIDE));assert(text.system.includes(approved['Text tool rule replacement']));assert(!text.system.includes('# Research procedure'));assert(!text.system.includes(prompt.NAYA_VOICE_TOOLS));assert(!empty.system.includes(backend.EVIDENCE_SOURCES_GUIDE));assert.deepEqual(text.declarations.map(x=>x.name),['conversation_history']);assert(text.system.includes('"state":"missing"'));
const compose=delegatedBackend=>prompt.composeLiveSessionInstruction({text:prompt.NAYA_LIVE_BASE+'\n\nSynthetic voice anchor',tools:['research'],delegatedBackend,records:[],trustedChars:60000});
const delegated=compose(true),direct=compose(false),none=prompt.composeLiveSessionInstruction({text:prompt.NAYA_LIVE_BASE+'\n\nSynthetic voice anchor',tools:[],records:[],trustedChars:60000});
assert(delegated.text.includes(prompt.NAYA_VOICE_TOOLS));assert(!delegated.text.includes(backend.EVIDENCE_SOURCES_GUIDE));assert(direct.text.includes(backend.NAYA_BACKEND_PROCEDURE));assert(!none.text.includes(prompt.NAYA_VOICE_TOOLS));
assert.equal(text.manifest.systemHash,createHash('sha256').update(text.system).digest('hex'));
console.log(JSON.stringify({case:'compiled_public_prompt_contract',exactApprovedBlocks:5,textReadOnly:true,delegatedVoiceSeparated:true,directVoiceIncludesProcedure:true,unavailableSourcePreserved:true,noToolsNoProcedure:true,textChars:text.system.length,delegatedChars:delegated.text.length,directChars:direct.text.length,behaviorObserved:false}));

const unknownRule="Unavailable access or a partial search does not prove that something did not happen. Say what the evidence establishes and what remains unknown.";
const ownerProfile={schemaVersion:1,kind:'profile',ownerId,profileVersion:'synthetic',displayName:'Synthetic owner',style:{text:'',dataClass:'ordinary'},lore:{text:'',dataClass:'ordinary'}};
const ownerText=prompt.compilePrompt({...input,ownerProfile});
const frozen=prompt.composeLiveInstruction({base:prompt.NAYA_LIVE_BASE,language:'en'});
const fullLive=openAiInstructions(prompt.composeLiveSessionInstruction({text:frozen.text,tools:['research'],delegatedBackend:true,records:[],trustedChars:60000}).text);
const excluded=JSON.parse(readFileSync(new URL('./fixtures/prompt-character-excluded.json',import.meta.url)));
assert.equal(createHash('sha256').update(prompt.NAYA_CHARACTER).digest('hex'),'1b188117660fe12204cd542001b585fcce69add4f1cc6d27689720e193cac977',"release character must match the accepted bytes; to repin run in server/: node --input-type=module -e \"import {createHash} from 'node:crypto';import * as p from './dist/prompt/index.js';console.log(createHash('sha256').update(p.NAYA_CHARACTER).digest('hex'))\"");
assert.notEqual(prompt.NAYA_CHARACTER,excluded.NAYA_CHARACTER);
for(const system of [ownerText.system,fullLive,openAiInstructions(none.text)]){
 assert.equal(system.split(prompt.NAYA_CHARACTER).length-1,1);
 assert(!system.includes(excluded.NAYA_CHARACTER));
 assert(!system.includes(unknownRule));
}
assert(prompt.NAYA_CHARACTER.includes('thirty to ninety seconds'),'baseline duration conflict remains explicitly open in issue 455');
assert(fullLive.includes(prompt.NAYA_VOICE_TOOLS));
assert(text.system.includes('Missing coverage is not proof that an event did not happen.'));
console.log(JSON.stringify({case:'excluded_character_release_subset',baseline:'b3bae881',excludedCandidateAbsent:true,ownerText:true,fullPublicOpenAiLive:true,noToolsVoice:true,truthfulToolProceduresRetained:true,defaultTextExistingRule:true,mandatoryDurationConflictOpen:true,behaviorAccepted:false}));
