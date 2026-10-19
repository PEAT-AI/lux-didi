import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {NAYA_CHARACTER,NAYA_VOICE_SURFACE,NAYA_LIVE_BASE,NAYA_TOOLS,composeLiveInstruction} from '../dist/prompt/live-persona.js';
import {OpenAiLiveVoiceAdapter,openAiInstructions} from '../dist/adapters/live-voice/openai.js';
import {fixture,options,request,control} from '../dist/test/openai-live-voice-fixture.js';
const rule="Start a lookup without a spoken preamble. Do not narrate retries or invent activity. Give an unsolicited waiting update only when a host progress message provides verified status; keep it to one short sentence and do not repeat it on your own. Answer the owner's direct questions, ask necessary clarifications, and explain a completed result or failure normally.";
const baseline=execFileSync('git',['show','31cc08d54248fe00562e7506dbed7ce28fbaf019:server/prompt/live-persona.ts'],{encoding:'utf8'});
const extract=name=>baseline.match(new RegExp('export const '+name+' = `([\\s\\S]*?)`;'))[1];
const oldVoice=extract('NAYA_VOICE_SURFACE'),oldCharacter=extract('NAYA_CHARACTER');
const preamble='Before an actual lookup, say at most five words about what you are checking, then call the tool.';
const suffix='Tools: before a lookup, say one short natural line that you are checking; never go silent for more than a few seconds.';
assert.equal(NAYA_CHARACTER,oldCharacter);
assert.equal(NAYA_VOICE_SURFACE,oldVoice.replace('Never fill the silence while a lookup runs.',rule).replace(' '+preamble,''));
const compose=base=>composeLiveInstruction({base:base+'\n\n'+NAYA_TOOLS,language:'en'}).text;
const current=compose(NAYA_LIVE_BASE),prior=compose(oldCharacter+'\n\n'+oldVoice);
const cleanup=[];let candidateFrame,baselineFrame;
try{
 for(const [kind,text] of [['baseline',prior+'\n\n'+suffix],['candidate',current]]){
  const f=await fixture({after:fn=>cleanup.push(fn)});const session=new OpenAiLiveVoiceAdapter(options({socketFactory:f.socketFactory})).open(request({system:{text,dataClass:'ordinary'}}),control());cleanup.push(()=>session.close());
  await f.frame(1);const frame=f.frames[0];if(kind==='candidate')candidateFrame=frame;else baselineFrame=frame;
  f.send({type:'session.started',session:{id:'synthetic-'+kind}});await session.ready;
  session.sendCommentary({text:'Synthetic verified source is still reading.'});session.sendThinking({text:'Synthetic silent status.'});await f.frame(3);
  assert.deepEqual(f.frames.slice(1).map(x=>x.type),['session.commentary.append','session.thinking.append']);assert(f.frames.slice(1).every(x=>x.delegation_id===null));
 }
 assert.equal(candidateFrame.session.instructions,openAiInstructions(current));
 assert.equal(candidateFrame.session.instructions.split(rule).length-1,1);
 assert(!candidateFrame.session.instructions.includes(preamble));assert(!candidateFrame.session.instructions.includes(suffix));
 assert.equal(candidateFrame.session.instructions,baselineFrame.session.instructions.replace('Never fill the silence while a lookup runs.',rule).replace(' '+preamble,'').replace('\n\n'+suffix,''));
 assert.deepEqual(candidateFrame.session.audio,baselineFrame.session.audio);assert.deepEqual(candidateFrame.session.delegation,baselineFrame.session.delegation);
 console.log(JSON.stringify({case:'actual_openai_wait_content_composition',baselinePreambles:2,candidateRuleOccurrences:1,characterByteIdentical:true,characterSha256:createHash('sha256').update(NAYA_CHARACTER).digest('hex'),remainingCompositionByteIdentical:true,voiceAndBackendUnchanged:true,distinctCommentaryAndThinkingWire:true,behavioralAcceptance:false,audio:false}));
}finally{for(const fn of cleanup.reverse())await fn();}
