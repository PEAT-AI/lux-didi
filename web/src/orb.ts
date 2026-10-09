/** Didi lifecycle/state adapter for the authorized first-party Canvas renderer.
 * See orb-provenance.md for bounded extraction and MIT noise dependency.
 */
import { ClassicRenderer, clampFrameDelta, smoothingAlpha, ORB_SMOOTHING_TAU, speakingActivityTarget } from './orb-classic';
export type VoiceState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'RECONNECTING' | 'ERROR' | 'DISCONNECTED' | 'INTERRUPTED';
export interface AudioFrame { level: number; low: number; mid: number; high: number; flux: number; timestamp: number }
export const silentFrame = (): AudioFrame => ({level:0,low:0,mid:0,high:0,flux:0,timestamp:performance.now()});
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
    const activityTarget=active==='speaking'?speakingActivityTarget(this.low):active==='thinking'?0.75:active==='listening'?1:0.3;
    this.activity+=(activityTarget-this.activity)*smoothingAlpha(dt,activityTarget>this.activity?ORB_SMOOTHING_TAU.activityAttack:ORB_SMOOTHING_TAU.activityDecay);
    if(!still)this.phase+=dt;
    if(this.canvas.dataset.posture!==active)this.canvas.dataset.posture=active;
    const s=this.size,c=s/2;
    ctx.clearRect(0,0,s,s);
    const hue=this.state==='ERROR'?0:active==='listening'?45:active==='speaking'?160:active==='thinking'?195:active==='quiet'?210:174;
    this.classic?.draw(c,c,s*0.22,hue,still?0.8:this.phase,active,this.level,still?0.3:this.activity);
  }

  destroy() {
    this.destroyed=true;if(this.animation!==undefined)cancelAnimationFrame(this.animation);
    this.observer.disconnect();this.motion.removeEventListener('change',this.reset);document.removeEventListener('visibilitychange',this.reset);
  }
}
