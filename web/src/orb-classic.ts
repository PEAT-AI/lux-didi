// Authorized first-party classic painter, Vicuna f27bca7 (987–1932, dispatch 956–985).
// Original reachable geometry is retained; inline reference noise is NOT copied.
import {createNoise2D} from 'simplex-noise';
import type {OrbFrame} from './orb-frame';
export type OrbNoise = (x:number,y:number)=>number;
export function createOrbNoise(seed=20261009): OrbNoise {
  return createNoise2D(()=>{
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    return (seed>>>0)/4294967296;
  });
}
export const MAX_FRAME_DELTA_S = 0.1;

export function clampFrameDelta(seconds: number): number {
  return Math.min(Math.max(seconds, 0), MAX_FRAME_DELTA_S);
}

/**
 * dt-corrected one-pole coefficient: `alpha = 1 - e^(-dt/tau)`. Reproduces the legacy fixed
 * per-frame coefficient `k` at 60fps when `tau = -(1/60) / ln(1-k)`.
 */
export function smoothingAlpha(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

/**
 * Continuous time constants (seconds) for the orb's asymmetric EMAs, each derived from the
 * legacy per-frame coefficient `k` at 60fps: `tau = -(1/60) / ln(1-k)`.
 */
export const ORB_SMOOTHING_TAU = {
  lowAttack: 0.038689247052, lowDecay: 0.199884205627,
  midAttack: 0.024044917348, midDecay: 0.102552156344,
  highAttack: 0.013843059085, highDecay: 0.074690335295,
  fluxAttack: 0.010355582243, fluxDecay: 0.046727887534,
  playbackAttack: 0.032626919816, playbackDecay: 0.057934324946,
  audioAttack: 0.046727887534, audioDecay: 0.102552156344,
  // Secondary SPEAKING macro envelope (see `speakingActivityTarget`). Not legacy-derived:
  // chosen for the human-voice feel — the shape blooms into a syllable fast (~80ms) and
  // releases slowly (~250ms), so it never twitches on a plosive.
  activityAttack: 0.08, activityDecay: 0.25,
} as const;

/**
 * SPEAKING macro-drive target: the orb's size / geometry follows the smoothed LOW band (vowel
 * body) only. Spectral flux is deliberately absent — it spikes on every plosive and consonant,
 * and feeding it into the macro multiplier made the whole orb twitch hectically. Flux still
 * drives micro accents (visage lips, visage hair shimmer), never the body. Range 1.0–2.5x, then
 * eased through the `smoothedActivity` EMA in `animate()`.
 */
export function speakingActivityTarget(smoothedLow: number): number {
  return 1.0 + smoothedLow * 1.5;
}

/**
 * SPEAKING tentacle offsets: amplitude and reach ride one scalar — the smoothed RMS playback
 * level (how loud her voice is) — so consonants no longer punch the arms. Kept as a function of
 * a single scalar so no flux term can creep back in unnoticed.
 */
export function speakingTentacleOffsets(motion: number): {
  ampBase: number;
  ampTip: number;
  reach: number;
} {
  return { ampBase: motion * 0.4, ampTip: motion * 0.6, reach: motion * 0.4 };
}

export class ClassicRenderer {
  private frame!: Readonly<OrbFrame>;
  private noise: {noise2D:OrbNoise};
  constructor(private ctx: CanvasRenderingContext2D, noise: OrbNoise=createOrbNoise()) {this.noise={noise2D:noise};}
  private get time(){return this.frame.time;}
  private get ambientTime(){return this.frame.ambientTime;}
  private get ambientNoiseOffset(){return this.frame.ambientNoiseOffset;}
  private get smoothedPlaybackLevel(){return this.frame.smoothedPlaybackLevel;}
  private isSpeaking(){return this.frame.speaking;}
  private isListening(){return this.frame.listening;}
  private isProcessing(){return this.frame.processing;}
  draw(frame: Readonly<OrbFrame>) {
    this.frame=frame;
    this.dispatchLayers(frame.size/2,frame.size/2,frame.size*.05,frame.hue??210,
      frame.activityMultiplier,frame.glowIntensity,frame.flareIntensity);
  }
  private dispatchLayers(
    cx: number,
    cy: number,
    baseRadius: number,
    hue: number,
    activity: number,
    glowIntensity: number,
    flareIntensity: number,
    coreScale = 1,
    coreLiftY = 0,
    coreAlpha = 1,
    coronaMul = 1,
    prominenceMul = 1,
  ): void {
    const budget = 10; // Complete high-tier classic: all eleven reachable calls.

    this.drawAmbientCorona(cx, cy, baseRadius, hue, activity, coronaMul); // rank 1 — essential
    if (2 <= budget) this.drawLuminousGlow(cx, cy, baseRadius, hue, glowIntensity); // rank 2
    if (3 <= budget) this.drawRadialFlares(cx, cy, baseRadius, hue, flareIntensity, activity); // rank 3
    if (7 <= budget) this.drawDancingSparkles(cx, cy, baseRadius, hue, activity); // rank 7 — optional
    if (6 <= budget) this.drawBrightFlares(cx, cy, baseRadius, hue, flareIntensity, activity); // rank 6
    if (5 <= budget) this.drawLuminousProminences(cx, cy, baseRadius, hue, activity, prominenceMul); // rank 5
    if (4 <= budget) this.drawTechRings(cx, cy, baseRadius, hue, activity); // rank 4
    // The two solid cores accept an optional transform (default identity) so the visage theme can
    // shrink/lift/dim them into a "third eye" glow. Classic passes (1,0,1) → byte-identical.
    this.drawWobblyCore(cx, cy - coreLiftY, baseRadius * coreScale, hue, activity, coreAlpha); // core — always
    if (9 <= budget) this.drawSparkleBurst(cx, cy, baseRadius, hue, activity); // rank 9 — optional
    if (8 <= budget) this.drawTwinklingRing(cx, cy, baseRadius, hue, activity); // rank 8 — optional
    this.drawHotCore(cx, cy - coreLiftY, baseRadius * 0.5 * coreScale, hue, activity, coreAlpha); // core — always
  }
  private drawAmbientCorona(cx: number, cy: number, radius: number, hue: number, activity: number, presenceMul = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Visage yield: pull the whole corona back behind the face. Guarded so the classic path
    // (presenceMul === 1) never touches globalAlpha and stays byte-identical to main.
    if (presenceMul !== 1) ctx.globalAlpha *= presenceMul;

    // === LAYER 1: Outer slow-moving flame tendrils ===
    const outerFlameCount = 12;
    for (let i = 0; i < outerFlameCount; i++) {
      // Base angle with slow constant rotation
      const baseAngle = (i / outerFlameCount) * Math.PI * 2;
      const slowRotation = this.ambientTime * 0.15;

      // Wobble using noise for organic movement (ALWAYS animating)
      const noiseX = Math.cos(baseAngle) + this.ambientNoiseOffset.x;
      const noiseY = Math.sin(baseAngle) + this.ambientNoiseOffset.y;
      const wobble = this.noise.noise2D(noiseX * 0.5, noiseY * 0.5 + this.ambientTime * 0.3) * 0.4;

      const angle = baseAngle + slowRotation + wobble;

      // Flame length: BASE length (always visible) + BOOST from activity
      const baseLength = radius * 0.4; // Reduced from 0.8
      const activityBoost = radius * 0.8 * (activity - 0.5); // Reduced from 1.5
      const lengthPulse = 0.7 + Math.sin(this.ambientTime * 2 + i * 0.7) * 0.3;
      const flameLength = (baseLength + Math.max(0, activityBoost)) * lengthPulse;

      // Start from orb edge
      const startDist = radius * 0.95;
      const startX = cx + Math.cos(angle) * startDist;
      const startY = cy + Math.sin(angle) * startDist;

      // Control point for bezier curve (makes flame curl)
      const ctrlAngle = angle + Math.sin(this.ambientTime * 1.5 + i) * 0.5;
      const ctrlDist = startDist + flameLength * 0.6;
      const ctrlX = cx + Math.cos(ctrlAngle) * ctrlDist;
      const ctrlY = cy + Math.sin(ctrlAngle) * ctrlDist;

      // End point
      const endAngle = angle + Math.sin(this.ambientTime * 2.5 + i * 1.3) * 0.3;
      const endX = cx + Math.cos(endAngle) * (startDist + flameLength);
      const endY = cy + Math.sin(endAngle) * (startDist + flameLength);

      // Gradient: white-yellow core fading to orange-red tips
      const grad = ctx.createLinearGradient(startX, startY, endX, endY);
      const baseAlpha = 0.5; // Always visible base
      const activityAlpha = 0.3 * (activity - 0.5); // Extra when active
      const alpha = baseAlpha + Math.max(0, activityAlpha);

      grad.addColorStop(0, `hsla(${hue}, 90%, 28%, ${alpha})`);
      grad.addColorStop(0.2, `hsla(${hue}, 85%, 24%, ${alpha * 0.9})`);
      grad.addColorStop(0.5, `hsla(${hue}, 80%, 20%, ${alpha * 0.6})`);
      grad.addColorStop(0.8, `hsla(${hue}, 75%, 16%, ${alpha * 0.3})`);
      grad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      // Draw curved flame
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 6 + activity * 8;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // === LAYER 2: Fast-moving inner flames (more turbulent) ===
    const innerFlameCount = 18;
    for (let i = 0; i < innerFlameCount; i++) {
      const baseAngle = (i / innerFlameCount) * Math.PI * 2;
      const fastRotation = this.ambientTime * 0.4; // Faster rotation

      // More aggressive noise for turbulent look
      const noiseVal = this.noise.noise2D(
        Math.cos(baseAngle) * 2 + this.ambientTime * 0.8,
        Math.sin(baseAngle) * 2 + this.ambientTime * 0.6
      );
      const wobble = noiseVal * 0.6;

      const angle = baseAngle + fastRotation + wobble;

      // Shorter, more flickery flames
      const baseLength = radius * 0.4;
      const activityBoost = radius * 0.8 * (activity - 0.5);
      const flicker = 0.5 + Math.sin(this.ambientTime * 8 + i * 2) * 0.5;
      const flameLength = (baseLength + Math.max(0, activityBoost)) * flicker;

      const startDist = radius * 0.9;
      const startX = cx + Math.cos(angle) * startDist;
      const startY = cy + Math.sin(angle) * startDist;
      const endX = cx + Math.cos(angle) * (startDist + flameLength);
      const endY = cy + Math.sin(angle) * (startDist + flameLength);

      const alpha = 0.4 + Math.max(0, 0.4 * (activity - 0.5));

      const grad = ctx.createLinearGradient(startX, startY, endX, endY);
      grad.addColorStop(0, `hsla(${hue}, 85%, 28%, ${alpha})`);
      grad.addColorStop(0.3, `hsla(${hue}, 80%, 24%, ${alpha * 0.7})`);
      grad.addColorStop(0.7, `hsla(${hue}, 75%, 20%, ${alpha * 0.3})`);
      grad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.strokeStyle = grad;
      ctx.lineWidth = 3 + activity * 4;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    // === LAYER 3: Glowing halo ring that pulses ===
    const haloRadius = radius * (1.1 + Math.sin(this.ambientTime * 1.5) * 0.05);
    const haloGrad = ctx.createRadialGradient(cx, cy, radius * 0.8, cx, cy, haloRadius * 1.4);
    const haloAlpha = 0.3 + Math.max(0, 0.3 * (activity - 0.5));
    haloGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    haloGrad.addColorStop(0.6, `hsla(${hue}, 100%, 70%, ${haloAlpha * 0.3})`);
    haloGrad.addColorStop(0.8, `hsla(${hue - 10}, 100%, 60%, ${haloAlpha * 0.5})`);
    haloGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, haloRadius * 1.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private drawLuminousGlow(cx: number, cy: number, radius: number, hue: number, intensity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Very bright white-yellow glow
    const glowRadius = radius * 5;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowRadius);

    // Teal center fading outward
    gradient.addColorStop(0, `hsla(${hue}, 90%, 28%, ${intensity * 0.5})`);
    gradient.addColorStop(0.1, `hsla(${hue}, 85%, 26%, ${intensity * 0.35})`);
    gradient.addColorStop(0.2, `hsla(${hue}, 80%, 24%, ${intensity * 0.25})`);
    gradient.addColorStop(0.4, `hsla(${hue}, 75%, 22%, ${intensity * 0.15})`);
    gradient.addColorStop(0.6, `hsla(${hue}, 70%, 20%, ${intensity * 0.08})`);
    gradient.addColorStop(0.8, `hsla(${hue}, 65%, 18%, ${intensity * 0.03})`);
    gradient.addColorStop(1, 'rgba(0, 151, 136, 0)');

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, glowRadius, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  private drawRadialFlares(
    cx: number,
    cy: number,
    radius: number,
    hue: number,
    intensity: number,
    activity: number
  ): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Determine state-specific parameters for tentacle behavior
    const params = this.getTentacleParams();

    // Modulate parameters with audio level for SPEAKING state
    let ampBase = params.ampBase;
    let ampTip = params.ampTip;
    let reach = params.reach;

    if (this.isSpeaking()) {
      // Tentacle amplitude and reach ride the smoothed RMS playback level (voice body) only.
      // Flux is deliberately absent here: its per-plosive spikes punched the arms and read as
      // frantic. The offsets grow smoothly with how loud she actually is.
      const offsets = speakingTentacleOffsets(this.smoothedPlaybackLevel);
      ampBase += offsets.ampBase;
      ampTip += offsets.ampTip;
      reach += offsets.reach;
    }

    // Draw 16 organic octopus tentacles
    const tentacleCount = 16;

    for (let i = 0; i < tentacleCount; i++) {
      const baseAngle = (i / tentacleCount) * Math.PI * 2;
      const armOffset = i * 0.7; // Unique phase offset per tentacle

      // Calculate 3-point spine with sine stacking and lag
      // Base point: fixed on orb edge
      const baseDist = radius * 0.9;
      const baseX = cx + Math.cos(baseAngle) * baseDist;
      const baseY = cy + Math.sin(baseAngle) * baseDist;

      // Mid point (elbow): animated angle with base amplitude
      const elbowTime = this.ambientTime * params.speed + armOffset;
      const elbowAngleOffset = Math.sin(elbowTime) * ampBase;
      const elbowAngle = baseAngle + elbowAngleOffset;
      const elbowDist = baseDist + radius * reach * 0.5;
      const midX = cx + Math.cos(elbowAngle) * elbowDist;
      const midY = cy + Math.sin(elbowAngle) * elbowDist;

      // Tip point: animated with lag for trailing effect
      const tipTime = this.ambientTime * params.speed - params.lag + armOffset;
      const tipAngleOffset = Math.sin(tipTime) * ampTip;
      const tipAngle = baseAngle + tipAngleOffset;
      const tipDist = baseDist + radius * reach * 1.0;
      const tipX = cx + Math.cos(tipAngle) * tipDist;
      const tipY = cy + Math.sin(tipAngle) * tipDist;

      // Base width for tentacle (tapers to point at tip)
      const baseWidth = radius * 0.12 * intensity * (0.8 + (i % 3) * 0.4);

      // Draw tentacle as tapered filled shape
      this.drawTentacle(ctx, baseX, baseY, midX, midY, tipX, tipY, baseWidth, hue, intensity);
    }

    ctx.restore();
  }

  /**
   * Get tentacle animation parameters based on current state
   */
  private getTentacleParams(): {
    speed: number;
    ampBase: number;
    ampTip: number;
    lag: number;
    reach: number;
  } {
    if (this.isListening()) {
      return { speed: 1.0, ampBase: 0.2, ampTip: 0.4, lag: 1.5, reach: 0.7 }; // Reduced reach
    } else if (this.isProcessing()) {
      return { speed: 5.0, ampBase: 0.15, ampTip: 0.25, lag: 0.3, reach: 0.75 }; // Reduced reach
    } else if (this.isSpeaking()) {
      return { speed: 2.2, ampBase: 0.5, ampTip: 1.2, lag: 0.9, reach: 1.4 }; // More organic, longer, wobblier octopus-plant tentacles
    } else {
      // DEFAULT (idle, connected, etc.)
      return { speed: 0.8, ampBase: 0.1, ampTip: 0.2, lag: 1.2, reach: 0.6 }; // Reduced reach
    }
  }

  /**
   * Draw a single octopus tentacle as a tapered Bezier curve
   */
  private drawTentacle(
    ctx: CanvasRenderingContext2D,
    baseX: number,
    baseY: number,
    midX: number,
    midY: number,
    tipX: number,
    tipY: number,
    baseWidth: number,
    hue: number,
    intensity: number
  ): void {
    // Calculate normal vector at base for width
    const dx = midX - baseX;
    const dy = midY - baseY;
    const len = Math.hypot(dx, dy);
    if (len === 0) return; // Avoid division by zero

    const nx = -dy / len * baseWidth;
    const ny = dx / len * baseWidth;

    // Gradient from teal at base to transparent at tip
    const grad = ctx.createLinearGradient(baseX, baseY, tipX, tipY);
    const alpha = 0.6 * intensity;
    grad.addColorStop(0, `hsla(${hue}, 90%, 28%, ${alpha})`);
    grad.addColorStop(0.2, `hsla(${hue}, 85%, 26%, ${alpha * 0.8})`);
    grad.addColorStop(0.5, `hsla(${hue}, 80%, 24%, ${alpha * 0.5})`);
    grad.addColorStop(0.8, `hsla(${hue}, 75%, 20%, ${alpha * 0.2})`);
    grad.addColorStop(1, 'rgba(0, 151, 136, 0)');

    // Draw tapered tentacle shape
    ctx.beginPath();
    ctx.moveTo(baseX + nx, baseY + ny); // Left side of base
    ctx.quadraticCurveTo(midX, midY, tipX, tipY); // Curve to tip
    ctx.quadraticCurveTo(midX, midY, baseX - nx, baseY - ny); // Curve back to right side
    ctx.closePath();

    ctx.fillStyle = grad;
    ctx.fill();

    // Add subtle glow along tentacle
    ctx.strokeStyle = `hsla(${hue}, 80%, 30%, ${alpha * 0.3})`;
    ctx.lineWidth = baseWidth * 0.3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(midX, midY, tipX, tipY);
    ctx.stroke();
  }

  private drawDancingSparkles(cx: number, cy: number, radius: number, hue: number, activity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // ALWAYS VISIBLE dancing sparkles around the orb
    // Base animation runs constantly, activity makes them bigger/brighter
    // Increase sparkle count when active (speaking)
    const sparkleCount = activity > 0.9 ? 16 : 8;  // More sparkles when speaking

    for (let i = 0; i < sparkleCount; i++) {
      // Each sparkle has its own orbit - uses ambientTime for constant motion
      const orbitRadius = radius * (1.1 + (i % 5) * 0.15); // Tighter orbit
      const orbitSpeed = 0.3 + (i % 3) * 0.15;
      const angle = (i / sparkleCount) * Math.PI * 2 + this.ambientTime * orbitSpeed * (i % 2 === 0 ? 1 : -1);

      // Twinkle effect - brightness oscillates (uses ambientTime)
      const twinkle = Math.sin(this.ambientTime * 8 + i * 1.7) * 0.5 + 0.5;

      // Size: BASE (always visible) + BOOST (from activity)
      const baseSize = 1.5 + twinkle * 1.5;
      const activityBoost = twinkle * 1.5 * Math.max(0, activity - 0.5);
      const size = baseSize + activityBoost;

      const x = cx + Math.cos(angle) * orbitRadius;
      const y = cy + Math.sin(angle) * orbitRadius;

      // Alpha: BASE (always visible) + BOOST (from activity)
      const baseAlpha = 0.3 + twinkle * 0.3;
      const activityAlphaBoost = twinkle * 0.4 * Math.max(0, activity - 0.5);
      const alpha = baseAlpha + activityAlphaBoost;

      // Glow around sparkle - teal
      const sparkleGrad = ctx.createRadialGradient(x, y, 0, x, y, size * 4);
      sparkleGrad.addColorStop(0, `hsla(${hue}, 85%, 34%, ${alpha * 0.12})`);
      sparkleGrad.addColorStop(0.3, `hsla(${hue}, 80%, 30%, ${alpha * 0.08})`);
      sparkleGrad.addColorStop(0.6, `hsla(${hue}, 75%, 26%, ${alpha * 0.04})`);
      sparkleGrad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      ctx.fillStyle = sparkleGrad;
      ctx.beginPath();
      ctx.arc(x, y, size * 4, 0, Math.PI * 2);
      ctx.fill();

      // Bright teal center
      ctx.fillStyle = `hsla(${hue}, 90%, 36%, ${alpha * 0.1})`;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawBrightFlares(
    cx: number,
    cy: number,
    radius: number,
    hue: number,
    intensity: number,
    activity: number
  ): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Multiple bright flares with organic movement
    const flares = [
      { baseAngle: 0, widthMult: 1.2, heightMult: 1.0, phase: 0 },
      { baseAngle: Math.PI / 2, widthMult: 0.9, heightMult: 0.9, phase: 0.5 },
      { baseAngle: Math.PI / 4, widthMult: 0.6, heightMult: 0.7, phase: 1.0 },
      { baseAngle: -Math.PI / 4, widthMult: 0.6, heightMult: 0.7, phase: 1.5 },
      { baseAngle: Math.PI / 6, widthMult: 0.4, heightMult: 0.5, phase: 2.0 },
      { baseAngle: -Math.PI / 6, widthMult: 0.4, heightMult: 0.5, phase: 2.5 },
      { baseAngle: Math.PI / 3, widthMult: 0.35, heightMult: 0.4, phase: 3.0 },
      { baseAngle: -Math.PI / 3, widthMult: 0.35, heightMult: 0.4, phase: 3.5 },
    ];

    for (const flare of flares) {
      // Organic oscillation - angle wobbles slightly
      const angleWobble = Math.sin(this.ambientTime * 2 + flare.phase) * 0.03;
      const angle = flare.baseAngle + angleWobble;

      // Organic size pulsation - each flare breathes independently
      const sizePulse = 0.85 + Math.sin(this.ambientTime * 3 + flare.phase * 2) * 0.15;
      const lengthPulse = 0.9 + Math.sin(this.ambientTime * 2.5 + flare.phase) * 0.1;

      // Reduced multipliers to ensure flares stay completely within the canvas bounds
      const flareLength = radius * (2 + activity * 3) * flare.widthMult * lengthPulse;
      const flareThickness = radius * 0.06 * flare.heightMult * (1 + activity * 0.6) * sizePulse;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);

      // Draw POINTY diamond/lens shape instead of ellipse
      // Tapered from center to sharp points at both ends
      const grad = ctx.createLinearGradient(-flareLength, 0, flareLength, 0);
      grad.addColorStop(0, 'rgba(0, 151, 136, 0)');
      grad.addColorStop(0.1, `hsla(${hue}, 80%, 28%, ${intensity * 0.2})`);
      grad.addColorStop(0.3, `hsla(${hue}, 85%, 32%, ${intensity * 0.5})`);
      grad.addColorStop(0.5, `hsla(${hue}, 90%, 36%, ${intensity * 0.7})`);
      grad.addColorStop(0.7, `hsla(${hue}, 85%, 32%, ${intensity * 0.5})`);
      grad.addColorStop(0.9, `hsla(${hue}, 80%, 28%, ${intensity * 0.2})`);
      grad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      ctx.fillStyle = grad;
      ctx.beginPath();
      // Sharp diamond shape - straight lines to needle-sharp points
      ctx.moveTo(-flareLength, 0);  // Left sharp point
      ctx.lineTo(0, -flareThickness);  // Top center
      ctx.lineTo(flareLength, 0);  // Right sharp point
      ctx.lineTo(0, flareThickness);  // Bottom center
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    ctx.restore();
  }

  private drawLuminousProminences(cx: number, cy: number, radius: number, hue: number, activity: number, presenceMul = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Visage yield: the sunburst arcs go fully dark behind the face. Guarded so the classic path
    // (presenceMul === 1) never touches globalAlpha and stays byte-identical to main.
    if (presenceMul !== 1) ctx.globalAlpha *= presenceMul;

    // ALWAYS VISIBLE curved arcs shooting out (uses ambientTime)
    const numProminences = 10;
    for (let i = 0; i < numProminences; i++) {
      const baseAngle = (i / numProminences) * Math.PI * 2;
      const angleOffset = Math.sin(this.ambientTime * 1.5 + i * 0.7) * 0.25;
      const angle = baseAngle + angleOffset + this.ambientTime * 0.08;

      const extensionPhase = Math.sin(this.ambientTime * 2.5 + i * 1.3);

      // Length: BASE (always visible) + activity BOOST
      const baseLength = radius * (0.4 + extensionPhase * 0.3);
      const activityBoost = radius * extensionPhase * 0.5 * Math.max(0, activity - 0.5);
      const length = baseLength + activityBoost;

      // Alpha: BASE + activity BOOST
      const baseAlpha = 0.35 + extensionPhase * 0.2;
      const alphaBoost = extensionPhase * 0.3 * Math.max(0, activity - 0.5);
      const alpha = baseAlpha + alphaBoost;

      const startX = cx + Math.cos(angle) * radius * 0.85;
      const startY = cy + Math.sin(angle) * radius * 0.85;
      const endX = cx + Math.cos(angle) * (radius + length);
      const endY = cy + Math.sin(angle) * (radius + length);

      const ctrlAngle = angle + Math.sin(this.ambientTime * 3.5 + i) * 0.35;
      const ctrlDist = radius * (1.1 + extensionPhase * 0.5);
      const ctrlX = cx + Math.cos(ctrlAngle) * ctrlDist;
      const ctrlY = cy + Math.sin(ctrlAngle) * ctrlDist;

      // Teal gradient for prominences
      const grad = ctx.createLinearGradient(startX, startY, endX, endY);
      grad.addColorStop(0, `hsla(${hue}, 90%, 30%, ${alpha})`);
      grad.addColorStop(0.3, `hsla(${hue}, 85%, 26%, ${alpha * 0.7})`);
      grad.addColorStop(0.7, `hsla(${hue}, 80%, 22%, ${alpha * 0.3})`);
      grad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      // Line width: BASE + activity BOOST
      const baseWidth = 3;
      const widthBoost = 6 * Math.max(0, activity - 0.5);

      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.quadraticCurveTo(ctrlX, ctrlY, endX, endY);
      ctx.strokeStyle = grad;
      ctx.lineWidth = baseWidth + widthBoost;
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawTechRings(cx: number, cy: number, radius: number, hue: number, activity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Bright white-yellow tech rings
    const rings = [
      { radiusMult: 1.6, speed: 0.3, dash: [30, 40, 15, 50], width: 2, alpha: 0.6 },
      { radiusMult: 2.1, speed: -0.22, dash: [55, 30, 12, 65], width: 1.5, alpha: 0.5 },
      { radiusMult: 2.6, speed: 0.15, dash: [25, 75, 35, 55], width: 2.5, alpha: 0.4 },
    ];

    for (const ring of rings) {
      const ringRadius = radius * ring.radiusMult * (0.9 + activity * 0.2);
      const rotation = this.time * ring.speed;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(rotation);

      ctx.setLineDash(ring.dash);
      ctx.strokeStyle = `hsla(${hue}, 80%, 80%, ${ring.alpha * (0.6 + activity * 0.4)})`;
      ctx.lineWidth = ring.width;

      ctx.beginPath();
      ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
    }

    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * WOBBLY BLOB CORE - Constant organic edge deformation
   * The "Wobbly Blob" technique: noise-deformed polygon that ALWAYS animates
   * Activity boosts the amplitude, but there's always visible movement
   * Updated for light background - uses solid teal colors
   */
  private drawWobblyCore(cx: number, cy: number, radius: number, hue: number, activity: number, coreAlpha = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    // Use source-over for solid colors visible on light backgrounds
    ctx.globalCompositeOperation = 'source-over';
    // coreAlpha defaults to 1 (classic → no-op, byte-identical); the visage theme dims the core.
    ctx.globalAlpha = coreAlpha;

    // Multiple layered blobs for depth (outer to inner)
    // Each layer uses different noise parameters for varied movement
    // Colors: dark teal outer → lighter teal inner

    // === OUTER LAYER (darkest teal, most wobbly) ===
    const outerRadius = radius * 1.15;
    this.drawWobblyBlobLayer(ctx, cx, cy, outerRadius, {
      hue: hue,
      saturation: 85,
      lightness: 24, 
      alpha: 0.3, // Reduced from 0.6
      noiseScale: 1.2,
      noiseSpeed: 0.4,
      baseAmplitude: 0.25,
      activityAmplitude: 0.35,
      activity,
    });

    // === MIDDLE LAYER (medium teal) ===
    const midRadius = radius * 1.0;
    this.drawWobblyBlobLayer(ctx, cx, cy, midRadius, {
      hue: hue,
      saturation: 90,
      lightness: 30, 
      alpha: 0.4, // Reduced from 0.75
      noiseScale: 0.9,
      noiseSpeed: 0.35,
      baseAmplitude: 0.2,
      activityAmplitude: 0.3,
      activity,
    });

    // === INNER LAYER (brighter teal) ===
    const innerRadius = radius * 0.85;
    this.drawWobblyBlobLayer(ctx, cx, cy, innerRadius, {
      hue: hue,
      saturation: 95,
      lightness: 36, 
      alpha: 0.5, // Reduced from 0.85
      noiseScale: 0.7,
      noiseSpeed: 0.3,
      baseAmplitude: 0.15,
      activityAmplitude: 0.25,
      activity,
    });

    // === CORE LAYER (lightest teal center) ===
    const coreRadius = radius * 0.6;
    this.drawWobblyBlobLayer(ctx, cx, cy, coreRadius, {
      hue: hue,
      saturation: 80,
      lightness: 42, 
      alpha: 0.6, // Reduced from 0.95
      noiseScale: 0.5,
      noiseSpeed: 0.25,
      baseAmplitude: 0.1,
      activityAmplitude: 0.15,
      activity,
    });

    ctx.restore();
  }

  /**
   * Draw a single wobbly blob layer with noise deformation
   * Updated for light background with solid teal colors
   */
  private drawWobblyBlobLayer(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
    params: {
      hue: number;
      saturation: number;
      lightness: number;
      alpha: number;
      noiseScale: number;
      noiseSpeed: number;
      baseAmplitude: number;
      activityAmplitude: number;
      activity: number;
    }
  ): void {
    const points = 48;
    const { noiseScale, noiseSpeed, baseAmplitude, activityAmplitude, activity } = params;

    // Total amplitude = base (always) + activity boost
    const amplitude = radius * (baseAmplitude + activityAmplitude * Math.max(0, activity - 0.5));

    // Create gradient fill - solid teal colors visible on white
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.3);
    // Lighter center, darker edges for depth
    grad.addColorStop(0, `hsla(${params.hue}, ${params.saturation}%, ${params.lightness + 8}%, ${params.alpha})`);
    grad.addColorStop(0.5, `hsla(${params.hue}, ${params.saturation}%, ${params.lightness}%, ${params.alpha})`);
    grad.addColorStop(0.85, `hsla(${params.hue}, ${params.saturation - 5}%, ${params.lightness - 5}%, ${params.alpha * 0.7})`);
    grad.addColorStop(1, `hsla(${params.hue}, ${params.saturation - 10}%, ${params.lightness - 8}%, 0)`);

    ctx.beginPath();

    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;

      // Sample noise at this angle - uses ambientTime for constant movement
      const nx = Math.cos(angle) * noiseScale + this.ambientNoiseOffset.x * 0.3;
      const ny = Math.sin(angle) * noiseScale + this.ambientNoiseOffset.y * 0.3;

      // Multiple octaves of noise for more organic look
      const noise1 = this.noise.noise2D(nx + this.ambientTime * noiseSpeed, ny + this.ambientTime * noiseSpeed * 0.8);
      const noise2 = this.noise.noise2D(nx * 2 + this.ambientTime * noiseSpeed * 1.5, ny * 2) * 0.4;
      const combinedNoise = noise1 + noise2;

      // Radius at this point
      const r = radius + combinedNoise * amplitude;

      const x = cx + Math.cos(angle) * r;
      const y = cy + Math.sin(angle) * r;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  private drawSparkleBurst(cx: number, cy: number, radius: number, hue: number, activity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // ALWAYS VISIBLE sparkles shooting outward
    // Base count (always visible) + activity burst (more when active)
    // More particles when speaking
    const particleCount = 8 + Math.floor(activity * 10);  // 8-18 based on activity
    const sparkleCount = particleCount;

    for (let i = 0; i < sparkleCount; i++) {
      const baseAngle = (i / sparkleCount) * Math.PI * 2;
      const angleJitter = Math.sin(this.ambientTime * 3.5 + i * 2.3) * 0.35;
      const angle = baseAngle + angleJitter + this.ambientTime * 0.25;

      const phase = (this.ambientTime * 1.8 + i * 0.12) % 2.5;
      const dist = radius * (0.9 + phase * 0.8); // Reduced from 1.8 to 0.8 - sparks stay closer

      // Size: BASE + activity BOOST
      const baseSize = 2 + Math.sin(this.ambientTime * 7 + i) * 1.5;
      const activityBoost = (2 + Math.sin(this.ambientTime * 7 + i) * 1.0) * Math.max(0, activity - 0.5);
      const size = (baseSize + activityBoost) * (1 - phase * 0.25);

      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;

      // Alpha: BASE + activity BOOST
      const baseAlpha = Math.max(0, 0.4 - phase * 0.15);
      const alphaBoost = Math.max(0, 0.5 - phase * 0.2) * Math.max(0, activity - 0.5);
      const alpha = baseAlpha + alphaBoost;

      // Teal sparkle
      const sparkleGrad = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
      sparkleGrad.addColorStop(0, `hsla(${hue}, 90%, 34%, ${alpha * 0.12})`);
      sparkleGrad.addColorStop(0.2, `hsla(${hue}, 85%, 30%, ${alpha * 0.08})`);
      sparkleGrad.addColorStop(0.5, `hsla(${hue}, 80%, 26%, ${alpha * 0.04})`);
      sparkleGrad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      ctx.fillStyle = sparkleGrad;
      ctx.beginPath();
      ctx.arc(x, y, size * 3, 0, Math.PI * 2);
      ctx.fill();

      // Bright teal center
      ctx.fillStyle = `hsla(${hue}, 90%, 36%, ${alpha * 0.1})`;
      ctx.beginPath();
      ctx.arc(x, y, size * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawTwinklingRing(cx: number, cy: number, radius: number, hue: number, activity: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // ALWAYS VISIBLE twinkling sparkles in a ring (uses ambientTime)
    const count = 12;
    const ringRadius = radius * 1.15;

    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + this.ambientTime * 0.4;
      const wobble = Math.sin(this.ambientTime * 5 + i * 2) * radius * 0.15;
      const dist = ringRadius + wobble;

      // Fast twinkle
      const twinkle = Math.sin(this.ambientTime * 12 + i * 3.1) * 0.5 + 0.5;

      // Size: BASE + activity BOOST
      const baseSize = 2 + twinkle * 2;
      const sizeBoost = twinkle * 2 * Math.max(0, activity - 0.5);
      const size = baseSize + sizeBoost;

      const x = cx + Math.cos(angle) * dist;
      const y = cy + Math.sin(angle) * dist;

      // Alpha: BASE + activity BOOST
      const baseAlpha = 0.3 + twinkle * 0.35;
      const alphaBoost = twinkle * 0.35 * Math.max(0, activity - 0.5);
      const alpha = baseAlpha + alphaBoost;

      // Teal twinkle
      ctx.fillStyle = `hsla(${hue}, 90%, 32%, ${alpha * 0.12})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();

      // Small teal glow
      const glowGrad = ctx.createRadialGradient(x, y, 0, x, y, size * 3);
      glowGrad.addColorStop(0, `hsla(${hue}, 85%, 34%, ${alpha * 0.1})`);
      glowGrad.addColorStop(0.5, `hsla(${hue}, 80%, 30%, ${alpha * 0.06})`);
      glowGrad.addColorStop(1, 'rgba(0, 151, 136, 0)');

      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(x, y, size * 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawHotCore(cx: number, cy: number, radius: number, hue: number, activity: number, coreAlpha = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx;

    ctx.save();
    // Use source-over for solid teal core visible on light backgrounds
    ctx.globalCompositeOperation = 'source-over';
    // coreAlpha defaults to 1 (classic → no-op, byte-identical); the visage theme dims the core.
    ctx.globalAlpha = coreAlpha;

    // Pulsing teal center
    const pulse = 1 + Math.sin(this.time * 3) * 0.1 * activity;
    const coreRadius = radius * pulse;

    // Solid teal core gradient (visible on white background)
    // DELICATE TUNING: Reduced alphas so it looks more like light/energy and less like a solid rock
    const innerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius);
    // Plantix teal: hsl(174, 100%, 30%) = #009788
    innerGrad.addColorStop(0, `hsla(${hue}, 100%, 28%, 0.75)`);  // Reduced from 0.95
    innerGrad.addColorStop(0.3, `hsla(${hue}, 95%, 34%, 0.6)`);  // Reduced from 0.85
    innerGrad.addColorStop(0.6, `hsla(${hue}, 90%, 40%, 0.4)`);  // Reduced from 0.6
    innerGrad.addColorStop(0.85, `hsla(${hue}, 85%, 46%, 0.15)`); // Reduced from 0.3
    innerGrad.addColorStop(1, 'rgba(0, 151, 136, 0)'); // Fade to transparent teal

    ctx.fillStyle = innerGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius, 0, Math.PI * 2);
    ctx.fill();

    // Bright center spot (lighter teal) when active
    if (activity > 0.4) {
      const spotAlpha = Math.min(1, (activity - 0.4) * 1.2);
      const spotGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * 0.4);
      spotGrad.addColorStop(0, `hsla(${hue}, 70%, 48%, ${spotAlpha * 0.5})`);  // Reduced from 0.7
      spotGrad.addColorStop(0.5, `hsla(${hue}, 80%, 40%, ${spotAlpha * 0.2})`); // Reduced from 0.4
      spotGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = spotGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, coreRadius * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }


}
/** Stateless canvas boundary: identical frame/noise yields identical calls, with no clock or DOM access. */
export function paintClassic(ctx: CanvasRenderingContext2D, frame: Readonly<OrbFrame>, noise: OrbNoise): void {
  new ClassicRenderer(ctx,noise).draw(frame);
}
