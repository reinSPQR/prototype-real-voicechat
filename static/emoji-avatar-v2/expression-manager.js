// ExpressionManager — VRM-style weighted blend of named expression presets.
//
// Each frame:
//   1. Smooth weights[name] toward targets[name] with an exponential decay
//      (the same TRANSITION_TAU as the old crossfade, just applied to scalar
//      weights instead of mesh-group opacities).
//   2. Resolve a flat parameter dict by additive blending of every active
//      preset on top of DEFAULTS:
//          out[k] = DEFAULTS[k] + Σ (preset[k] - DEFAULTS[k]) * weight
//      This is mathematically equivalent to a weighted average when the
//      weights sum to 1, and degrades gracefully mid-transition when they
//      don't (params drift toward DEFAULTS, which is what we want).
//
// FaceRig consumes the resolved dict; main.js reads body-motion fields
// (headTilt, headBob, breathing, tremor, antennaWag) and effect alphas
// (exclamationAlpha, thinkBubbleAlpha, zzzAlpha) directly off the same dict.

import { NeutralExpression }   from './face-neutral.js';
import { RelaxedExpression }   from './face-relaxed.js';
import { HappyExpression }     from './face-happy.js';
import { AngryExpression }     from './face-angry.js';
import { SadExpression }       from './face-sad.js';
import { SurprisedExpression } from './face-surprised.js';
import { ExcitedExpression }   from './face-excited.js';
import { ThinkingExpression }  from './face-thinking.js';
import { SleepingExpression }  from './face-sleeping.js';

// Baseline / "rest" parameter values. Anything a preset doesn't specify
// stays at its default. eyeOpen=1 because the natural rest is open eyes;
// mouthSize=1 and mouthWidth=1 for the same reason.
export const DEFAULTS = Object.freeze({
  // Eye shape variants (alpha-blended at the same anchor)
  eyeFillAlpha: 0,    eyeArchAlpha: 0,    eyeVAlpha: 0,
  eyeCrossAlpha: 0,   eyeClosedAlpha: 0,
  // Eye decoration
  specularAlpha: 0,
  // Eye continuous transforms
  eyeOpen: 1,         eyeTiltL: 0,        eyeTiltR: 0,
  eyeOffsetX: 0,      eyeOffsetY: 0,
  // Mouth (closed-loop stroke)
  mouthCurl: 0,       mouthWidth: 1,      mouthOpen: 0,    mouthSize: 1,
  // Floating effects
  exclamationAlpha: 0, thinkBubbleAlpha: 0, zzzAlpha: 0,
  // Body motion (amplitudes — main.js applies the actual oscillation)
  headTilt: 0,        headBob: 0,         breathing: 0,
  tremor: 0,          antennaWag: 0,
});

export const EXPRESSIONS = {
  neutral:   NeutralExpression,
  relaxed:   RelaxedExpression,
  happy:     HappyExpression,
  angry:     AngryExpression,
  sad:       SadExpression,
  surprised: SurprisedExpression,
  excited:   ExcitedExpression,
  thinking:  ThinkingExpression,
  sleeping:  SleepingExpression,
};

const TRANSITION_TAU = 0.35;   // seconds; matches the legacy face-crossfade tau.

export class ExpressionManager {
  constructor() {
    this.weights = {};
    this.targets = {};
    for (const name of Object.keys(EXPRESSIONS)) {
      this.weights[name] = name === 'neutral' ? 1 : 0;
      this.targets[name] = name === 'neutral' ? 1 : 0;
    }
    // Pre-allocated output buffer so we don't allocate a fresh dict each frame.
    this.resolved = { ...DEFAULTS };
  }

  // The state machine calls this; only one expression is "on" at a time.
  setExpression(name) {
    if (!EXPRESSIONS[name]) name = 'neutral';
    for (const k in this.targets) this.targets[k] = (k === name) ? 1 : 0;
  }

  // Like VRM's setValue — additive override for advanced callers (e.g. you
  // could blend `talking + happy` in parallel by setting both to nonzero).
  setValue(name, w) {
    if (!EXPRESSIONS[name]) return;
    this.targets[name] = Math.max(0, Math.min(1, w));
  }

  update(dt) {
    // 1) Smooth weights toward targets.
    const k = 1 - Math.exp(-dt / TRANSITION_TAU);
    for (const name in this.weights) {
      this.weights[name] += (this.targets[name] - this.weights[name]) * k;
    }

    // 2) Resolve params: start from DEFAULTS, add (preset - default) * weight
    //    for every active preset.
    const out = this.resolved;
    for (const k2 in DEFAULTS) out[k2] = DEFAULTS[k2];

    for (const name in this.weights) {
      const w = this.weights[name];
      if (w < 1e-4) continue;
      const preset = EXPRESSIONS[name];
      for (const param in preset) {
        const baseline = DEFAULTS[param] ?? 0;
        out[param] += (preset[param] - baseline) * w;
      }
    }

    return out;
  }
}
