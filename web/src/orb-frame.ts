/** Pure classic frame state, derived from Vicuna f27bca7, component 744–890.
 * Greeting/entrance events and a live voice channel are not present in Didi.
 */
import {clampFrameDelta, smoothingAlpha, ORB_SMOOTHING_TAU, speakingActivityTarget} from './orb-classic';
import type {AudioFrame, VoiceState} from './orb';
export interface OrbFrame {
  size: number; time: number; ambientTime: number; ambientNoiseOffset: {x:number;y:number};
  hue: number | null; activityMultiplier: number; glowIntensity: number; flareIntensity: number;
  smoothedAudioLevel: number; smoothedPlaybackLevel: number;
  smoothedLow: number; smoothedMid: number; smoothedHigh: number; smoothedFlux: number;
  smoothedActivity: number; targetPulse: number; currentPulse: number;
  listening: boolean; speaking: boolean; processing: boolean;
}
export interface OrbInput {
  state: VoiceState; audio: Pick<AudioFrame,'level'|'low'|'mid'|'high'|'flux'>;
  audible: boolean; microphoneLevel: number;
}
export function initialOrbFrame(): OrbFrame {
  return {size:600,time:0,ambientTime:0,ambientNoiseOffset:{x:0,y:0},hue:null,
    activityMultiplier:.3,glowIntensity:.2,flareIntensity:.15,
    smoothedAudioLevel:0,smoothedPlaybackLevel:0,smoothedLow:0,smoothedMid:0,smoothedHigh:0,smoothedFlux:0,
    smoothedActivity:1,targetPulse:0,currentPulse:0,listening:false,speaking:false,processing:false};
}
export function stepOrbFrame(previous: Readonly<OrbFrame>, input: Readonly<OrbInput>, seconds: number, size: number): OrbFrame {
  const dt=clampFrameDelta(seconds), tau=ORB_SMOOTHING_TAU;
  const ease=(current:number,target:number,attack:number,decay:number) => current+(target-current)*smoothingAlpha(dt,target>current?attack:decay);
  const {state,audio,audible}=input;
  const listening=state==='LISTENING';
  const speaking=state==='SPEAKING'||(state==='PROCESSING'&&audible);
  const processing=state==='CONNECTING'||(state==='PROCESSING'&&!audible);
  const smoothedAudioLevel=ease(previous.smoothedAudioLevel,listening?input.microphoneLevel:0,tau.audioAttack,tau.audioDecay);
  const smoothedPlaybackLevel=ease(previous.smoothedPlaybackLevel,audio.level,tau.playbackAttack,tau.playbackDecay);
  const smoothedLow=ease(previous.smoothedLow,audio.low,tau.lowAttack,tau.lowDecay);
  const smoothedMid=ease(previous.smoothedMid,audio.mid,tau.midAttack,tau.midDecay);
  const smoothedHigh=ease(previous.smoothedHigh,audio.high,tau.highAttack,tau.highDecay);
  const smoothedFlux=ease(previous.smoothedFlux,audio.flux,tau.fluxAttack,tau.fluxDecay);
  let smoothedActivity=previous.smoothedActivity;
  let activityMultiplier=.3, glowIntensity=.2, flareIntensity=.15, targetPulse=previous.targetPulse;
  if(listening){activityMultiplier=.8+Math.min(smoothedAudioLevel*.2,.2);glowIntensity=.4;flareIntensity=.25;}
  else if(speaking){
    smoothedActivity=ease(smoothedActivity,speakingActivityTarget(smoothedLow),tau.activityAttack,tau.activityDecay);
    activityMultiplier=smoothedActivity;glowIntensity=.5+smoothedPlaybackLevel*.4;flareIntensity=.4+smoothedPlaybackLevel*.4;
  }else if(state==='PROCESSING'||state==='CONNECTING'){
    activityMultiplier=.75+Math.sin(previous.time*4)*.05;glowIntensity=.3+Math.sin(previous.time*3)*.1;flareIntensity=.2;
    targetPulse=Math.sin(previous.time*3)*.15+.2;
  }else if(state==='CONNECTED'){activityMultiplier=.6;glowIntensity=.15;flareIntensity=.1;}
  else if(state==='RECONNECTING'){activityMultiplier=.35+Math.sin(previous.ambientTime*.8)*.04;glowIntensity=.12;flareIntensity=.06;}
  else if(state==='ERROR'){activityMultiplier=.6;glowIntensity=.2;flareIntensity=.15;}
  else if(state==='IDLE'||state==='DISCONNECTED'){activityMultiplier=.5;glowIntensity=.1;flareIntensity=.05;}
  if(!speaking)smoothedActivity=1;
  // baseHue is status-owned: audible PROCESSING has speaking geometry but hue 195.
  const targetHue=listening?45:state==='SPEAKING'?160:state==='PROCESSING'||state==='CONNECTING'?195:state==='CONNECTED'?174:state==='ERROR'?0:210;
  const hue=previous.hue===null?targetHue:previous.hue+(targetHue-previous.hue)*.15;
  const currentPulse=previous.currentPulse+(targetPulse-previous.currentPulse)*.1;
  const time=previous.time+dt, ambientTime=previous.ambientTime+dt*.75;
  return {size,time,ambientTime,ambientNoiseOffset:{x:Math.sin(ambientTime*.3)*2,y:Math.cos(ambientTime*.25)*2},
    hue,activityMultiplier,glowIntensity,flareIntensity,smoothedAudioLevel,smoothedPlaybackLevel,
    smoothedLow,smoothedMid,smoothedHigh,smoothedFlux,smoothedActivity,targetPulse,currentPulse,listening,speaking,processing};
}
