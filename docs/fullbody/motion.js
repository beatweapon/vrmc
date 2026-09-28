import { Quaternion, Vector3 } from 'three';

// Exact solution of x'' + 2*w*x' + w*w*(x-target) = 0.
// Unlike exponential lerp, a new observation does not reset the velocity.
// Independent implementation of the critical/quaternion spring described at
// https://theorangeduck.com/page/spring-roll-call (see TRACKING_DESIGN.md).
export function dampVector(value, velocity, target, dt, response = 0.12) {
  if (!(dt > 0)) return value;
  const w = 2 / Math.max(0.001, response);
  const decay = Math.exp(-w * dt);
  for (const axis of ['x', 'y', 'z']) {
    const error = value[axis] - target[axis];
    const c = velocity[axis] + w * error;
    value[axis] = target[axis] + (error + c * dt) * decay;
    velocity[axis] = (velocity[axis] - w * c * dt) * decay;
  }
  return value;
}

export function dampQuaternion(value, velocity, target, dt, response = 0.12) {
  // Error and angular velocity live in parent space, not quaternion components.
  const error = value.clone().multiply(target.clone().invert()).normalize();
  if (error.w < 0) error.set(-error.x, -error.y, -error.z, -error.w);
  const length = Math.hypot(error.x, error.y, error.z);
  const angle = 2 * Math.atan2(length, Math.max(0, error.w));
  const log = new Vector3(error.x, error.y, error.z).multiplyScalar(length > 1e-10 ? angle / length : 2);
  dampVector(log, velocity, new Vector3(), dt, response);
  const remaining = log.length();
  const rotation = remaining > 1e-10
    ? new Quaternion().setFromAxisAngle(log.divideScalar(remaining), remaining) : new Quaternion();
  return value.copy(rotation.multiply(target)).normalize();
}

/** One render-time filter per independent constraint; never cascade filters. */
export class MotionState {
  constructor() { this.channels = new Map(); }
  rotation(key, current, target, dt, response) {
    let velocity = this.channels.get(key);
    if (!velocity) this.channels.set(key, velocity = new Vector3());
    return dampQuaternion(current, velocity, target, dt, response);
  }
  clearSide(side) {
    for (const key of this.channels.keys()) if (key.startsWith(side)) this.channels.delete(key);
  }
}
