# Classic orb provenance

Source: PEAT-AI/Vicuna, immutable main revision
`f27bca7bcbc77a77e3401da2683abf2f1aaf023c`.
First-party reuse explicitly authorized by user/master ruling WEB-R4. This note
records provenance, not an invented public license for the original repository.

From `src/app/features/assistant/components/voice-blob/voice-blob.component.ts`:
- Lines 174 to 227: clampFrameDelta, smoothingAlpha, ORB_SMOOTHING_TAU,
  speakingActivityTarget, speakingTentacleOffsets.
- Lines 945 to 1121: classic dispatch and drawAmbientCorona.
- Lines 1123 to 1524: drawLuminousGlow, drawRadialFlares, getTentacleParams,
  drawTentacle, drawDancingSparkles, drawBrightFlares, drawLuminousProminences,
  and drawTechRings.
- Lines 1529 to 1665: drawWobblyCore and drawWobblyBlobLayer.
- Lines 1700 to 1808: drawSparkleBurst and drawTwinklingRing.
- Lines 1887 to 1931: drawHotCore.

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

Orb-only style adaptation: source `voice-blob.component.css` lines 61 to 75:
block canvas, pointer-events none, filter transition, neutral grayscale/brightness/
opacity. Didi supplies wrapper sizing/labels/layout and static reduced-motion.

Deliberate adaptations: classic renderer rather than the 133KB Angular component;
no visage or alternate themes; fixed injected idle24/active30 fps
budget (not a claim to copy device-tier service); silent production audio frame;
current five-channel/playback/activity asymmetric smoothing constants, current >0.01
speaking distinction, current state palette and neutral filter. Source feasibility
and real browser rendering are separate from exact pixel parity or WKWebView proof.
