import { Quaternion, Vector3 } from 'three';
import { dampVector } from './motion.js';

const finiteVector = value => value && [value.x, value.y, value.z].every(Number.isFinite);

/** Resolve a wrist and an elbow in camera/world space without changing bone lengths. */
export function solveTwoBoneIK(shoulder, target, upperLength, lowerLength, bendHint, marginRatio = 0.001) {
  if (!finiteVector(shoulder) || !finiteVector(target) ||
      ![upperLength, lowerLength].every(value => Number.isFinite(value) && value > 1e-5)) return null;
  const axis = target.clone().sub(shoulder);
  const requestedDistance = axis.length();
  if (requestedDistance < 1e-8) axis.set(0, 1, 0);
  else axis.divideScalar(requestedDistance);
  const margin = Math.min(upperLength, lowerLength) * marginRatio;
  const distance = Math.min(upperLength + lowerLength - margin,
    Math.max(1e-8, Math.abs(upperLength - lowerLength) + margin, requestedDistance));
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

const project = (value, axis) => value.clone().addScaledVector(axis, -value.dot(axis));

// A conservative torso proxy in the shoulder frame. This is bone clearance,
// not mesh collision: clothes, hair and unusually proportioned VRMs may differ.
function torsoSection(y, height) {
  return Math.max(0, 1 - ((y + height * 0.5) / (height * 0.5 + 0.03)) ** 2);
}

function torsoInterior(point, width, height) {
  return (point.x / (width * 0.47)) ** 2 + (point.z / (width * 0.32)) ** 2 < torsoSection(point.y, height);
}

function clearBend(shoulder, solved, width, height) {
  const axis = solved.wrist.clone().sub(shoulder).normalize();
  const center = shoulder.clone().addScaledVector(axis, solved.elbow.clone().sub(shoulder).dot(axis));
  const radius = solved.elbow.distanceTo(center);
  if (radius < 1e-6) return solved;
  const safe = angle => {
    const elbow = center.clone().addScaledVector(solved.bend.clone().applyAxisAngle(axis, angle), radius);
    // Test the elbow and both segments, not just an endpoint outside the torso.
    for (const t of [0.25, 0.5, 0.75, 1]) {
      if (torsoInterior(shoulder.clone().lerp(elbow, t), width, height) ||
          torsoInterior(elbow.clone().lerp(solved.wrist, t), width, height)) return false;
    }
    return true;
  };
  if (safe(0)) return solved;
  // Rotate on the elbow's feasible circle: this preserves the wrist and both
  // segment lengths. Refine the closest safe boundary, rather than clamping xyz.
  let angle = null;
  const step = Math.PI / 36;
  for (let i = 1; i <= 36 && angle === null; i++) {
    for (const sign of [1, -1]) if (safe(sign * i * step)) {
      let lo = (i - 1) * step, hi = i * step;
      for (let j = 0; j < 10; j++) {
        const mid = (lo + hi) / 2;
        if (safe(sign * mid)) hi = mid; else lo = mid;
      }
      angle = sign * hi;
      break;
    }
  }
  if (angle === null) return solved; // No feasible pole; never stretch the arm.
  solved.bend.applyAxisAngle(axis, angle);
  solved.elbow.copy(center).addScaledVector(solved.bend, radius);
  return solved;
}

/** Persistent arm constraints, all expressed in the current torso frame.
 * Observed elbows select a plane only when well-conditioned. The previous
 * plane is parallel-transported when the wrist axis changes (also at extension).
 * This avoids re-projecting one fixed world pole through a singularity.
 */
export class ArmMotion {
  constructor(offset) {
    this.offset = offset.clone();
    this.velocity = new Vector3();
    // Lateral position, sagittal reach, sagittal angle (down=0, forward=pi/2).
    // Interpolating xyz cuts the chord from a lowered wrist to a raised wrist:
    // it collapses reach near the shoulder and forces the elbow out sideways.
    this.coordinates = new Vector3(offset.x, Math.hypot(offset.y, offset.z), Math.atan2(offset.z, -offset.y));
    this.coordinateVelocity = new Vector3();
    this.poleVelocity = new Vector3();
    this.hint = null;
    this.axis = null;
    this.bend = null;
  }

  update({ shoulder, target, measuredElbow, side, upperLength, lowerLength,
    width, height, dt, response }) {
    const offset = target.clone().sub(shoulder);
    const radius = Math.hypot(offset.y, offset.z);
    const angle = radius > 1e-5 ? Math.atan2(offset.z, -offset.y) : this.coordinates.z;
    const turn = Math.atan2(Math.sin(angle - this.coordinates.z), Math.cos(angle - this.coordinates.z));
    const goal = new Vector3(offset.x, radius, this.coordinates.z + turn);
    dampVector(this.coordinates, this.coordinateVelocity, goal, dt, response);
    if (this.coordinates.y < 0) { this.coordinates.y = 0; this.coordinateVelocity.y = 0; }
    const {x, y:r, z:theta} = this.coordinates, {x:vx, y:vr, z:omega} = this.coordinateVelocity;
    const cosine = Math.cos(theta), sine = Math.sin(theta);
    this.offset.set(x, -r * cosine, r * sine);
    this.velocity.set(vx, -vr * cosine + r * sine * omega, vr * sine + r * cosine * omega);
    const wrist = shoulder.clone().add(this.offset);
    if (torsoInterior(wrist, width, height)) {
      wrist.z = width * 0.32 * Math.sqrt(Math.max(0,
        torsoSection(wrist.y, height) - (wrist.x / (width * 0.47)) ** 2)) + 0.002;
    }
    const axis = wrist.clone().sub(shoulder).normalize();
    if (axis.lengthSq() < 0.5) axis.copy(this.axis ?? new Vector3(0, -1, 0));
    // With no measured elbow, prefer a relaxed lower/outward elbow on the
    // camera-facing side. Positive z is toward the camera in this torso frame.
    const defaultPole = new Vector3(side === 'left' ? 0.15 : -0.15, -1, 0.25);
    const preferred = project(defaultPole, axis);
    const observed = measuredElbow && project(measuredElbow, axis);
    const hint = observed && observed.lengthSq() > .04 ? measuredElbow : defaultPole;
    if (hint === measuredElbow) preferred.copy(observed);
    if (this.axis && this.bend) {
      const transport = new Quaternion().setFromUnitVectors(this.axis, axis);
      this.bend.applyQuaternion(transport);
      this.bend.copy(project(this.bend, axis).normalize());
      // Feed forward only the geometric change caused by wrist motion. Use
      // the SAME previous hint on both axes so new detector evidence still
      // gets the existing pole response, without re-filtering wrist motion.
      const before = project(this.hint, this.axis).applyQuaternion(transport);
      const after = project(this.hint, axis);
      if (before.lengthSq() > .04 && after.lengthSq() > .04 && before.dot(after) > 0) {
        before.normalize(); after.normalize();
        this.bend.applyAxisAngle(axis, Math.atan2(axis.dot(before.clone().cross(after)), before.dot(after)));
      }
    } else {
      this.bend = preferred.lengthSq() > 1e-4 ? preferred.clone().normalize()
        : project(new Vector3(0, 0, 1), axis).normalize();
    }
    if (preferred.lengthSq() > .04) {
      preferred.normalize();
      const angle = Math.atan2(axis.dot(this.bend.clone().cross(preferred)), this.bend.dot(preferred));
      const rotation = new Vector3();
      dampVector(rotation, this.poleVelocity, new Vector3(angle, 0, 0), dt, response);
      this.bend.applyAxisAngle(axis, rotation.x);
    }
    this.hint = hint.clone();
    this.axis = axis;
    // Full extension is valid: the transported plane remains defined even
    // when the triangle height reaches zero, so an artificial bend is needless.
    const solved = solveTwoBoneIK(shoulder, wrist, upperLength, lowerLength, this.bend, 0);
    if (!solved) return null;
    clearBend(shoulder, solved, width, height);
    this.bend.copy(solved.bend);
    return solved;
  }
}
