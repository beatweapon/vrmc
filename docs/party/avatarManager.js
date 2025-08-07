import { VRMAvatar } from "./vrmAvatar.js";
import { createIndexedDB } from "./indexedDB.js";

const DB_NAME = "vrmc";
const STORE_NAME = "vrm";
const db = createIndexedDB(DB_NAME, STORE_NAME);

const DEFAULT_MODEL_URL = "../models/VRM1_Constraint_Twist_Sample.vrm";
export const avatars = {};

export const loadAvatar = async (userId, scene) => {
  const position = { x: 0, y: 0, z: 0 };
  const model = await db.loadData(userId);
  const url = model
    ? URL.createObjectURL(new Blob([model]))
    : DEFAULT_MODEL_URL;

  avatars[userId] = new VRMAvatar(url, scene, position);
};

export const updateBlendshape = (userId, landmarks) => {
  if (avatars[userId]) {
    avatars[userId].updateBlendshapes(landmarks);
  }
};

export const updateAvatars = (delta) => {
  Object.values(avatars).forEach((avatar) => {
    if (avatar.vrm) avatar.vrm.update(delta);
  });
};

export const changeAvatar = async (userId, arrayBuffer) => {
  if (avatars[userId]) {
    const blob = new Blob([arrayBuffer], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);

    avatars[userId].changeModel(url);
    await db.saveData(userId, arrayBuffer);
  }
};
