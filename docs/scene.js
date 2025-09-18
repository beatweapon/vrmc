import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

let scene, clock, camera, renderer;

export const initScene = () => {
  scene = new THREE.Scene();
  clock = new THREE.Clock();
  camera = new THREE.PerspectiveCamera(
    30,
    window.innerWidth / window.innerHeight,
    0.1,
    20,
  );
  camera.position.set(0, 1.4, 1.5);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  // camera controls
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.screenSpacePanning = true;
  controls.target.set(0.0, 1.5, 0.0);
  controls.update();

  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));

  return { scene, clock, camera, renderer };
};

export const resize = () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  renderer.render(scene, camera);
};

export const setBackgroundColor = async (color) => {
  scene.background = new THREE.Color(color);
};
