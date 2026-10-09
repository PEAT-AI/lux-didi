# Classic orb provenance

Source: PEAT-AI/Vicuna, immutable main revision
`f27bca7bcbc77a77e3401da2683abf2f1aaf023c`.
First-party reuse explicitly authorized by user/master ruling WEB-R4. This note
records provenance, not an invented public license for the original repository.

From `src/app/features/assistant/components/voice-blob/voice-blob.component.ts`:
- Lines 174–227: clampFrameDelta, smoothingAlpha, ORB_SMOOTHING_TAU,
  speakingActivityTarget, speakingTentacleOffsets.
- Lines 1123–1297: drawLuminousGlow, drawRadialFlares, getTentacleParams,
  drawTentacle.
- Lines 1529–1665: drawWobblyCore, drawWobblyBlobLayer.

Only these bounded procedural extracts are retained. The required excerpts were
under 64KB each. Angular/Sentry/signals/configuration/private persona and optional
visage/assets/entrance/application transport were excluded. No historical
screenshot is shipped. Wrapper fields/methods are Didi-owned. The same
framework-independent module serves the PWA and proposed WKWebView host.

The inline SimplexNoise class was **not copied**: its individual upstream notice
was not established. `simplex-noise` 4.0.3 is a documented MIT dependency from
https://github.com/jwagner/simplex-noise.js; its complete license notice is retained
at `/third-party-notices.txt`. Its official package README documents createNoise2D.
A Didi-owned seeded RNG makes geometry deterministic.

Orb-only style adaptation: source `voice-blob.component.css` lines 61–75:
block canvas, pointer-events none, filter transition, neutral grayscale/brightness/
opacity. Didi supplies wrapper sizing/labels/layout and static reduced-motion.

Deliberate adaptations: classic subset rather than the 133KB Angular component;
no corona/prominence/tech-ring/visage effects; fixed injected idle24/active30 fps
budget (not a claim to copy device-tier service); silent production audio frame;
current low/playback/activity asymmetric smoothing constants, current >0.01
speaking distinction, current state palette and neutral filter. Source feasibility
and real browser rendering are separate from exact pixel parity or WKWebView proof.
