import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  VRMLoaderPlugin,
  MToonMaterialLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import { MToonNodeMaterial } from "@pixiv/three-vrm/nodes";

export class VRMAvatar {
  constructor(url, scene, position) {
    this.scene = scene;
    this.vrm = null;
    this.headRotationQuat = null; // 頭回転の共通クォータニオン
    this.leftIris = null;
    this.rightIris = null;

    const onLoaded = (vrmAvatar) => {
      vrmAvatar.vrm.scene.position.set(position.x, position.y, position.z);
    };

    this.loadModel(url, onLoaded);
  }

  loadModel(url, onLoaded) {
    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => {
      const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, {
        materialType: MToonNodeMaterial,
      });
      return new VRMLoaderPlugin(parser, mtoonMaterialPlugin);
    });

    loader.load(
      url,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);

        vrm.scene.traverse((obj) => {
          obj.frustumCulled = false;
        });

        this.setupVrm(vrm);

        if (onLoaded) onLoaded(this);
      },
      undefined,
      (error) => {
        console.error(error);
      },
    );
  }

  async changeModel(url, onLoaded) {
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.loadModel(url, onLoaded);
  }

  setupVrm(vrm) {
    this.adjustArmsToIPose(vrm);

    // Iris ボーンを取得（無ければ眼球ボーンを使用）
    this.leftIris = this.findIrisBone(vrm, "leftEye");
    this.rightIris = this.findIrisBone(vrm, "rightEye");

    this.vrm = vrm;
    this.scene.add(vrm.scene);
  }

  findIrisBone(vrm, eyeName) {
    const eyeBone = vrm.humanoid.getNormalizedBoneNode(eyeName);
    if (!eyeBone) return null;

    let iris = null;
    eyeBone.traverse((child) => {
      const nameLower = child.name.toLowerCase();
      if (nameLower.includes("iris") || nameLower.includes("eye")) {
        iris = child;
      }
    });

    return iris || eyeBone;
  }

  adjustArmsToIPose(vrm) {
    const leftUpperArm = vrm.humanoid.getNormalizedBoneNode("leftUpperArm");
    const rightUpperArm = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    if (leftUpperArm) leftUpperArm.rotation.z = -Math.PI / 2.5;
    if (rightUpperArm) rightUpperArm.rotation.z = Math.PI / 2.5;
  }

  updateBlendshapes(landmarks) {
    if (!this.vrm) return;

    // 1. 頭回転の共通クォータニオンを計算
    this.computeHeadRotation(landmarks);

    // 2. 首回転を適用
    this.updateHeadRotation();

    // 3. 顔全体の表情を適用
    this.updateFace(landmarks);
  }

  retarget(blendshapes) {
    const categories = blendshapes[0].categories;
    let coefsMap = new Map();
    categories.forEach((blendshape) => {
      // Adjust certain blendshape values to be less prominent.
      switch (blendshape.categoryName) {
        case "eyeBlinkLeft":
        case "eyeBlinkRight":
          blendshape.score *= 1.2;
          break;
      }
      coefsMap.set(blendshape.categoryName, blendshape.score);
    });

    return coefsMap;
  }

  computeHeadRotation(landmarks) {
    const transformationMatrices = landmarks.facialTransformationMatrixes;
    if (!transformationMatrices?.length) return;

    const matrix = new THREE.Matrix4().fromArray(
      transformationMatrices[0].data,
    );
    const originalQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      matrix,
    );

    this.headRotationQuat = new THREE.Quaternion(
      originalQuaternion.x > 0
        ? originalQuaternion.x
        : originalQuaternion.x * 0.3,
      -originalQuaternion.y * 0.5,
      -originalQuaternion.z,
      originalQuaternion.w,
    );
  }

  updateHeadRotation() {
    if (!this.vrm || !this.headRotationQuat) return;

    const spineBone = this.vrm.humanoid.getNormalizedBoneNode("spine");
    const neckBone = this.vrm.humanoid.getNormalizedBoneNode("neck");

    const adjustQuaternionAngleRatio = (quaternion, ratio) => {
      return new THREE.Quaternion(
        quaternion.x * ratio,
        quaternion.y * ratio,
        quaternion.z * ratio,
        quaternion.w,
      );
    };

    spineBone.quaternion.slerp(
      adjustQuaternionAngleRatio(this.headRotationQuat, 0.6),
      0.3,
    );
    neckBone.quaternion
      .copy(spineBone.quaternion)
      .multiply(adjustQuaternionAngleRatio(this.headRotationQuat, 0.2));
  }

  updateFace(landmarks) {
    if (!this.vrm) return;

    const blendshapes = landmarks.faceBlendshapes;
    if (!blendshapes?.length) return;

    const coefsMap = this.retarget(blendshapes);

    this.updateBlink(coefsMap);
    this.updateEye(coefsMap);
    this.updateMouth(landmarks, coefsMap);
    this.updateFacial(coefsMap);
  }

  updateEye(blendshapes) {
    if (!this.leftIris || !this.rightIris) return;

    // Mediapipe視線の左右・上下成分（頭基準）
    const lookRight =
      ((blendshapes.get("eyeLookOutRight") || 0) -
        (blendshapes.get("eyeLookInRight") || 0) +
        (blendshapes.get("eyeLookInLeft") || 0) -
        (blendshapes.get("eyeLookOutLeft") || 0)) /
      2;

    const lookUp =
      ((blendshapes.get("eyeLookUpRight") || 0) -
        (blendshapes.get("eyeLookDownRight") || 0) +
        (blendshapes.get("eyeLookUpLeft") || 0) -
        (blendshapes.get("eyeLookDownLeft") || 0)) /
      2;

    // ★ 符号反転
    const invLookRight = -lookRight; // 左右反転
    const invLookUp = -lookUp; // 上下反転

    // スケーリング（動きすぎ防止）
    const scaleFactor = 0.7;

    // 上下・左右の最大角度（自然な可動範囲）
    const maxRotUp = THREE.MathUtils.degToRad(15);
    const maxRotDown = THREE.MathUtils.degToRad(12);
    const maxRotSide = THREE.MathUtils.degToRad(17);

    // clampして回転角に変換
    const upDown = THREE.MathUtils.clamp(invLookUp * scaleFactor, -1, 1);
    const rotX = upDown > 0 ? upDown * maxRotUp : upDown * maxRotDown;
    const rotY =
      -THREE.MathUtils.clamp(invLookRight * scaleFactor, -1, 1) * maxRotSide;

    // 虹彩に直接適用
    this.leftIris.rotation.set(rotX, rotY, 0);
    this.rightIris.rotation.set(rotX, rotY, 0);
  }

  updateBlink(blendshapes) {
    const blink = Math.max(
      blendshapes.get("eyeBlinkLeft"),
      blendshapes.get("eyeBlinkRight"),
    );
    this.vrm.expressionManager.setValue("blinkLeft", (blink - 0.5) * 2);
    this.vrm.expressionManager.setValue("blinkRight", (blink - 0.5) * 2);
  }

  updateMouth(landmarks, blendshapes) {
    const UPPER_LIP_BOTTOM_INDEX = 13;
    const UNDER_LIP_TOP_INDEX = 14;
    const mouthOpen =
      (landmarks.faceLandmarks[0][UPPER_LIP_BOTTOM_INDEX].y -
        landmarks.faceLandmarks[0][UNDER_LIP_TOP_INDEX].y) *
      -1;
    this.vrm.expressionManager.setValue("aa", mouthOpen * 20);

    const mouthPucker = blendshapes.get("mouthPucker");
    const ou = (mouthPucker - 0.5) * 2;
    this.vrm.expressionManager.setValue("ou", ou > 0 ? ou : 0);

    const mouthFunnel = blendshapes.get("mouthFunnel");
    this.vrm.expressionManager.setValue(
      "oh",
      mouthFunnel > 0.2 ? mouthFunnel : 0,
    );
  }

  updateFacial(blendshapes) {
    this.vrm.expressionManager.setValue("neutral", 0);

    const browInnerUp = blendshapes.get("browInnerUp");
    this.vrm.expressionManager.setValue(
      "surprised",
      browInnerUp > 0.7 ? browInnerUp : 0,
    );

    const mouthSmileRight = blendshapes.get("mouthSmileRight");
    const mouthSmileLeft = blendshapes.get("mouthSmileLeft");
    const happy = (mouthSmileRight || 0) + (mouthSmileLeft || 0) - 0.8;
    if (happy > 0) {
      this.vrm.expressionManager.setValue("blinkLeft", happy * 4);
      this.vrm.expressionManager.setValue("blinkRight", happy * 4);
      this.vrm.expressionManager.setValue("surprised", 0);
    } else {
      this.vrm.expressionManager.setValue("happy", 0);
    }

    this.vrm.expressionManager.setValue(
      "neutral",
      0.5 -
        Math.max(
          this.vrm.expressionManager.getValue("aa"),
          this.vrm.expressionManager.getValue("ee"),
          this.vrm.expressionManager.getValue("ou"),
          this.vrm.expressionManager.getValue("oh"),
        ),
    );
  }
}
