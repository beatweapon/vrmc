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
  avatarUIContainer.style.width = "100%";
  avatarUIContainer.style.top = "3rem";
  avatarUIContainer.style.zIndex = "10";
  avatarUIContainer.style.color = "white";
  avatarUIContainer.style.fontFamily = "sans-serif";
  document.body.appendChild(avatarUIContainer);
}

const avatarsUI = new Map(); // userId -> { wrapper, listeners }

// UI作成関数
const createAvatarUI = (userId) => {
  const knob = document.createElement("div");
  knob.dataset.userId = userId;
  knob.style.cursor = "grab";
  knob.style.width = "100px";
  knob.style.height = "100px";
  knob.style.display = "flex";
  knob.style.justifyContent = "center";
  knob.style.alignItems = "center";
  knob.style.border = "#fff solid 1px";
  knob.style.position = "absolute";
  knob.style.left =
    localStorage.getItem(`{positionX-${userId}}`) + "px" ||
    window.innerWidth / 2 + "px";
  knob.style.transform = "translateX(-50%)";
  knob.textContent = userId.slice(0, 6);

  avatarUIContainer.appendChild(knob);

  // ドラッグ動作
  let isDragging = false;
  let startX = 0;
  let startLeft = 0;

  const onMouseDown = (e) => {
    isDragging = true;
    knob.style.cursor = "grabbing";
    startX = e.clientX;
    startLeft = parseInt(knob.style.left);
    document.body.style.userSelect = "none";
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    let newLeft = startLeft + dx;
    if (newLeft < 0) newLeft = 0;
    if (newLeft > window.innerWidth) newLeft = window.innerWidth;
    knob.style.left = newLeft + "px";

    const normalized = (newLeft / window.innerWidth) * 4 - 2;
    if (avatars[userId] && avatars[userId].scene) {
      avatars[userId].vrm.scene.position.x = normalized * 0.5;
    }
  };

  const onMouseUp = () => {
    isDragging = false;
    document.body.style.userSelect = "";
    knob.style.cursor = "grab";
    const left = knob.style.left || window.innerWidth / 2;
    localStorage.setItem(`{positionX-${userId}}`, parseInt(left, 10));
  };

  knob.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);

  // リスナー管理用に保持
  avatarsUI.set(userId, {
    knob,
    listeners: [
      { target: knob, type: "mousedown", handler: onMouseDown },
      { target: window, type: "mousemove", handler: onMouseMove },
      { target: window, type: "mouseup", handler: onMouseUp },
    ],
  });
};

export const updateAvatarName = (userId, name) => {
  const ui = avatarsUI.get(userId);
  if (ui && ui.knob) {
    ui.knob.textContent = name;
  }
};

export const loadAvatar = async (userId, scene, position) => {
  createAvatarUI(userId);
  const model = await db.loadData(userId);
  const url = model
    ? URL.createObjectURL(new Blob([model]))
    : DEFAULT_MODEL_URL;

  const newLeft =
    localStorage.getItem(`{positionX-${userId}}`) || window.innerWidth / 2;
  console.log(`Loading avatar for ${userId} at position: ${newLeft}px`);
  const normalized = (newLeft / window.innerWidth) * 4 - 2;
  console.log(`Normalized position for ${userId}: ${window.innerWidth}`);
  console.log(`Normalized position for ${userId}: ${normalized}`);

  avatars[userId] = await new VRMAvatar(url, scene, {
    x: normalized * 0.5,
    y: 0,
    z: 0,
  });
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

    if (uiData.knob.parentNode) {
      uiData.knob.parentNode.removeChild(uiData.knob);
    }

    avatarsUI.delete(userId);
  }
};
