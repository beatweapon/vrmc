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

    // 全部位のblendshape計算をまとめて行う
    const blendshapeData = this.calculateBlendshapes(landmarks);

    // vrmへの適用を一括で行う
    this.applyBlendshapes(blendshapeData);
  }

  // 全部位のblendshape計算を行う
  calculateBlendshapes(landmarks) {
    // 頭の回転クォータニオン
    const baseRotationQuat = this.computeHeadRotation(landmarks);

    // blendshapes（表情係数）
    let coefsMap = new Map();
    if (landmarks.faceBlendshapes?.length) {
      coefsMap = this.retarget(landmarks.faceBlendshapes);
    }

    const eye = this.computedEye(coefsMap);

    const blink = this.computedBlink(coefsMap);

    const mouth = this.computedMouth(landmarks, coefsMap);

    const facial = this.computedFacial(coefsMap);

    return {
      baseRotationQuat,
      eye,
      blink,
      mouth,
      facial,
    };
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
    if (!transformationMatrices?.length)
      return { spineRotationQuat: null, neckRotationQuat: null };

    const matrix = new THREE.Matrix4().fromArray(
      transformationMatrices[0].data,
    );
    const originalQuaternion = new THREE.Quaternion().setFromRotationMatrix(
      matrix,
    );

    const baseRotationQuat = new THREE.Quaternion(
      originalQuaternion.x > 0
        ? originalQuaternion.x
        : originalQuaternion.x * 0.3,
      -originalQuaternion.y * 0.5,
      -originalQuaternion.z,
      originalQuaternion.w,
    );

    return baseRotationQuat;
  }

  computedBlink(blendshapes) {
    return Math.max(
      blendshapes.get("eyeBlinkLeft"),
      blendshapes.get("eyeBlinkRight"),
    );
  }

  computedEye(blendshapes) {
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

    return { rotX, rotY };
  }

  computedMouth(landmarks, coefsMap) {
    // 口の開閉量
    let mouthOpen = 0;
    if (landmarks.faceLandmarks?.[0]) {
      const UPPER_LIP_BOTTOM_INDEX = 13;
      const UNDER_LIP_TOP_INDEX = 14;
      mouthOpen =
        (landmarks.faceLandmarks[0][UPPER_LIP_BOTTOM_INDEX].y -
          landmarks.faceLandmarks[0][UNDER_LIP_TOP_INDEX].y) *
        -1;
    }

    // mouthPucker, mouthFunnel
    const mouthPucker = coefsMap.get("mouthPucker") || 0;
    const mouthFunnel = coefsMap.get("mouthFunnel") || 0;

    // 計算結果をmouthオブジェクトに格納
    const mouth = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    mouth.aa = mouthOpen * 15;
    mouth.ou = (mouthPucker - 0.5) * 2 > 0 ? (mouthPucker - 0.5) * 2 : 0;
    mouth.oh = mouthFunnel > 0.2 ? mouthFunnel : 0;

    // 口の形(ou/oh)が大きい場合はaaを減衰させる（相互抑制）
    const aaMax = 1.0;
    const ouMax = 0.8;
    const ohMax = 0.8;
    mouth.ou = Math.min(mouth.ou, ouMax);
    mouth.oh = Math.min(mouth.oh, ohMax);
    // ou, ohの合計が大きい場合、aaを減衰
    const shapeSum = mouth.ou + mouth.oh;
    if (shapeSum > 0.5) {
      mouth.aa = Math.min(mouth.aa, Math.max(0, 1.0 - shapeSum));
    } else {
      mouth.aa = Math.min(mouth.aa, aaMax);
    }

    return mouth;
  }

  computedFacial(blendshapes) {
    const browInnerUp = blendshapes.get("browInnerUp");
    const mouthSmileRight = blendshapes.get("mouthSmileRight");
    const mouthSmileLeft = blendshapes.get("mouthSmileLeft");

    return {
      browInnerUp,
      mouthSmileRight,
      mouthSmileLeft,
    };
  }

  // vrmへの適用を一括で行う
  applyBlendshapes({ baseRotationQuat, eye, blink, mouth, facial }) {
    // 首・頭回転を適用
    this.updateHeadRotation(baseRotationQuat);

    // 目の動き
    this.updateEye(eye);

    // 瞬き
    this.updateBlink(blink);

    // 口の動き
    // mouthオブジェクトを受け取る形に変更
    this.updateMouth(mouth);

    // 顔全体の表情
    this.updateFacial(facial);
  }

  updateHeadRotation(baseRotationQuat) {
    if (!this.vrm || !baseRotationQuat) return;

    const adjustQuaternionAngleRatio = (quaternion, ratio) => {
      return new THREE.Quaternion(
        quaternion.x * ratio,
        quaternion.y * ratio,
        quaternion.z * ratio,
        quaternion.w,
      );
    };

    const spineBone = this.vrm.humanoid.getNormalizedBoneNode("spine");
    const chestBone = this.vrm.humanoid.getNormalizedBoneNode("chest");
    const upperChestBone =
      this.vrm.humanoid.getNormalizedBoneNode("upperChest");
    const neckBone = this.vrm.humanoid.getNormalizedBoneNode("neck");
    const headBone = this.vrm.humanoid.getNormalizedBoneNode("head");

    const segments = 5; // spine, chest, upperChest, neck, head
    const distributedQuats = [];

    for (let i = 1; i <= segments; i++) {
      const q = new THREE.Quaternion().slerpQuaternions(
        new THREE.Quaternion(), // identity
        baseRotationQuat, // full target rotation
        i / segments, // i段階目までの累積回転
      );
      distributedQuats.push(q);
    }

    const slerpFactor = 0.5; // 各ボーンの回転を補間する係数

    spineBone.quaternion.slerp(distributedQuats[0], slerpFactor);
    chestBone.quaternion.slerp(distributedQuats[1], slerpFactor);
    upperChestBone.quaternion.slerp(distributedQuats[2], slerpFactor);
    neckBone.quaternion.slerp(distributedQuats[3], slerpFactor);
    headBone.quaternion.slerp(distributedQuats[4], slerpFactor);
  }

  updateEye({ rotX, rotY }) {
    if (!this.leftIris || !this.rightIris) return;

    // 虹彩に直接適用
    this.leftIris.rotation.set(rotX, rotY, 0);
    this.rightIris.rotation.set(rotX, rotY, 0);
  }

  updateBlink(blink) {
    if (!this.vrm) return;
    this.vrm.expressionManager.setValue("blinkLeft", (blink - 0.5) * 2);
    this.vrm.expressionManager.setValue("blinkRight", (blink - 0.5) * 2);
  }

  // 口の動き（口の開閉量を直接渡す）
  updateMouth(mouth) {
    if (!this.vrm) return;
    this.vrm.expressionManager.setValue("aa", mouth.aa);
    this.vrm.expressionManager.setValue("ih", mouth.ih);
    this.vrm.expressionManager.setValue("ou", mouth.ou);
    this.vrm.expressionManager.setValue("oh", mouth.oh);
  }

  updateFacial({ browInnerUp, mouthSmileRight, mouthSmileLeft }) {
    if (!this.vrm) return;
    this.vrm.expressionManager.setValue("neutral", 0);

    this.vrm.expressionManager.setValue(
      "surprised",
      browInnerUp > 0.7 ? browInnerUp : 0,
    );

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
          this.vrm.expressionManager.getValue("ih"),
          this.vrm.expressionManager.getValue("ee"),
          this.vrm.expressionManager.getValue("ou"),
          this.vrm.expressionManager.getValue("oh"),
        ),
    );
  }
}
