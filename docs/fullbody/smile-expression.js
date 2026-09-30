const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const smoothstep = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };

// VRM `happy` is authored per model and can contain a large mouth-open morph.
// Keep smile detection, but render it without that authored preset:
// - gently squint the eyes
// - redistribute the camera-derived mouth expression toward the wide i/e shapes
//   without increasing its total weight, so aperture still comes from the camera.
export const smileEyesOnly = face => {
  if (!face?.expressions || !('happy' in face.expressions)) return face;
  const happy = clamp01(face.expressions.happy);
  if (happy <= 0) return face;

  const expressions = {...face.expressions};
  const squint = happy * .35;
  expressions.happy = 0;
  expressions.blinkLeft = Math.max(clamp01(expressions.blinkLeft), squint);
  expressions.blinkRight = Math.max(clamp01(expressions.blinkRight), squint);

  const aa = clamp01(expressions.aa);
  const ih = clamp01(expressions.ih);
  const ee = clamp01(expressions.ee);
  const ou = clamp01(expressions.ou);
  const oh = clamp01(expressions.oh);
  const wide = ih + ee;
  const other = aa + ou + oh;
  const mouthTotal = wide + other;

  // Do not invent a mouth pose when the camera sees closed lips. While the
  // mouth is active, move part of its existing weight toward a wider shape as
  // the detected smile increases. The sum stays unchanged, so this cannot make
  // the mouth open farther than the camera-derived expression already did.
  if (other > 1e-6 && mouthTotal > 1e-6) {
    const transfer = other * happy * .45;
    const keep = (other - transfer) / other;
    expressions.aa = aa * keep;
    expressions.ou = ou * keep;
    expressions.oh = oh * keep;

    // Preserve the solver's existing i/e balance when available. If there is
    // no wide component yet, use the current mouth activity as a proxy for the
    // same closed-i -> open-e progression used by the face solver.
    const eShare = wide > 1e-6 ? ee / wide : smoothstep((mouthTotal - .10) / .45);
    expressions.ih = ih + transfer * (1 - eShare);
    expressions.ee = ee + transfer * eShare;
  }

  return {...face, expressions};
};
