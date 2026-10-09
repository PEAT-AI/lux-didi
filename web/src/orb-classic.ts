// First-party procedural extraction authorized by WEB-R4.
// PEAT-AI/Vicuna f27bca7bcbc77a77e3401da2683abf2f1aaf023c
// voice-blob.component.ts lines 174-227, 1123-1297, 1529-1665.
// Framework wrapper intentionally excluded. See orb-provenance.md.
import { createNoise2D } from 'simplex-noise';

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
  private seed = 20261009;
  private noise = {noise2D: createNoise2D(() => {
    // Fixed seed gives reproducible geometry without a third-party RNG.
    this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5;
    return (this.seed >>> 0) / 4294967296;
  })};
  private ambientNoiseOffset = {x: 0, y: 0};
  private ambientTime = 0;
  private state = 'idle';
  private smoothedPlaybackLevel = 0;
  constructor(private ctx: CanvasRenderingContext2D) {}
  private isSpeaking() { return this.state === 'speaking'; }
  private isListening() { return this.state === 'listening'; }
  private isProcessing() { return this.state === 'thinking'; }
  draw(cx: number, cy: number, radius: number, hue: number, time: number, state: string, level: number, activity: number) {
    this.ambientTime = time; this.state = state; this.smoothedPlaybackLevel = level;
    this.drawLuminousGlow(cx, cy, radius, hue, state === 'quiet' ? 0.1 : 0.35);
    this.drawRadialFlares(cx, cy, radius, hue, state === 'quiet' ? 0.12 : 0.3, activity);
    this.drawWobblyCore(cx, cy, radius, hue, activity);
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

}
