/** Didi-owned Canvas 2D implementation of the behavior described in ORB-REUSE.md.
 * No private renderer source/assets or Angular dependencies were copied.
 */
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
    this.draw(time,false);this.animation=requestAnimationFrame(this.tick);
  };
  private draw(time: number, still: boolean) {
    const ctx=this.context;if(!ctx)return;
    const dt=this.lastTime?Math.min(Math.max((time-this.lastTime)/1000,0),0.1):0;
    this.lastTime=time;
    const frame=this.audio.read(time), audible=frame.level>0.01;
    const active=posture(this.state,audible);
    // Time-based smoothing, not fixed per frame; silent/stale frames decay to zero.
    const target=Math.min(1,Math.max(0,frame.level));
    this.level+=(target-this.level)*(1-Math.exp(-dt/0.12));
    if(!still)this.phase+=dt*(active==='thinking'?0.45:active==='speaking'?0.7:0.13);
    this.canvas.dataset.posture=active;
    const t=still?0.8:this.phase,s=this.size,c=s/2,r=s*0.34;
    ctx.clearRect(0,0,s,s);
    const halo=ctx.createRadialGradient(c,c,r*0.2,c,c,r*1.45);
    halo.addColorStop(0,'rgba(250,174,92,.19)');halo.addColorStop(0.65,'rgba(250,194,129,.12)');halo.addColorStop(1,'rgba(250,210,155,0)');
    ctx.fillStyle=halo;ctx.fillRect(0,0,s,s);
    ctx.save();ctx.translate(c,c);
    const quiet=active==='quiet';
    // Six warm translucent, organically bending plasma layers. No asset downloads.
    for(let layer=0;layer<6;layer++) {
      const offset=layer*1.12, spin=t*(layer%2?1:-1)+offset;
      ctx.beginPath();
      for(let point=0;point<=96;point++) {
        const a=point/96*Math.PI*2;
        const wave=Math.sin(a*3+spin)*0.055+Math.cos(a*5-spin*1.3)*0.032;
        const bend=1+wave+(active==='listening'?0.035:0.012)*Math.sin(a*2+t)+this.level*0.07*Math.sin(a*4+t);
        const radius=r*(0.96-layer*0.023)*bend;
        const x=Math.cos(a)*radius,y=Math.sin(a)*radius;
        if(point===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      }
      ctx.closePath();
      const gradient=ctx.createRadialGradient(-r*.22,-r*.3,r*.08,0,0,r*1.1);
      gradient.addColorStop(0,quiet?'rgba(203,176,145,.16)':'rgba(255,240,186,.33)');
      gradient.addColorStop(.52,quiet?'rgba(190,153,124,.14)':'rgba(252,177,94,.18)');
      gradient.addColorStop(.85,quiet?'rgba(161,129,109,.15)':'rgba(210,101,45,.17)');
      gradient.addColorStop(1,'rgba(168,75,42,0)');
      ctx.fillStyle=gradient;ctx.fill();
      ctx.strokeStyle=quiet?'rgba(163,139,117,.18)':`rgba(232,153,74,${.18-layer*.018})`;ctx.lineWidth=1.2;ctx.stroke();
    }
    // Soft internal tendrils bend through the core rather than implying a waveform.
    ctx.globalCompositeOperation='screen';
    for(let strand=0;strand<5;strand++){
      const a=t*.6+strand*Math.PI*.4;
      ctx.beginPath();ctx.moveTo(Math.cos(a)*r*.86,Math.sin(a)*r*.86);
      ctx.bezierCurveTo(-r*.3,Math.sin(t+strand)*r*.8,r*.4,Math.cos(t+strand)*r*.6,Math.cos(a+2.2)*r*.8,Math.sin(a+2.2)*r*.8);
      ctx.strokeStyle=quiet?'rgba(221,203,175,.18)':'rgba(255,226,161,.42)';ctx.lineWidth=r*.14;ctx.lineCap='round';ctx.stroke();
    }
    ctx.restore();
  }
  destroy() {
    this.destroyed=true;if(this.animation!==undefined)cancelAnimationFrame(this.animation);
    this.observer.disconnect();this.motion.removeEventListener('change',this.reset);document.removeEventListener('visibilitychange',this.reset);
  }
}
