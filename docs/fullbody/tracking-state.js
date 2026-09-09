// Filter observations once, at camera sample time, before retargeting them.
// Casiez, Roussel & Vogel, CHI 2012: https://gery.casiez.net/1euro/
// A shared speed-dependent cutoff per vector preserves the direction of motion.
const AXES = ['x', 'y', 'z'];
const SIDES = ['Left', 'Right'];
const finitePoint = p => p && AXES.every(axis => Number.isFinite(p[axis]));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const imageDistanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
const vector = p => ({ x: p.x, y: p.y, z: p.z });

class AdaptiveVector {
  constructor({ minCutoff = 1.5, beta = 5, maxJump = 0.2, maxSpeed = 2, resetAfter = 0.65 } = {}) {
    Object.assign(this, { minCutoff, beta, maxJump, maxSpeed, resetAfter });
    this.time = -Infinity;
    this.pending = null;
  }

  update(point, time) {
    if (!this.raw || time - this.time > this.resetAfter) {
      this.raw = vector(point);
      this.value = vector(point);
      this.velocity = { x: 0, y: 0, z: 0 };
      this.pending = null;
      this.time = time;
      return vector(this.value);
    }
    if (time <= this.time) return vector(this.value);
    const dt = time - this.time;
    const jump = this.maxJump + this.maxSpeed * dt;
    // Hold a single implausible spike. A second consistent observation accepts
    // a real relocation; prolonged loss resets history instead of dragging it.
    if (distance(point, this.raw) > jump &&
        (!this.pending || distance(point, this.pending) > jump)) {
      this.pending = vector(point);
      return vector(this.value);
    }
    this.pending = null;
    const derivativeAlpha = alpha(1, dt);
    for (const axis of AXES) {
      const speed = (point[axis] - this.raw[axis]) / dt;
      this.velocity[axis] += derivativeAlpha * (speed - this.velocity[axis]);
    }
    const cutoff = this.minCutoff + this.beta * Math.hypot(...AXES.map(axis => this.velocity[axis]));
    const amount = alpha(cutoff, dt);
    for (const axis of AXES) this.value[axis] += amount * (point[axis] - this.value[axis]);
    this.raw = vector(point);
    this.time = time;
    return vector(this.value);
  }
}

class LandmarkFilter {
  constructor({ respectConfidence = true, ...options }) {
    this.options = options;
    this.respectConfidence = respectConfidence;
    this.points = new Map();
  }

  update(points, time) {
    if (!Array.isArray(points)) return [];
    return points.map((point, index) => {
      let filter = this.points.get(index);
      if (!finitePoint(point)) {
        // A finite placeholder with zero confidence cannot poison the solver.
        // Invalid measurements never become filter history.
        return { ...point, ...(filter?.value ?? { x: 0, y: 0, z: 0 }), visibility: 0, presence: 0 };
      }
      if (this.respectConfidence && ((point.visibility ?? 1) < 0.1 || (point.presence ?? 1) < 0.1)) return { ...point };
      if (!filter) this.points.set(index, filter = new AdaptiveVector(this.options));
      return { ...point, ...filter.update(point, time) };
    });
  }
}

function centeredHand(points, time, origin, offsets) {
  if (!Array.isArray(points) || points.length !== 21 || !points.every(finitePoint)) return [];
  const wrist = points[0];
  const filteredWrist = origin.update(wrist, time);
  // Filter articulation independently of the wrist translation. Otherwise a
  // moving hand's fingertips lag by different amounts and change its shape.
  const local = offsets.update(points.map(p => ({
    ...p, x: p.x - wrist.x, y: p.y - wrist.y, z: p.z - wrist.z,
  })), time);
  return local.map(p => ({
    ...p, x: p.x + filteredWrist.x, y: p.y + filteredWrist.y, z: p.z + filteredWrist.z,
  }));
}

function handCategory(hands, index) {
  const category = (hands.handedness ?? hands.handednesses)?.[index]?.[0] ?? {};
  const name = category.categoryName ?? category.displayName ?? '';
  const label = SIDES.find(side => side.toLowerCase() === String(name).toLowerCase());
  const confidence = Number.isFinite(category.score) ? Math.max(0, Math.min(1, category.score)) : 0.5;
  return { ...category, label, confidence };
}

function handSize(points) {
  return Math.max(0.025,
    Math.sqrt(imageDistanceSquared(points[0], points[9])),
    Math.sqrt(imageDistanceSquared(points[5], points[17])));
}

function duplicateHands(first, second) {
  // A shared wrist is normal when crossing hands. Only suppress observations
  // whose corresponding joints all describe virtually the same image hand.
  const tolerance = Math.min(0.008, Math.max(0.002, Math.min(handSize(first.points), handSize(second.points)) * 0.06));
  const distances = first.points.map((point, index) => imageDistanceSquared(point, second.points[index]));
  return distances[0] < tolerance ** 2 * 4 &&
    Math.max(...distances) < tolerance ** 2 * 6.25 &&
    distances.reduce((sum, value) => sum + value, 0) / 21 < tolerance ** 2;
}

function poseHandSide(observation, pose) {
  const points = pose?.landmarks?.[0];
  if (!points) return null;
  const wrist = observation.points[0];
  const candidates = SIDES.map((side, index) => ({ side, point: points[15 + index] }))
    .filter(({ point }) => finitePoint(point) && (point.visibility ?? 1) >= 0.75 &&
      (point.presence ?? 1) >= 0.7 && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
    .map(({ side, point }) => ({ side, distance: Math.sqrt(imageDistanceSquared(wrist, point)) }))
    .sort((a, b) => a.distance - b.distance);
  const closest = candidates[0];
  const radius = Math.min(0.1, Math.max(0.035, handSize(observation.points) * 0.65));
  // Pose's anatomical wrist is useful even with a hidden elbow. Shoulder order
  // and image left/right are deliberately irrelevant: hands may cross the body.
  // Ambiguous overlapping Pose wrists must leave identity to temporal tracking.
  if (!closest || closest.distance > radius ||
      (candidates[1] && candidates[1].distance - closest.distance < Math.max(0.025, radius * 0.4))) return null;
  return closest.side;
}

function newHandTrack() {
  return {
    seenAt: -Infinity, wrist: null, velocity: { x: 0, y: 0 }, id: null,
    identityConflict: null,
    imageOrigin: new AdaptiveVector({ minCutoff: 1.5, beta: 7, maxJump: 0.2 }),
    // Native Hand landmarks carry a default visibility:0. It is not a measured
    // score; rejecting it would bypass all finger smoothing on real cameras.
    imageOffsets: new LandmarkFilter({ respectConfidence: false, minCutoff: 2.5, beta: 16, maxJump: 0.08, maxSpeed: 0.8 }),
    worldOrigin: new AdaptiveVector({ minCutoff: 2.5, beta: 8, maxJump: 0.2 }),
    worldOffsets: new LandmarkFilter({ respectConfidence: false, minCutoff: 2.5, beta: 18, maxJump: 0.1, maxSpeed: 1 }),
  };
}

/**
 * Owns temporal state for one camera session. Call reset() on camera restart.
 *
 * update(nativeResults, receivedAtSeconds) returns an immutable-by-convention
 * snapshot: face is the original MediaPipe result (including matrices and
 * blendshapes); pose and hands are new objects with filtered landmarks. All
 * times are seconds in the performance.now() clock. `time` is receipt freshness;
 * `captureTime` / `sampleTime` preserve the native `results.time`. `sequence`
 * increases only for a new capture. Duplicate or older captures return the
 * previous snapshot without refreshing it or applying any filter a second time.
 *
 * Hands appear only when observed. Their arrays are ordered Left then Right,
 * with canonical handedness labels and matching trackingIds. Recent identity
 * history survives short occlusions, but absent hands are never fabricated.
 * FaceSolver should continue to handle expression/head smoothing itself.
 */
export class TrackingState {
  constructor({ identityTtl = 0.8 } = {}) {
    this.identityTtl = identityTtl;
    this.reset();
  }

  reset() {
    this.captureTime = -Infinity;
    this.sequence = 0;
    this.nextHandId = 1;
    this.frame = null;
    this.poseImage = new LandmarkFilter({ minCutoff: 1.5, beta: 5, maxJump: 0.2 });
    this.poseWorld = new LandmarkFilter({ minCutoff: 1.5, beta: 5, maxJump: 0.35, maxSpeed: 3 });
    this.tracks = Object.fromEntries(SIDES.map(side => [side, newHandTrack()]));
  }

  update(results = {}, receivedAtSeconds = results.time) {
    const receivedAt = Number.isFinite(receivedAtSeconds) ? receivedAtSeconds : 0;
    const captureTime = Number.isFinite(results.time) ? results.time : receivedAt;
    if (this.frame && captureTime <= this.captureTime) return this.frame;
    const previousCaptureTime = this.captureTime;
    this.captureTime = captureTime;
    const pose = results.pose ? {
      ...results.pose,
      landmarks: (results.pose.landmarks ?? []).slice(0, 1).map(p => this.poseImage.update(p, captureTime)),
      worldLandmarks: (results.pose.worldLandmarks ?? []).slice(0, 1).map(p => this.poseWorld.update(p, captureTime)),
    } : null;
    const hands = this.updateHands(results.hands, captureTime, receivedAt, previousCaptureTime, results.pose);
    this.frame = {
      ...results, pose, hands, captureTime, sampleTime: captureTime,
      time: receivedAt, receivedAt, latencyMs: Math.max(0, (receivedAt - captureTime) * 1000),
      sequence: ++this.sequence,
    };
    return this.frame;
  }

  updateHands(hands, time, receivedAt, previousCaptureTime, pose) {
    for (const side of SIDES) {
      const track = this.tracks[side];
      // Slow sequential inference is not an observed occlusion. Preserve a
      // hand seen in the preceding sample even when each inference takes 1 s.
      const missedSample = track.seenAt < previousCaptureTime;
      const stalled = time - previousCaptureTime > 2;
      if (time - track.seenAt > this.identityTtl && (missedSample || stalled)) this.tracks[side] = newHandTrack();
    }
    if (!hands) {
      for (const track of Object.values(this.tracks)) track.identityConflict = null;
      return null;
    }
    let observations = (hands.landmarks ?? []).map((points, index) => ({
      points, world: hands.worldLandmarks?.[index], category: handCategory(hands, index), index,
    })).filter(observation => observation.points?.length === 21 && observation.points.every(finitePoint)).slice(0, 2);
    if (observations.length === 2 && duplicateHands(...observations)) {
      const reliability = observation => observation.category.confidence + SIDES.reduce((score, side) => {
        const track = this.tracks[side];
        return score + (track.wrist && side === observation.category.label &&
          imageDistanceSquared(track.wrist, observation.points[0]) < 0.01 ? 0.15 : 0);
      }, 0);
      observations = [observations[reliability(observations[1]) > reliability(observations[0]) ? 1 : 0]];
    }
    for (const observation of observations) observation.poseSide = poseHandSide(observation, pose);
    const assignments = observations.length === 2
      ? [[['Left', observations[0]], ['Right', observations[1]]], [['Left', observations[1]], ['Right', observations[0]]]]
      : observations.length ? [[['Left', observations[0]]], [['Right', observations[0]]]] : [[]];
    const cost = (side, observation) => {
      const track = this.tracks[side];
      const mismatch = observation.category.label && observation.category.label !== side;
      if (!track.wrist) return 0.12 + (mismatch ? observation.category.confidence : 0);
      const dt = Math.min(0.15, Math.max(0, time - track.seenAt));
      const predicted = {
        x: track.wrist.x + track.velocity.x * dt,
        y: track.wrist.y + track.velocity.y * dt,
      };
      // Continuity dominates a transient classifier flip; trajectory prediction
      // disambiguates a normal crossing without assuming left/right screen order.
      return imageDistanceSquared(observation.points[0], predicted) +
        (mismatch ? 0.0008 * observation.category.confidence : 0);
    };
    assignments.sort((a, b) =>
      a.reduce((total, [side, observation]) => total + cost(side, observation), 0) -
      b.reduce((total, [side, observation]) => total + cost(side, observation), 0));
    const temporalAssignment = assignments[0];
    // Continuity rejects a one-frame classifier flip, but must not permanently
    // lock in an incorrect first label. Correct only a sustained, confident
    // contradiction. A destination's stale history must not block correction:
    // alternating raised hands commonly reuse the same patch of the image.
    const contradicted = new Set();
    for (const [side, observation] of temporalAssignment) {
      const label = observation.category.label;
      const track = this.tracks[side];
      if (!observation.poseSide && track.wrist && label && label !== side && observation.category.confidence >= 0.9) {
        contradicted.add(track);
        const conflict = track.identityConflict?.label === label
          ? track.identityConflict : { label, count: 0, since: time };
        conflict.count++;
        track.identityConflict = conflict;
        const destination = this.tracks[label];
        const occupied = destination.wrist && time - destination.seenAt <= this.identityTtl;
        if (conflict.count >= 3 && time - conflict.since >= 0.5 && !occupied) observation.confirmedSide = label;
      }
    }
    for (const track of Object.values(this.tracks)) {
      if (!contradicted.has(track)) track.identityConflict = null;
    }

    const anatomicalCost = (side, observation) => cost(side, observation) +
      (observation.poseSide && observation.poseSide !== side ? 4 : 0) +
      (observation.confirmedSide && observation.confirmedSide !== side ? 2 : 0);
    assignments.sort((a, b) =>
      a.reduce((total, [side, observation]) => total + anatomicalCost(side, observation), 0) -
      b.reduce((total, [side, observation]) => total + anatomicalCost(side, observation), 0));
    const assignment = assignments[0];
    const previousTracks = { ...this.tracks };
    const releasedSides = [];
    for (const [side, observation] of assignment) {
      const formerSide = temporalAssignment.find(([, candidate]) => candidate === observation)?.[0];
      if (formerSide !== side) {
        this.tracks[side] = previousTracks[formerSide];
        this.tracks[side].identityConflict = null;
        releasedSides.push(formerSide.toLowerCase());
      }
    }
    for (const side of SIDES) {
      if (!assignment.some(([assigned]) => assigned === side) &&
          assignment.some(([assigned]) => this.tracks[assigned] === previousTracks[side])) this.tracks[side] = newHandTrack();
    }
    const output = {
      ...hands, landmarks: [], worldLandmarks: [], handedness: [], trackingIds: [], physicalTrackingIds: [],
      observedAt: [], releasedSides, identitiesStable: true,
    };
    for (const side of SIDES) {
      const observation = assignment.find(([assigned]) => assigned === side)?.[1];
      if (!observation) continue;
      const track = this.tracks[side];
      track.id ??= this.nextHandId++;
      const image = centeredHand(observation.points, time, track.imageOrigin, track.imageOffsets);
      const world = centeredHand(observation.world, time, track.worldOrigin, track.worldOffsets);
      // Identity follows accepted wrist observations, not noisy smoothed lag.
      const wrist = track.imageOrigin.raw;
      if (track.wrist && time > track.seenAt) {
        const dt = time - track.seenAt;
        for (const axis of ['x', 'y']) {
          const velocity = Math.max(-3, Math.min(3, (wrist[axis] - track.wrist[axis]) / dt));
          track.velocity[axis] = 0.65 * velocity + 0.35 * track.velocity[axis];
        }
      }
      track.wrist = vector(wrist);
      track.seenAt = time;
      const { label, confidence, ...category } = observation.category;
      output.landmarks.push(image);
      output.worldLandmarks.push(world);
      output.handedness.push([{ ...category, categoryName: side, displayName: side, score: confidence }]);
      output.trackingIds.push(side);
      output.physicalTrackingIds.push(track.id);
      output.observedAt.push(receivedAt);
    }
    // The Tasks API used both names across releases. Keep either reader aligned.
    output.handednesses = output.handedness;
    return output;
  }
}
