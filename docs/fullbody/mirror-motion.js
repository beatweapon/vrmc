// Mirror observations after tracking identity and personal calibration, before
// retargeting. The avatar's skeleton, proportions, mesh and textures stay intact.
// Pose indices: https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
const POSE_SIDES = [0, 4, 5, 6, 1, 2, 3, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15,
  18, 17, 20, 19, 22, 21, 24, 23, 26, 25, 28, 27, 30, 29, 32, 31];
const otherSide = side => ({ left: 'right', right: 'left', Left: 'Right', Right: 'Left' })[side] ?? side;
const imagePoint = point => point ? { ...point, x: 1 - point.x } : point;
const worldPoint = point => point ? { ...point, x: -point.x } : point;

function mirrorPose(pose) {
  if (!pose) return pose;
  const reflect = (lists, point) => lists?.map(points => points.map((_, index) =>
    point(points[POSE_SIDES[index] ?? index])));
  return { ...pose, landmarks: reflect(pose.landmarks, imagePoint),
    worldLandmarks: reflect(pose.worldLandmarks, worldPoint) };
}

function mirrorHands(hands) {
  if (!hands) return hands;
  const reflect = (lists, point) => lists?.map(points => points.map(point));
  const categories = lists => lists?.map(list => list.map(category => ({ ...category,
    categoryName: otherSide(category.categoryName),
    ...(category.displayName ? { displayName: otherSide(category.displayName) } : {}),
    ...([0, 1].includes(category.index) ? { index: 1 - category.index } : {}),
  })));
  return { ...hands,
    landmarks: reflect(hands.landmarks, imagePoint),
    worldLandmarks: reflect(hands.worldLandmarks, worldPoint),
    handedness: categories(hands.handedness), handednesses: categories(hands.handednesses),
    trackingIds: hands.trackingIds?.map(otherSide),
    releasedSides: hands.releasedSides?.map(otherSide),
    pendingSides: hands.pendingSides?.map(otherSide),
    // Physical IDs refer to the observed person, so they must not be reassigned.
  };
}

export function mirrorBodyInput(pose, hands, faceLandmarks) {
  return {
    pose: mirrorPose(pose), hands: mirrorHands(hands),
    // These face points are used only for image anchors (eye midpoint/span),
    // never fed back into facial measurements or left/right eye calibration.
    faceLandmarks: faceLandmarks?.map(imagePoint),
  };
}

export function mirrorFaceMotion(face) {
  if (!face) return face;
  const result = { ...face };
  // Reflection across X: R' = S R S. Quaternion axial components become
  // (x, -y, -z, w), preserving nods while reversing yaw and lateral tilt.
  if (face.head?.length === 4) result.head = [face.head[0], -face.head[1], -face.head[2], face.head[3]];
  if (face.headTarget?.length === 4) result.headTarget = [face.headTarget[0], -face.headTarget[1], -face.headTarget[2], face.headTarget[3]];
  if (face.gaze) result.gaze = { ...face.gaze, yaw: -face.gaze.yaw };
  if (face.expressions) result.expressions = { ...face.expressions,
    blinkLeft: face.expressions.blinkRight, blinkRight: face.expressions.blinkLeft };
  return result;
}
