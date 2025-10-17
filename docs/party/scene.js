import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

let scene, clock, camera, renderer;
// Smaller frustum gives a closer "bust-up" framing for the avatar
const FRUSTUM_SIZE = 0.8;
// default focus (where the camera looks at) and how much higher the camera sits above it
const DEFAULT_FOCUS_Y = 1.5;
const CAMERA_OFFSET_Y = 0; // camera.y = focusY + CAMERA_OFFSET_Y

export const initScene = () => {
  scene = new THREE.Scene();
  clock = new THREE.Clock();
  const aspect = window.innerWidth / window.innerHeight;
  const halfHeight = FRUSTUM_SIZE / 2;
  const halfWidth = halfHeight * aspect;
  camera = new THREE.OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    0.1,
    20,
  );
  // move camera closer on Z and raise it to show chest-up (higher vantage)
  camera.position.set(0, DEFAULT_FOCUS_Y + CAMERA_OFFSET_Y, 1.0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // camera controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.screenSpacePanning = true;
  // initial target slightly lower than camera to show chest and head
  controls.target.set(0.0, DEFAULT_FOCUS_Y, 0.0);
  controls.update();

  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));

  return { scene, clock, camera, renderer };
};

export const resize = () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = width / height;
  const halfHeight = FRUSTUM_SIZE / 2;
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  renderer.render(scene, camera);
};

export const setBackgroundColor = async (color) => {
  scene.background = new THREE.Color(color);
};
