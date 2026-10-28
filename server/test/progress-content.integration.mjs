import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {NAYA_CHARACTER,NAYA_VOICE_SURFACE,NAYA_LIVE_BASE,NAYA_TOOLS,composeLiveInstruction} from '../dist/prompt/live-persona.js';
import {OpenAiLiveVoiceAdapter,openAiInstructions,OPENAI_TOOLS_SECTION,OPENAI_DELIVERY_SECTION} from '../dist/adapters/live-voice/openai.js';
import {fixture,options,request,control} from '../dist/test/openai-live-voice-fixture.js';
const baselineCommit='31cc08d54248fe00562e7506dbed7ce28fbaf019';
const baseline=execFileSync('git',['show',baselineCommit+':server/prompt/live-persona.ts'],{encoding:'utf8'});
// C-ALARM11 adds exactly this public sentence; preserve the historical byte guard for every other byte.
const alarmGuidance='\n\nAwake-Mac: set_alarm, list_alarms, cancel_alarm, snooze_alarm; trust receipts.';
assert.equal(readFileSync(new URL('../prompt/live-persona.ts',import.meta.url),'utf8').replace(alarmGuidance,''),baseline);
const oldAdapter=execFileSync('git',['show',baselineCommit+':server/adapters/live-voice/openai.ts'],{encoding:'utf8'});
const extract=name=>baseline.match(new RegExp('export const '+name+' = `([\\s\\S]*?)`;'))[1];
const extractSection=name=>runInNewContext(oldAdapter.match(new RegExp("(?:export )?const "+name+" = ('[^']*');"))[1]);
assert.equal(NAYA_CHARACTER,extract('NAYA_CHARACTER'));
assert.equal(NAYA_VOICE_SURFACE,extract('NAYA_VOICE_SURFACE'));
for(const [name,value] of Object.entries({OPENAI_TOOLS_SECTION,OPENAI_DELIVERY_SECTION}))assert.equal(value,extractSection(name));
const current=composeLiveInstruction({base:NAYA_LIVE_BASE+'\n\n'+NAYA_TOOLS,language:'en'}).text;
const prior=composeLiveInstruction({base:extract('NAYA_CHARACTER')+'\n\n'+extract('NAYA_VOICE_SURFACE')+'\n\n'+NAYA_TOOLS,language:'en'}).text;
assert.equal(current,prior);
const expected=prior+'\n\n'+extractSection('OPENAI_TOOLS_SECTION')+'\n\n'+extractSection('OPENAI_DELIVERY_SECTION')+'\n\n'+extractSection('OPENAI_LISTENING_SECTION');
assert.equal(openAiInstructions(current),expected);
const cleanup=[];
try{
 const f=await fixture({after:fn=>cleanup.push(fn)});
 const session=new OpenAiLiveVoiceAdapter(options({socketFactory:f.socketFactory})).open(request({system:{text:current,dataClass:'ordinary'}}),control());cleanup.push(()=>session.close());
 await f.frame(1);const frame=f.frames[0];assert.equal(frame.session.instructions,expected);
 f.send({type:'session.started',session:{id:'synthetic-held-prompt'}});await session.ready;
 // W4: with no delegation open the append is refused rather than written with an id the wire would reject.
 assert.equal(session.sendCommentary({text:'Synthetic verified source is still reading.'}),false);
 session.sendThinking({text:'Synthetic silent status.'});await f.frame(2);
 assert.deepEqual(f.frames.slice(1).map(x=>x.type),['session.thinking.append']);
 assert.equal(f.frames[1].delegation_id,null,'silent context keeps its null delegation');
 // W4: the append that names an open delegation is covered in openai-live-voice.test.ts, where a fake clock and
 // a delegation frame can be driven deterministically; this script keeps to the shipped prompt and the ports.
 console.log(JSON.stringify({case:'actual_openai_shipped_prompt_byte_identity',baselineCommit,promptByteIdentical:true,characterSha256:createHash('sha256').update(NAYA_CHARACTER).digest('hex'),instructionsSha256:createHash('sha256').update(expected).digest('hex'),heldPromptCandidate:'005f154ef535061cee130daad94cf93416e53fd0',distinctCommentaryAndThinkingWire:false,commentaryRefusedWithNoDelegation:true,behavioralAcceptance:false,audio:false}));
}finally{for(const fn of cleanup.reverse())await fn();}
