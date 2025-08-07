import * as THREE from "three";

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
  document.body.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, Math.PI));

  return { scene, clock, camera, renderer };
};
