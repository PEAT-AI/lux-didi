/** Didi lifecycle/state adapter for the authorized first-party Canvas renderer.
 * See orb-provenance.md for bounded extraction and MIT noise dependency.
 */
import { ClassicRenderer, clampFrameDelta, smoothingAlpha, ORB_SMOOTHING_TAU } from './orb-classic.ts';
import { LatestFrame, frameInterval, initialMotion, levelFrame, posture, shouldPaint, stepMotion, type LevelSample, type MotionState } from './orb-level.ts';
import { orbVisualOf, registerOrbRenderer } from './orb-states.ts';
export type VoiceState = 'IDLE' | 'CONNECTING' | 'CONNECTED' | 'LISTENING' | 'PROCESSING' | 'SPEAKING' | 'RECONNECTING' | 'ERROR' | 'DISCONNECTED' | 'INTERRUPTED';
export type { AudioFrame } from './orb-level.ts';
export { LatestFrame, silentFrame } from './orb-level.ts';
/** Presence (#283): the classic geometry draws at 5 percent of the canvas; the whole drawing is
 *  scaled about the centre so the average speaking footprint fills most of the canvas, and a
 *  destination-out band fades everything before the square edge. */
export const ORB_PRESENCE = { heroScale: 2.9, vignetteInner: 0.33, vignetteOuter: 0.5 } as const;

export class Orb {
  private context: CanvasRenderingContext2D | null;
  private classic: ClassicRenderer | undefined;
  private motionState: MotionState = initialMotion();
  private paints = 0;
  private lastScale = 1;
  private mid = 0;
  private high = 0;
  private hue: number | undefined;
  private durations: number[] = [];
  private lastPaint = 0;
  private motion = matchMedia('(prefers-reduced-motion: reduce)');
  private animation: number | undefined;
  private size = 220;
  private observer: ResizeObserver;
  private lastTime = 0;
  private phase = 0;
  private destroyed = false;
  private painted = false;
  private lastActivity = 1;
  private lastTarget = 1;
  private transition: { activity: number; target: number } | undefined;
  readonly audio = new LatestFrame();
  constructor(private canvas: HTMLCanvasElement, private state: VoiceState) {
    registerOrbRenderer(canvas, () => this.refreshIfStill());
    this.context=canvas.getContext('2d');
    if(this.context)this.classic=new ClassicRenderer(this.context);
    Object.defineProperty(canvas,'didiFrameStats',{value:()=>({frames:this.durations.length,maxDrawMs:Math.max(0,...this.durations),meanDrawMs:this.durations.reduce((a,b)=>a+b,0)/Math.max(1,this.durations.length),activity:this.lastActivity,target:this.lastTarget,transition:this.transition,paints:this.paints,body:this.motionState.low,scale:this.lastScale}),configurable:true});
    this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas);
    this.motion.addEventListener('change',this.reset);
    document.addEventListener('visibilitychange',this.reset);
    this.resize();
    // Native player/capture taps post one small level frame here; the renderer owns only the
    // smoothing and geometry, never capture or transport authority.
    (globalThis as unknown as { didiOrbLevel?: (sample: LevelSample) => void }).didiOrbLevel = sample => this.audio.push(levelFrame(sample));
  }
  setState(state: VoiceState) { this.state=state; this.reset(); this.transition={activity:this.lastActivity,target:this.lastTarget}; }
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
    // The first paint (and reduced motion / a hidden tab) may snap to the target. A state change
    // while animating draws the smoothed activity so the transition crossfades, never snaps (F5).
    const still=this.motion.matches||document.hidden||!this.painted;
    this.painted=true;
    this.draw(performance.now(),still);
    if(!this.motion.matches&&!document.hidden&&this.context)this.animation=requestAnimationFrame(this.tick);
  };
  /** One still frame on demand, for a canvas whose loop is not running (reduced motion). */
  refreshIfStill() { if(!this.destroyed&&this.animation===undefined)this.reset(); }
  private tick = (time: number) => {
    if(this.destroyed||this.motion.matches||document.hidden){this.animation=undefined;return;}
    // Frame budget (#283): 60 fps while active, 30 idle in a focused window, 12 idle unfocused.
    const kind=posture(this.state,this.audio.read(time));
    if(shouldPaint(time-this.lastPaint,frameInterval(kind,this.state,document.hasFocus()))){
      const start=performance.now();this.draw(time,false);this.lastPaint=time;
      this.durations.push(performance.now()-start);if(this.durations.length>60)this.durations.shift();
    }
    this.animation=requestAnimationFrame(this.tick);
  };
  private draw(time: number, still: boolean) {
    const ctx=this.context;if(!ctx)return;
    const dt=this.lastTime?clampFrameDelta((time-this.lastTime)/1000):0.016;
    this.lastTime=time;
    const frame=this.audio.read(time);
    const visual=orbVisualOf(this.canvas);
    const active=visual?.posture??posture(this.state,frame);
    const mid=Math.min(1,Math.max(0,frame.mid));
    this.mid+=(mid-this.mid)*smoothingAlpha(dt,mid>this.mid?ORB_SMOOTHING_TAU.midAttack:ORB_SMOOTHING_TAU.midDecay);
    const high=Math.min(1,Math.max(0,frame.high));
    this.high+=(high-this.high)*smoothingAlpha(dt,high>this.high?ORB_SMOOTHING_TAU.highAttack:ORB_SMOOTHING_TAU.highDecay);
    const m=stepMotion(this.motionState,active,frame,dt,still);
    this.lastActivity=m.activity;this.lastTarget=m.activityTarget;this.lastScale=m.scale;this.paints++;
    if(!still)this.phase+=dt;
    if(this.canvas.dataset.posture!==active)this.canvas.dataset.posture=active;
    const s=this.size,c=s/2;
    ctx.clearRect(0,0,s,s);
    const zoom=ORB_PRESENCE.heroScale*m.scale;
    ctx.save();ctx.translate(c,c);ctx.rotate(m.swirl);ctx.scale(zoom,zoom);ctx.translate(-c,-c);
    const hueTarget=visual?.hue??(this.state==='ERROR'?0:active==='listening'?45:active==='speaking'?160:active==='thinking'?195:['IDLE','DISCONNECTED','RECONNECTING','INTERRUPTED'].includes(this.state)?210:174);
    this.hue=this.hue===undefined||still||visual?.hue!==undefined?hueTarget:this.hue+(hueTarget-this.hue)*smoothingAlpha(dt,0.14);
    // The pill's machine has already eased these, so they are drawn as given.
    const activity=m.activity*(visual?.amplitude??1), glow=visual?.glow??m.glow;
    this.classic?.draw(c,c,s*0.05,this.hue,still?0.8:this.phase,active,m.level,activity,glow,m.flare,this.mid,this.high,m.flux,m.low);
    ctx.restore();
    // Nothing reaches the square edge: the outermost band fades the whole drawing (rings and glow
    // included) to transparent, so the canvas never shows a straight cut (V3-R6 item 1).
    ctx.save();
    ctx.globalCompositeOperation='destination-out';
    const edge=ctx.createRadialGradient(c,c,s*ORB_PRESENCE.vignetteInner,c,c,s*ORB_PRESENCE.vignetteOuter);
    edge.addColorStop(0,'rgba(0,0,0,0)');edge.addColorStop(0.55,'rgba(0,0,0,0.35)');edge.addColorStop(1,'rgba(0,0,0,1)');
    ctx.fillStyle=edge;ctx.fillRect(0,0,s,s);
    ctx.restore();
  }

  destroy() {
    this.destroyed=true;if(this.animation!==undefined)cancelAnimationFrame(this.animation);
    this.observer.disconnect();this.motion.removeEventListener('change',this.reset);document.removeEventListener('visibilitychange',this.reset);
  }
}
