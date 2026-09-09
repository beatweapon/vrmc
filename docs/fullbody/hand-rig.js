import { Matrix4, Quaternion, Vector3 } from 'three';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const radians = degrees => degrees * Math.PI / 180;

export const HAND_FINGERS = {
  Thumb: { indices: [1, 2, 3, 4], joints: ['Metacarpal', 'Proximal', 'Distal'] },
  Index: { indices: [5, 6, 7, 8], joints: ['Proximal', 'Intermediate', 'Distal'] },
  Middle: { indices: [9, 10, 11, 12], joints: ['Proximal', 'Intermediate', 'Distal'] },
  Ring: { indices: [13, 14, 15, 16], joints: ['Proximal', 'Intermediate', 'Distal'] },
  Little: { indices: [17, 18, 19, 20], joints: ['Proximal', 'Intermediate', 'Distal'] },
};

function point(value) {
  return value && [value.x, value.y, value.z].every(Number.isFinite)
    ? new Vector3(value.x, -value.y, -value.z) : null;
}

function frame(across, forward) {
  if (!across || !forward || across.lengthSq() < 1e-12 || forward.lengthSq() < 1e-12) return null;
  const x = across.clone().normalize();
  const y = forward.clone().addScaledVector(x, -forward.dot(x));
  if (y.length() < forward.length() * 0.15) return null;
  y.normalize();
  const z = x.clone().cross(y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

// A finger has a stable hinge, even when its direction becomes opposite to its
// bind direction. There is no shortest-arc world rotation or live-parent input.
function fingerFrame(splay, curl, ventral) {
  return new Quaternion().setFromAxisAngle(Z, -splay)
    .multiply(new Quaternion().setFromAxisAngle(X, ventral * curl));
}

function thumbFrame(direction) {
  const radial = Math.hypot(direction.x, direction.y);
  const azimuth = Math.atan2(direction.y, direction.x);
  const elevation = Math.atan2(direction.z, radial);
  return new Quaternion().setFromAxisAngle(Z, azimuth)
    .multiply(new Quaternion().setFromAxisAngle(Y, -elevation))
    .multiply(new Quaternion().setFromAxisAngle(Z, -Math.PI / 2));
}

function segment(points, from, to) {
  if (!points[from] || !points[to]) return null;
  const value = points[to].clone().sub(points[from]);
  return value.lengthSq() > 1e-12 ? value.normalize() : null;
}

function signedBend(from, to, hinge, ventral) {
  // Project away lateral landmark noise. Taking acos(dot) alone mistakes a
  // sideways spread for a curl and cannot distinguish extension from flexion.
  const a = from.clone().addScaledVector(hinge, -from.dot(hinge));
  const b = to.clone().addScaledVector(hinge, -to.dot(hinge));
  if (a.lengthSq() < 1e-6 || b.lengthSq() < 1e-6) return null;
  a.normalize();
  b.normalize();
  return Math.atan2(ventral * hinge.dot(a.clone().cross(b)), clamp(a.dot(b), -1, 1));
}

/**
 * HandLandmarker world landmarks are metric, hand-centred geometry, not body
 * positions. Use them only for this rotation/shape measurement. The caller
 * assigns anatomical sides and places the wrist using image/pose observations.
 * https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
 * All returned finger quantities are invariant under rigid hand rotation.
 */
export function measureHand(worldLandmarks, side) {
  if (!['left', 'right'].includes(side) || !worldLandmarks) return null;
  const points = Array.from({ length: 21 }, (_, index) => point(worldLandmarks[index]));
  if (![0, 5, 9, 17].every(index => points[index])) return null;
  const palm = frame(points[5].clone().sub(points[17]), points[9].clone().sub(points[0]));
  if (!palm) return null;
  const inverse = palm.clone().invert();
  const local = points.map(value => value?.clone().sub(points[0]).applyQuaternion(inverse));
  // With x pointing little→index, x×y faces the palm on the right hand and
  // the dorsum on the left. This sign is anatomical, independent of mirroring.
  const ventral = side === 'right' ? 1 : -1;
  const fingers = {};
  for (const [name, { indices }] of Object.entries(HAND_FINGERS)) {
    const directions = indices.slice(0, 3).map((index, joint) => segment(local, index, indices[joint + 1]));
    if (directions.some(value => !value)) continue;
    if (name === 'Thumb') {
      // The CMC is a saddle joint. Preserve abduction and opposition in 3D;
      // treating the thumb as another planar index finger loses pinch gestures.
      fingers[name] = { directions };
      continue;
    }
    const proximal = directions[0];
    // Finger spread is unobservable when the proximal segment points straight
    // out of the palm. Taper it smoothly before that pole instead of allowing
    // tiny x/y noise to flip a nearly closed finger from side to side.
    const planarLength = Math.hypot(proximal.x, proximal.y);
    const splayWeight = clamp((planarLength - 0.08) / 0.22, 0, 1);
    const splay = clamp(Math.atan2(proximal.x, Math.max(0.001, proximal.y)), -radians(40), radians(40)) * splayWeight;
    const hinge = new Vector3(Math.cos(splay), -Math.sin(splay), 0);
    const forward = new Vector3(Math.sin(splay), Math.cos(splay), 0);
    const curl = [clamp(Math.atan2(ventral * proximal.z, proximal.dot(forward)), -radians(12), radians(95))];
    const pip = signedBend(directions[0], directions[1], hinge, ventral);
    const dip = signedBend(directions[1], directions[2], hinge, ventral);
    if (pip === null || dip === null) continue;
    curl.push(clamp(pip, -radians(5), radians(120)), clamp(dip, -radians(5), radians(95)));
    fingers[name] = { curl, splay };
  }
  return { side, palm, fingers };
}

function bindFrame(direction, proximalDirection) {
  const splay = Math.atan2(proximalDirection.x, proximalDirection.y);
  const hinge = new Vector3(Math.cos(splay), -Math.sin(splay), 0);
  const y = direction.clone().normalize();
  const x = hinge.addScaledVector(y, -hinge.dot(y)).normalize();
  if (x.lengthSq() < 0.5) return null;
  const z = x.clone().cross(y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize();
}

/**
 * Captures bone axes once; solve() never reads an animated bone. The caller
 * applies wristWorld in world space, then rotations in LOCAL space with its
 * usual smoothing/hold/release policy. VRM 1's thumb is Metacarpal→Proximal→Distal.
 */
export class HandRetargeter {
  constructor(bones) {
    this.hands = {};
    this.availableFingers = {};
    for (const side of ['left', 'right']) {
      const wrist = bones[`${side}Hand`];
      this.availableFingers[side] = {};
      for (const [finger, { joints }] of Object.entries(HAND_FINGERS)) {
        this.availableFingers[side][finger] = joints.filter(joint => bones[`${side}${finger}${joint}`]).length;
      }
      if (!wrist) continue;
      wrist.updateWorldMatrix(true, true);
      const wristWorld = wrist.getWorldQuaternion(new Quaternion());
      const position = wrist.getWorldPosition(new Vector3());
      const proximal = Object.fromEntries(Object.entries(HAND_FINGERS).map(([finger, { joints }]) => [
        finger, bones[`${side}${finger}${joints[0]}`]?.getWorldPosition(new Vector3()),
      ]));
      const span = proximal.Index && proximal.Little ? proximal.Index.clone().sub(proximal.Little)
        : proximal.Index && proximal.Ring ? proximal.Index.clone().sub(proximal.Ring)
          : proximal.Middle && proximal.Little ? proximal.Middle.clone().sub(proximal.Little) : null;
      const forward = proximal.Middle ?? (proximal.Index && proximal.Ring ? proximal.Index.clone().add(proximal.Ring).multiplyScalar(0.5) : null);
      const palm = frame(span, forward?.clone().sub(position));
      if (!palm) continue;
      const palmInverse = palm.clone().invert();
      const entries = new Map();
      const nodeNames = new Map([[wrist, `${side}Hand`]]);
      for (const [finger, { joints }] of Object.entries(HAND_FINGERS)) {
        for (let index = 0; index < joints.length; index++) {
          const name = `${side}${finger}${joints[index]}`;
          const bone = bones[name];
          if (!bone) continue;
          bone.updateWorldMatrix(true, true);
          const world = bone.getWorldQuaternion(new Quaternion());
          const location = bone.getWorldPosition(new Vector3());
          const next = bones[`${side}${finger}${joints[index + 1]}`]
            ?? bone.children.find(child => child.position.lengthSq() > 1e-12);
          const previous = bones[`${side}${finger}${joints[index - 1]}`];
          let direction = next?.getWorldPosition(new Vector3()).sub(location);
          if (!direction && previous) direction = location.clone().sub(previous.getWorldPosition(new Vector3()));
          if (!direction || direction.lengthSq() < 1e-12) continue;
          direction.normalize().applyQuaternion(palmInverse);
          entries.set(name, {
            name, finger, index, bone, world, direction,
            parentWorld: bone.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion(),
          });
          nodeNames.set(bone, name);
        }
      }
      for (const entry of entries.values()) {
        const first = entries.get(`${side}${entry.finger}${HAND_FINGERS[entry.finger].joints[0]}`) ?? entry;
        const jointFrame = entry.finger === 'Thumb' ? thumbFrame(entry.direction) : bindFrame(entry.direction, first.direction);
        if (!jointFrame) continue;
        entry.offset = palm.clone().multiply(jointFrame).invert().multiply(entry.world);
        let ancestor = entry.bone.parent;
        while (ancestor && !nodeNames.has(ancestor)) ancestor = ancestor.parent;
        entry.ancestor = nodeNames.get(ancestor) ?? `${side}Hand`;
        const ancestorWorld = entry.ancestor === `${side}Hand` ? wristWorld : entries.get(entry.ancestor)?.world;
        entry.parentOffset = (ancestorWorld ?? wristWorld).clone().invert().multiply(entry.parentWorld);
        // No scene graph references are needed during solving.
        delete entry.bone;
      }
      this.hands[side] = { entries, wristWorld, palmInverse };
    }
  }

  solve(measurement) {
    const rotations = new Map();
    const side = measurement?.side;
    const hand = this.hands[side];
    if (!hand || !measurement?.palm || !measurement.palm.toArray().every(Number.isFinite)) return { wristWorld: null, rotations };
    const wristWorld = measurement.palm.clone().multiply(hand.palmInverse).multiply(hand.wristWorld).normalize();
    const desiredWorlds = new Map([[`${side}Hand`, wristWorld]]);
    const ventral = side === 'right' ? 1 : -1;
    for (const entry of hand.entries.values()) {
      const values = measurement.fingers?.[entry.finger];
      if (!values || !entry.offset) continue;
      let targetFrame;
      if (entry.finger === 'Thumb') {
        const direction = values.directions?.[entry.index];
        if (!direction || !direction.toArray().every(Number.isFinite) || direction.lengthSq() < 1e-8) continue;
        targetFrame = thumbFrame(direction);
      } else {
        if (!Number.isFinite(values.splay) || values.curl?.length !== 3 || !values.curl.every(Number.isFinite)) continue;
        const totalCurl = values.curl.slice(0, entry.index + 1).reduce((sum, value) => sum + value, 0);
        targetFrame = fingerFrame(values.splay, totalCurl, ventral);
      }
      const desired = measurement.palm.clone().multiply(targetFrame).multiply(entry.offset).normalize();
      const ancestor = desiredWorlds.get(entry.ancestor);
      // If an optional ancestor is missing from the measurement, hold that
      // chain rather than solving a child relative to an invented parent.
      if (!ancestor) continue;
      const parent = ancestor.clone().multiply(entry.parentOffset);
      rotations.set(entry.name, parent.invert().multiply(desired).normalize());
      desiredWorlds.set(entry.name, desired);
    }
    return { wristWorld, rotations };
  }
}
