import { VRMAvatar } from "./vrmAvatar.js";
import { createIndexedDB } from "./indexedDB.js";

const DB_NAME = "vrmc";
const STORE_NAME = "vrm";
const db = createIndexedDB(DB_NAME, STORE_NAME);

const DEFAULT_MODEL_URL = "../models/VRM1_Constraint_Twist_Sample.vrm";
export const avatars = {};

// UIコンテナ作成（なければ追加）
let avatarUIContainer = document.getElementById("avatar-ui-container");
if (!avatarUIContainer) {
  avatarUIContainer = document.createElement("div");
  avatarUIContainer.id = "avatar-ui-container";
  avatarUIContainer.style.position = "fixed";
  avatarUIContainer.style.top = "10px";
  avatarUIContainer.style.left = "10px";
  avatarUIContainer.style.zIndex = "10";
  avatarUIContainer.style.color = "white";
  avatarUIContainer.style.fontFamily = "sans-serif";
  document.body.appendChild(avatarUIContainer);
}

const avatarsUI = new Map(); // userId -> { wrapper, listeners }

// UI作成関数
const createAvatarUI = (userId) => {
  const wrapper = document.createElement("div");
  wrapper.dataset.userId = userId;
  wrapper.style.marginBottom = "8px";

  const label = document.createElement("div");
  label.textContent = `Avatar: ${userId.slice(0, 6)}`;
  label.style.marginBottom = "4px";

  const bar = document.createElement("div");
  bar.style.width = "150px";
  bar.style.height = "20px";
  bar.style.background = "#333";
  bar.style.border = "1px solid #666";
  bar.style.position = "relative";

  const knob = document.createElement("div");
  knob.style.width = "20px";
  knob.style.height = "100%";
  knob.style.background = "#0f0";
  knob.style.position = "absolute";
  knob.style.left = "65px";

  bar.appendChild(knob);
  wrapper.appendChild(label);
  wrapper.appendChild(bar);
  avatarUIContainer.appendChild(wrapper);

  // ドラッグ動作
  let isDragging = false;
  let startX = 0;
  let startLeft = 0;

  const onMouseDown = (e) => {
    isDragging = true;
    startX = e.clientX;
    startLeft = parseInt(knob.style.left);
    document.body.style.userSelect = "none";
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    let newLeft = startLeft + dx;
    if (newLeft < 0) newLeft = 0;
    if (newLeft > 130) newLeft = 130;
    knob.style.left = newLeft + "px";

    const normalized = (newLeft / 130) * 4 - 2;
    if (avatars[userId] && avatars[userId].scene) {
      avatars[userId].vrm.scene.position.x = normalized;
    }
  };

  const onMouseUp = () => {
    isDragging = false;
    document.body.style.userSelect = "";
  };

  knob.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  // リスナー管理用に保持
  avatarsUI.set(userId, {
    wrapper,
    listeners: [
      { target: knob, type: "mousedown", handler: onMouseDown },
      { target: window, type: "mousemove", handler: onMouseMove },
      { target: window, type: "mouseup", handler: onMouseUp },
    ],
  });
};

export const loadAvatar = async (userId, scene, position) => {
  const model = await db.loadData(userId);
  const url = model
    ? URL.createObjectURL(new Blob([model]))
    : DEFAULT_MODEL_URL;

  avatars[userId] = new VRMAvatar(url, scene, position);

  createAvatarUI(userId);
};

export const existsOriginalAvatar = async (userId) => {
  return await db.existsKey(userId);
};

export const getModelArrayBuffer = async (userId) => {
  return await db.loadData(userId);
};

export const calculateBlendshapes = (userId, landmarks) => {
  if (avatars[userId]) {
    return avatars[userId].calculateBlendshapes(landmarks);
  }
};

export const updateBlendshape = (userId, blendshapeData) => {
  if (avatars[userId]) {
    avatars[userId].applyBlendshapes(blendshapeData);
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

export const destroyAvatar = (userId) => {
  if (avatars[userId]) {
    avatars[userId].destroyModel();
    delete avatars[userId];
  }

  // UI削除 & リスナー解除
  const uiData = avatarsUI.get(userId);
  if (uiData) {
    uiData.listeners.forEach(({ target, type, handler }) => {
      target.removeEventListener(type, handler);
    });

    if (uiData.wrapper.parentNode) {
      uiData.wrapper.parentNode.removeChild(uiData.wrapper);
    }

    avatarsUI.delete(userId);
  }
};
