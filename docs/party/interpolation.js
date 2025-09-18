export const lerp = (a, b, t) => a + (b - a) * t;

export const interpolateResults = (prev, next, alpha) => {
  if (!prev || !next) return next || prev;
  const result = structuredClone(prev);

  if (prev.faceLandmarks && next.faceLandmarks) {
    for (let i = 0; i < prev.faceLandmarks[0].length; i++) {
      result.faceLandmarks[0][i].x = lerp(
        prev.faceLandmarks[0][i].x,
        next.faceLandmarks[0][i].x,
        alpha,
      );
      result.faceLandmarks[0][i].y = lerp(
        prev.faceLandmarks[0][i].y,
        next.faceLandmarks[0][i].y,
        alpha,
      );
      result.faceLandmarks[0][i].z = lerp(
        prev.faceLandmarks[0][i].z,
        next.faceLandmarks[0][i].z,
        alpha,
      );
    }
  }

  if (prev.faceBlendshapes && next.faceBlendshapes) {
    const p = prev.faceBlendshapes[0].categories;
    const n = next.faceBlendshapes[0].categories;
    for (let i = 0; i < p.length; i++) {
      result.faceBlendshapes[0].categories[i].score = lerp(
        p[i].score,
        n[i].score,
        alpha,
      );
    }
  }
  return result;
};
