const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const smoothstep = value => { const t = clamp01(value); return t * t * (3 - 2 * t); };

// VRM `happy` is authored per model and can contain mouth deformation that is
// unrelated to the camera-observed mouth. Keep smile detection for a gentle eye
// squint, but never apply the authored happy preset itself.
//
// MediaPipe can also report strong mouth stretch while laughing. When the
// camera-observed mouth is clearly open vertically, prefer the neutral-open
// `aa` shape over the wide `ih`/`ee` family. This correction is driven only by
// measured mouth geometry, not by the smile score.
export const smileEyesOnly = face => {
  if (!face?.expressions || !('happy' in face.expressions)) return face;

  const expressions = {...face.expressions};
  const happy = clamp01(expressions.happy);
  expressions.happy = 0;

  if (happy > 0) {
    const squint = happy * .35;
    expressions.blinkLeft = Math.max(clamp01(expressions.blinkLeft), squint);
    expressions.blinkRight = Math.max(clamp01(expressions.blinkRight), squint);
  }

  const mouthOpen = face.measurement?.mouthOpen;
  if (Number.isFinite(mouthOpen)) {
    // Synthetic/real measurements put a normal open `ee` around ~0.2 while a
    // visibly wide-open `aa` is around ~0.4+. Blend across the middle instead
    // of switching abruptly so speech remains continuous.
    const openBias = smoothstep((mouthOpen - .26) / .20);
    if (openBias > 0) {
      const ih = clamp01(expressions.ih);
      const ee = clamp01(expressions.ee);
      const transfer = (ih + ee) * openBias;
      if (transfer > 0) {
        const wide = ih + ee;
        const keep = wide > 0 ? (wide - transfer) / wide : 1;
        expressions.ih = ih * keep;
        expressions.ee = ee * keep;
        expressions.aa = clamp01(clamp01(expressions.aa) + transfer);
      }
    }
  }

  return {...face, expressions};
};
