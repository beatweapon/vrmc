// VRM `happy` and blink presets are authored per model and may affect the mouth.
// For this diagnostic path, suppress only `happy` and leave blink/vowels exactly
// as produced by the camera-driven face solver.
export const smileEyesOnly = face => {
  if (!face?.expressions || !('happy' in face.expressions)) return face;
  if (!Number.isFinite(face.expressions.happy) || face.expressions.happy <= 0) return face;
  return {
    ...face,
    expressions: {
      ...face.expressions,
      happy: 0,
    },
  };
};
