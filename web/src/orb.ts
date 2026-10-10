/** Lifecycle/state adapter. No microphone, playback or native voice channel is manufactured. */
import {ClassicRenderer} from './orb-classic';
import {initialOrbFrame,stepOrbFrame} from './orb-frame';
export type VoiceState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'RECONNECTING' | 'ERROR' | 'DISCONNECTED' | 'INTERRUPTED';
export interface AudioFrame {level:number;low:number;mid:number;high:number;flux:number;timestamp:number}
export const silentFrame = (timestamp=performance.now()): AudioFrame => ({level:0,low:0,mid:0,high:0,flux:0,timestamp});
export class LatestFrame {
  private frame=silentFrame();
  push(frame:AudioFrame){this.frame={...frame};}
  clear(){this.frame=silentFrame();}
  read(now:number):AudioFrame{return now-this.frame.timestamp>500?silentFrame(now):this.frame;}
}
export function posture(state:VoiceState,audible:boolean){
  if(state==='SPEAKING'||(state==='PROCESSING'&&audible))return 'speaking';
  if(state==='LISTENING')return 'listening';
  if(state==='PROCESSING'||state==='CONNECTING')return 'thinking';
  if(['DISCONNECTED','IDLE','RECONNECTING','INTERRUPTED'].includes(state))return 'quiet';
  if(state==='ERROR')return 'error';
  return 'idle';
}
/** Absolute deadlines retain refresh quantization remainder instead of losing drift every paint. */
export function advanceOrbDeadline(deadline:number,now:number,interval:number):number {
  return deadline+(Math.floor(Math.max(0,now-deadline)/interval)+1)*interval;
}
const animatedStates=new Set<VoiceState>(['LISTENING','SPEAKING','PROCESSING','CONNECTING','CONNECTED','RECONNECTING']);
export class Orb {
  private context:CanvasRenderingContext2D|null;
  private classic:ClassicRenderer|undefined;
  private frame=initialOrbFrame();
  private durations:number[]=[];
  private paintTimes:number[]=[];
  private frames=0;
  private failedDraws=0;
  private started=performance.now();
  private motion=matchMedia('(prefers-reduced-motion: reduce)');
  private animation:number|undefined;
  private observer:ResizeObserver;
  private lastTime=0;
  private nextPaint=0;
  private settleDeadline=0;
  private size=600;
  private ratio=1;
  private destroyed=false;
  readonly audio=new LatestFrame();
  constructor(private canvas:HTMLCanvasElement,private state:VoiceState){
    this.context=canvas.getContext('2d');if(this.context)this.classic=new ClassicRenderer(this.context);
    Object.defineProperty(canvas,'didiFrameStats',{value:()=>({
      renderer:'classic-eleven-f27bca7',tier:'high',logicalSize:this.size,displaySize:this.canvas.clientWidth,dpr:this.ratio,
      targetFps:this.fps(),frames:this.frames,sampleCount:this.durations.length,failedDraws:this.failedDraws,
      maxDrawMs:Math.max(0,...this.durations),meanDrawMs:this.durations.reduce((a,b)=>a+b,0)/Math.max(1,this.durations.length),
      drawMs:[...this.durations],paintTimes:[...this.paintTimes],elapsedMs:performance.now()-this.started,
      frameTime:this.frame.time,ambientTime:this.frame.ambientTime,lastDelta:this.lastDelta,destroyed:this.destroyed
    }),configurable:true});
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas);
    this.motion.addEventListener('change',this.reset);document.addEventListener('visibilitychange',this.reset);
    this.frame=stepOrbFrame(this.frame,this.input(performance.now()),0,this.size);this.resize();
  }
  private lastDelta=0;
  private input(now:number){
    const raw=this.audio.read(now);
    const unit=(v:number)=>Number.isFinite(v)?Math.min(1,Math.max(0,v)):0;
    const audio={level:unit(raw.level),low:unit(raw.low),mid:unit(raw.mid),high:unit(raw.high),flux:unit(raw.flux)};
    return {state:this.state,audio,audible:audio.level>.01,microphoneLevel:0};
  }
  clearAudio(){this.audio.clear();this.frame={...this.frame,smoothedAudioLevel:0,smoothedPlaybackLevel:0,smoothedLow:0,smoothedMid:0,smoothedHigh:0,smoothedFlux:0,smoothedActivity:1};}
  setState(state:VoiceState){
    if(this.destroyed||state===this.state)return;
    if(['DISCONNECTED','IDLE','RECONNECTING','INTERRUPTED','ERROR'].includes(state))this.clearAudio();
    this.state=state;this.frame=stepOrbFrame(this.frame,this.input(performance.now()),0,this.size);this.reset();
  }
  private fps(){return ['LISTENING','SPEAKING','PROCESSING','CONNECTING'].includes(this.state)?60:12;}
  private resize(){
    if(this.destroyed)return;
    this.size=matchMedia('(max-width: 767px)').matches?400:600;
    this.ratio=Math.min(devicePixelRatio||1,2);
    this.canvas.width=this.size*this.ratio;this.canvas.height=this.size*this.ratio;
    this.context?.setTransform(this.ratio,0,0,this.ratio,0,0);
    this.frame={...this.frame,size:this.size};this.reset();
  }
  private reset=()=>{
    if(this.destroyed)return;
    if(this.animation!==undefined)cancelAnimationFrame(this.animation);
    this.animation=undefined;this.lastTime=0;this.nextPaint=performance.now();this.settleDeadline=this.nextPaint+300;
    this.canvas.dataset.motion=this.motion.matches?'still':'animated';
    this.canvas.dataset.state=this.state;
    // ERROR's recoverability is not emitted by this app; do not invent it.
    if(this.state==='ERROR')delete this.canvas.dataset.disabled;
    else this.canvas.dataset.disabled=String(['IDLE','DISCONNECTED','CONNECTING'].includes(this.state));
    if(document.hidden)return;
    this.paint(this.nextPaint);
    if(!this.motion.matches&&this.context)this.animation=requestAnimationFrame(this.tick);
  };
  private tick=(time:number)=>{
    this.animation=undefined;
    if(this.destroyed||this.motion.matches||document.hidden)return;
    if(time>=this.nextPaint){
      this.lastDelta=this.lastTime===0?0:Math.min(.1,Math.max(0,(time-this.lastTime)/1000));this.lastTime=time;
      this.frame=stepOrbFrame(this.frame,this.input(time),this.lastDelta,this.size);
      this.paint(time);this.nextPaint=advanceOrbDeadline(this.nextPaint,time,1000/this.fps());
    }
    if(animatedStates.has(this.state)||time<this.settleDeadline)this.animation=requestAnimationFrame(this.tick);
  };
  private paint(time:number){
    if(!this.context||!this.classic)return;
    const start=performance.now();
    try {
      this.context.clearRect(0,0,this.size,this.size);
      this.canvas.dataset.posture=posture(this.state,this.input(time).audible);
      this.classic.draw(this.frame);
      this.frames++;this.durations.push(performance.now()-start);this.paintTimes.push(time);
      if(this.durations.length>240){this.durations.shift();this.paintTimes.shift();}
    }catch(error){this.failedDraws++;throw error;}
  }
  destroy(){
    if(this.destroyed)return;
    this.destroyed=true;if(this.animation!==undefined)cancelAnimationFrame(this.animation);this.animation=undefined;
    this.observer.disconnect();this.motion.removeEventListener('change',this.reset);document.removeEventListener('visibilitychange',this.reset);
    this.audio.clear();this.classic=undefined;this.context=null;
  }
}
