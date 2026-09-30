const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

// VRM `happy` is authored per model and can contain a large mouth-open morph.
// Keep smile detection, but render it as a gentle eye squint so mouth aperture
// remains controlled by the camera-derived vowel expressions.
export const smileEyesOnly = face => {
  if (!face?.expressions) return face;
  const happy = clamp01(face.expressions.happy);
  if (happy <= 0 && face.expressions.happy === 0) return face;

  const squint = happy * .35;
  return {
    ...face,
    expressions: {
      ...face.expressions,
      happy: 0,
      blinkLeft: Math.max(clamp01(face.expressions.blinkLeft), squint),
      blinkRight: Math.max(clamp01(face.expressions.blinkRight), squint),
    },
  };
};
