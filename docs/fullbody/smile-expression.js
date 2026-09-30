const clamp01 = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

// VRM `happy` is authored per model and can contain mouth deformation that is
// unrelated to the camera-observed mouth. Keep smile detection, but use it only
// for a gentle eye squint so both mouth aperture and mouth shape remain driven
// exclusively by the camera-derived aa/ih/ee/ou/oh expressions.
export const smileEyesOnly = face => {
  if (!face?.expressions || !('happy' in face.expressions)) return face;
  const happy = clamp01(face.expressions.happy);
  if (happy <= 0) return face;

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
