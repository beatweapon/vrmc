import { Vector3 } from 'three';

const finiteVector = value => value && [value.x, value.y, value.z].every(Number.isFinite);

/** Resolve a wrist and an elbow in camera/world space without changing bone lengths. */
export function solveTwoBoneIK(shoulder, target, upperLength, lowerLength, bendHint) {
  if (!finiteVector(shoulder) || !finiteVector(target) ||
      ![upperLength, lowerLength].every(value => Number.isFinite(value) && value > 1e-5)) return null;
  const axis = target.clone().sub(shoulder);
  const requestedDistance = axis.length();
  if (requestedDistance < 1e-8) axis.set(0, 1, 0);
  else axis.divideScalar(requestedDistance);
  const margin = Math.min(upperLength, lowerLength) * 0.001;
  const distance = Math.min(upperLength + lowerLength - margin,
    Math.max(Math.abs(upperLength - lowerLength) + margin, requestedDistance));
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const height = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const bend = finiteVector(bendHint) ? bendHint.clone() : new Vector3(0, -1, 0);
  bend.addScaledVector(axis, -bend.dot(axis));
  if (bend.lengthSq() < 1e-8) {
    bend.set(0, 0, 1).addScaledVector(axis, -axis.z);
    if (bend.lengthSq() < 1e-8) bend.set(1, 0, 0).addScaledVector(axis, -axis.x);
  }
  bend.normalize();
  return {
    wrist: shoulder.clone().addScaledVector(axis, distance),
    elbow: shoulder.clone().addScaledVector(axis, along).addScaledVector(bend, height),
    bend,
  };
}
