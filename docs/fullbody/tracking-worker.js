import {
  FilesetResolver, HandLandmarker, PoseLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const MODEL_ROOT = 'https://storage.googleapis.com/mediapipe-models';
const MODELS = {
  poseFull: `${MODEL_ROOT}/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task`,
  poseLite: `${MODEL_ROOT}/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task`,
  hands: `${MODEL_ROOT}/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task`,
};

const tasks = {};
const canvases = [];
let initialized = false;
let initializing = false;
let lastTimestamp = -Infinity;

self.onmessage = ({ data }) => {
  if (data.type === 'init' && !initializing && !initialized) {
    initializing = true;
    initialize(data).catch((error) => {
      console.error('MediaPipe initialization:', error);
      dispose();
      self.postMessage(data.delegate === 'GPU'
        ? { type: 'retry-cpu' }
        : { type: 'error', message: '体・手の追跡モデルを読み込めませんでした。通信環境を確認し、最新版の Chrome または Edge で開始し直してください。' });
    });
  } else if (data.type === 'frame') {
    detect(data);
  } else if (data.type === 'dispose') {
    dispose();
    self.close();
  }
};

async function initialize({ delegate, quality }) {
  // 1.0.1's ES module loader supports module workers; the classic WASM loader
  // relies on script-scoped globals and cannot be substituted here.
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT, true);
  const { default: moduleFactory } = await import(fileset.wasmLoaderPath);
  const create = async (Task, name, modelAssetPath, options) => {
    self.postMessage({ type: 'status', message: `${name}の追跡モデルを準備しています…（初回は読み込みに時間がかかります）` });
    const canvas = new OffscreenCanvas(1, 1);
    canvases.push(canvas);
    // The loader clears ModuleFactory after creating each task. Dynamic import
    // is cached, so restore the pinned loader's export before every creation.
    self.ModuleFactory = moduleFactory;
    return Task.createFromOptions(fileset, {
      canvas,
      baseOptions: { modelAssetPath, delegate },
      runningMode: 'VIDEO',
      minTrackingConfidence: 0.55,
      ...options,
    });
  };

  // Create sequentially: MediaPipe's WASM loader uses shared factory globals.
  tasks.pose = await create(PoseLandmarker, '体', quality === 'light' ? MODELS.poseLite : MODELS.poseFull, {
    numPoses: 1,
    outputSegmentationMasks: false,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
  });
  // Keep the hand model ready so the checkbox never reloads models mid-frame.
  tasks.hands = await create(HandLandmarker, '手', MODELS.hands, {
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
  });
  initialized = true;
  initializing = false;
  self.postMessage({ type: 'ready', delegate });
}

function invalidatePoseHand(pose, side) {
  const indices = side === 'left' ? [15, 17, 19, 21] : [16, 18, 20, 22];
  for (const collection of [pose.landmarks?.[0], pose.worldLandmarks?.[0]]) {
    if (!collection) continue;
    for (const index of indices) {
      const point = collection[index];
      if (!point) continue;
      point.visibility = 0;
      point.presence = 0;
    }
  }
}

function validatePoseHands(pose, hands, enabled) {
  if (!enabled) return;
  const poseImage = pose.landmarks?.[0];
  if (!poseImage) return;
  const handWrists = (hands?.landmarks ?? []).map(points => points?.[0]).filter(Boolean);
  for (const [side, index] of [['left', 15], ['right', 16]]) {
    const wrist = poseImage[index];
    if (!wrist) {
      invalidatePoseHand(pose, side);
      continue;
    }
    // Pose sometimes hallucinates its four hand landmarks on background detail.
    // A real HandLandmarker wrist should occupy roughly the same image region.
    const corroborated = handWrists.some(hand => Math.hypot(hand.x - wrist.x, hand.y - wrist.y) < 0.14);
    if (!corroborated) invalidatePoseHand(pose, side);
  }
}

function detect({ bitmap, timestamp, time, trackHands }) {
  let pose;
  try {
    if (!initialized) throw new Error('Tracking is not initialized.');
    if (!Number.isFinite(timestamp)) throw new Error('Invalid capture timestamp.');
    // Defend the VIDEO contract even if the page clock is rounded for privacy.
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);

    // Hand latency matters more than keeping Pose/Hand delivery atomic. Run the
    // hand graph first and publish it immediately, then let the heavier Pose
    // graph finish. Both observations still carry the same camera capture time.
    const hands = trackHands ? tasks.hands.detectForVideo(bitmap, lastTimestamp) : null;
    if (hands) self.postMessage({ type: 'hands', result: { hands, time } });

    pose = tasks.pose.detectForVideo(bitmap, lastTimestamp);
    validatePoseHands(pose, hands, trackHands);
    const result = {
      // Only clone serializable data; segmentation is deliberately disabled.
      pose: { landmarks: pose.landmarks, worldLandmarks: pose.worldLandmarks },
      time,
    };
    self.postMessage({ type: 'results', result });
  } catch (error) {
    console.error('MediaPipe inference:', error);
    dispose();
    self.postMessage({ type: 'error', message: '体・手の追跡中にエラーが発生しました。軽量モードに切り替えるか、カメラを開始し直してください。' });
  } finally {
    // Pose results may own GPU masks if enabled in a future version.
    pose?.close?.();
    bitmap?.close();
  }
}

function dispose() {
  initialized = false;
  for (const [key, task] of Object.entries(tasks)) {
    try { task.close(); } catch { /* Continue releasing the remaining graphs. */ }
    delete tasks[key];
  }
  for (const canvas of canvases.splice(0)) {
    try { canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); }
    catch { /* Terminating this worker also releases failed partial contexts. */ }
    canvas.width = canvas.height = 1;
  }
}
