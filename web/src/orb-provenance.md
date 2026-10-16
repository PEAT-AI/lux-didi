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
no visage or alternate themes; an injected fps budget of 60 active, 30 idle in a
focused window and 12 idle unfocused (#283; Vicuna's high tier is 60 active / 12
idle, this is not a copy of its device-tier service);
current five-channel/playback/activity asymmetric smoothing constants, current >0.01
speaking distinction, current state palette and neutral filter. Source feasibility
and real browser rendering are separate from exact pixel parity or WKWebView proof.

## W5-R4 orb parity additions

- `presence-glow` halo ported from Vicuna `voice-blob.component.html:26` and its CSS
  (`.presence-glow`, `.presence-glow.visible`, `@keyframes glow-pulse`).
- Dark stage colours copied from `orb-lab.component.ts:54`
  (`bg-gradient-to-b from-gray-900 to-gray-800`, Tailwind #111827 -> #1f2937).
- Canvas 600 px desktop / 344 px narrow to match Vicuna's displayed proportion; the
  neutral state uses Vicuna's `opacity(.9)` rather than the earlier `opacity(.45)`.
- The five-band frame is no longer silent: the native player output tap and the capture
  tap post bounded levels to the renderer's `window.didiOrbLevel`; the renderer only
  smooths and draws, and never touches capture or transport authority.

## #283 motion additions

- The native tap posts a 60 Hz band frame (`{v: 2, input, output}`: broadband,
  low <300 Hz, mid, high RMS and an onset flux per 10 ms window) straight to
  `window.didiOrbLevel`; output windows are read at the playback position.
- `orb-level.ts` maps the RMS onto a perceptual dB scale (-50 to -16 dBFS) in
  place of Vicuna's analyser bytes, and owns the motion envelope: Vicuna's low
  attack with shorter releases (low 0.09 s, macro 0.06/0.13 s) so syllables
  read, a capped and gentler speaking curve, breath, eased glow/flare/scale and
  an integrated swirl.
- `orb-classic.ts` blooms the wobbly and hot core with the smoothed low band
  (`BODY_BLOOM`), brightens the small sparkles with flux (`FLUX_SPARKLE`), and
  eases tentacle parameters with an integrated phase; thinking's tentacle speed
  is 2.4 (Vicuna 5.0) for a calm swirl.
