/** Didi lifecycle/state adapter for the authorized first-party Canvas renderer.
 * See orb-provenance.md for bounded extraction and MIT noise dependency.
 */
import { ClassicRenderer, clampFrameDelta, smoothingAlpha, ORB_SMOOTHING_TAU, speakingActivityTarget } from './orb-classic.ts';
export type VoiceState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'RECONNECTING' | 'ERROR' | 'DISCONNECTED' | 'INTERRUPTED';
export interface AudioFrame { level: number; low: number; mid: number; high: number; flux: number; timestamp: number }
export const silentFrame = (): AudioFrame => ({level:0,low:0,mid:0,high:0,flux:0,timestamp:performance.now()});
/** A bounded level sample posted by the native player/capture tap. Extra bands default to the
 *  scalar level so a transport need not send five numbers. Values are clamped at this boundary. */
export interface LevelSample { level: number; low?: number; mid?: number; high?: number; flux?: number }
export function levelFrame(sample: LevelSample): AudioFrame {
  const clamp = (value: number | undefined, fallback = 0) => Math.min(1, Math.max(0, Number.isFinite(value) ? value! : fallback));
  const level = clamp(sample.level);
  return { level, low: clamp(sample.low, level), mid: clamp(sample.mid, level), high: clamp(sample.high, level), flux: clamp(sample.flux), timestamp: performance.now() };
}
export class LatestFrame {
  private frame = silentFrame();
  push(frame: AudioFrame) { this.frame = {...frame}; }
  read(now: number): AudioFrame { return now-this.frame.timestamp>500 ? silentFrame() : this.frame; }
}
export function posture(state: VoiceState, audible: boolean) {
  if(state === 'SPEAKING' || state === 'PROCESSING' && audible) return 'speaking';
  if(state === 'LISTENING') return 'listening';
  if(state === 'CONNECTING' || state === 'PROCESSING') return 'thinking';
  if(['ERROR','DISCONNECTED','INTERRUPTED'].includes(state)) return 'quiet';
  return 'idle';
}
export class Orb {
  private context: CanvasRenderingContext2D | null;
  private classic: ClassicRenderer | undefined;
  private low = 0;
  private mid = 0;
  private high = 0;
  private flux = 0;
  private hue: number | undefined;
  private activity = 1;
  private durations: number[] = [];
  private lastPaint = 0;
  private motion = matchMedia('(prefers-reduced-motion: reduce)');
  private animation: number | undefined;
  private size = 220;
  private observer: ResizeObserver;
  private lastTime = 0;
  private level = 0;
  private phase = 0;
  private destroyed = false;
  readonly audio = new LatestFrame();
  constructor(private canvas: HTMLCanvasElement, private state: VoiceState) {
    this.context=canvas.getContext('2d');
    if(this.context)this.classic=new ClassicRenderer(this.context);
    Object.defineProperty(canvas,'didiFrameStats',{value:()=>({frames:this.durations.length,maxDrawMs:Math.max(0,...this.durations),meanDrawMs:this.durations.reduce((a,b)=>a+b,0)/Math.max(1,this.durations.length)}),configurable:true});
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas);
    this.motion.addEventListener('change',this.reset);
    document.addEventListener('visibilitychange',this.reset);
    this.resize();
    // Native player/capture taps post one small level frame here; the renderer owns only the
    // smoothing and geometry, never capture or transport authority.
    (globalThis as unknown as { didiOrbLevel?: (sample: LevelSample) => void }).didiOrbLevel = sample => this.audio.push(levelFrame(sample));
  }
  setState(state: VoiceState) { this.state=state; this.reset(); }
  private resize() {
    this.size=Math.max(1,this.canvas.clientWidth);
    const ratio=Math.min(devicePixelRatio||1,2);
    this.canvas.width=Math.round(this.size*ratio);this.canvas.height=Math.round(this.size*ratio);
    this.context?.setTransform(ratio,0,0,ratio,0,0);this.reset();
  }
  private reset = () => {
    if(this.destroyed)return;
    if(this.animation!==undefined)cancelAnimationFrame(this.animation);
    this.animation=undefined;this.lastTime=0;
    this.canvas.dataset.motion=this.motion.matches?'still':'animated';
    this.canvas.dataset.state=this.state;
    this.draw(performance.now(),true);
    if(!this.motion.matches&&!document.hidden&&this.context)this.animation=requestAnimationFrame(this.tick);
  };
  private tick = (time: number) => {
    if(this.destroyed||this.motion.matches||document.hidden){this.animation=undefined;return;}
    // Small injected budget: 24fps idle, 30fps active; never a synthetic load.
    const fps=['CONNECTING','PROCESSING','LISTENING','SPEAKING'].includes(this.state)?30:24;
    if(time-this.lastPaint>=1000/fps){
      const start=performance.now();this.draw(time,false);this.lastPaint=time;
      this.durations.push(performance.now()-start);if(this.durations.length>60)this.durations.shift();
    }
    this.animation=requestAnimationFrame(this.tick);
  };
  private draw(time: number, still: boolean) {
    const ctx=this.context;if(!ctx)return;
    const dt=this.lastTime?clampFrameDelta((time-this.lastTime)/1000):0.016;
    this.lastTime=time;
    const frame=this.audio.read(time), audible=frame.level>0.01;
    const active=posture(this.state,audible);
    const target=Math.min(1,Math.max(0,frame.level));
    this.level+=(target-this.level)*smoothingAlpha(dt,target>this.level?ORB_SMOOTHING_TAU.playbackAttack:ORB_SMOOTHING_TAU.playbackDecay);
    const low=Math.min(1,Math.max(0,frame.low));
    this.low+=(low-this.low)*smoothingAlpha(dt,low>this.low?ORB_SMOOTHING_TAU.lowAttack:ORB_SMOOTHING_TAU.lowDecay);
    const mid=Math.min(1,Math.max(0,frame.mid));
    this.mid+=(mid-this.mid)*smoothingAlpha(dt,mid>this.mid?ORB_SMOOTHING_TAU.midAttack:ORB_SMOOTHING_TAU.midDecay);
    const high=Math.min(1,Math.max(0,frame.high));
    this.high+=(high-this.high)*smoothingAlpha(dt,high>this.high?ORB_SMOOTHING_TAU.highAttack:ORB_SMOOTHING_TAU.highDecay);
    const flux=Math.min(1,Math.max(0,frame.flux));
    this.flux+=(flux-this.flux)*smoothingAlpha(dt,flux>this.flux?ORB_SMOOTHING_TAU.fluxAttack:ORB_SMOOTHING_TAU.fluxDecay);
    let activityTarget=0.3, glow=0.2, flare=0.15;
    if(active==='listening') { activityTarget=0.8+Math.min(this.level*0.2,0.2); glow=0.4; flare=0.25; }
    else if(active==='speaking') { activityTarget=speakingActivityTarget(this.low); glow=0.5+this.level*0.4; flare=0.4+this.level*0.4; }
    else if(active==='thinking') { activityTarget=0.75+Math.sin(this.phase*4)*0.05; glow=0.3+Math.sin(this.phase*3)*0.1; flare=0.2; }
    else if(this.state==='CONNECTED') { activityTarget=0.6; glow=0.15; flare=0.1; }
    else if(this.state==='RECONNECTING') { activityTarget=0.35+Math.sin(this.phase*0.8)*0.04; glow=0.12; flare=0.06; }
    else if(this.state==='ERROR') { activityTarget=0.6; glow=0.2; flare=0.15; }
    else if(this.state==='IDLE'||this.state==='DISCONNECTED'||this.state==='INTERRUPTED') { activityTarget=0.5; glow=0.1; flare=0.05; }
    this.activity+=(activityTarget-this.activity)*smoothingAlpha(dt,activityTarget>this.activity?ORB_SMOOTHING_TAU.activityAttack:ORB_SMOOTHING_TAU.activityDecay);
    if(!still)this.phase+=dt;
    if(this.canvas.dataset.posture!==active)this.canvas.dataset.posture=active;
    const s=this.size,c=s/2;
    ctx.clearRect(0,0,s,s);
    const hueTarget=this.state==='ERROR'?0:active==='listening'?45:active==='speaking'?160:active==='thinking'?195:['IDLE','DISCONNECTED','RECONNECTING','INTERRUPTED'].includes(this.state)?210:174;
    this.hue=this.hue===undefined?hueTarget:this.hue+(hueTarget-this.hue)*smoothingAlpha(dt,0.18);
    this.classic?.draw(c,c,s*0.05,this.hue,still?0.8:this.phase,active,this.level,still?activityTarget:this.activity,glow,flare,this.mid,this.high,this.flux);
  }

  destroy() {
    this.destroyed=true;if(this.animation!==undefined)cancelAnimationFrame(this.animation);
    this.observer.disconnect();this.motion.removeEventListener('change',this.reset);document.removeEventListener('visibilitychange',this.reset);
  }
}
