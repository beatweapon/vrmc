import {
  FaceLandmarker, FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';
const TRACKING_MODE_KEY = 'vrmc.fullbody.tracking-mode.v1';
const trackingMode = () => {
  try { return localStorage.getItem(TRACKING_MODE_KEY) === 'face' ? 'face' : 'fullbody'; }
  catch { return 'fullbody'; }
};

/** Camera ownership stays with the caller; this class owns inference only. */
export class Tracker {
  constructor({ onResults = () => {}, onFace = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
    this.onResults = onResults;
    this.onFace = onFace;
    this.onStatus = onStatus;
    this.onError = onError;
    this._session = null;
  }

  async start(video, { fps = 24, trackHands = true, quality = 'balanced' } = {}) {
    this.stop();
    const mode = trackingMode();
    if (mode === 'fullbody' && (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
        typeof createImageBitmap !== 'function')) {
      throw new Error('このブラウザーは全身追跡に対応していません。最新版の Chrome または Edge で開いてください。');
    }
    if (!video) throw new Error('追跡するカメラ映像がありません。カメラを選び直してください。');

    const session = {
      video,
      mode,
      fps: normalizeFps(fps),
      trackHands: Boolean(trackHands),
      quality: ['light', 'lite', 'performance'].includes(quality) ? 'light' : 'balanced',
      worker: null,
      workerReady: mode === 'face',
      faceLandmarker: null,
      faceReady: false,
      faceHandle: null,
      faceLastVideoTime: -1,
      faceLastTimestamp: -Infinity,
      latestFace: null,
      ready: false,
      busy: false,
      frameTimer: null,
      startupTimer: null,
      inferenceTimer: null,
      lastVideoTime: -1,
      lastCaptureAt: -Infinity,
      lastTimestamp: -Infinity,
      resolve: null,
      reject: null,
    };
    this._session = session;
    return new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
      session.startupTimer = setTimeout(() => {
        this._fail(session, new Error('追跡モデルの読み込みがタイムアウトしました。通信環境を確認して、もう一度開始してください。'));
      }, 120000);
      if (mode === 'fullbody') this._launchWorker(session, 'GPU');
      this._launchFace(session);
    });
  }

  setOptions({ fps, trackHands } = {}) {
    const session = this._session;
    if (!session) return;
    if (fps !== undefined) session.fps = normalizeFps(fps);
    if (trackHands !== undefined) session.trackHands = Boolean(trackHands);
  }

  stop() {
    const session = this._session;
    if (!session) return;
    this._session = null;
    clearTimeout(session.frameTimer);
    clearTimeout(session.startupTimer);
    clearTimeout(session.inferenceTimer);
    if (session.faceHandle != null) cancelAnimationFrame(session.faceHandle);
    session.faceHandle = null;
    try { session.faceLandmarker?.close?.(); } catch { /* Continue cleanup. */ }
    session.faceLandmarker = null;
    session.latestFace = null;
    this._terminateWorker(session);
    session.video = null;
    session.reject?.(new DOMException('追跡の開始をキャンセルしました。', 'AbortError'));
    session.resolve = session.reject = null;
  }

  async _launchFace(session) {
    try {
      this._notify(this.onStatus, '顔の追跡モデルを準備しています…（初回は読み込みに時間がかかります）');
      const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.55,
      });
      if (this._session !== session) {
        faceLandmarker.close?.();
        return;
      }
      session.faceLandmarker = faceLandmarker;
      session.faceReady = true;
      this._faceLoop(session);
      this._maybeReady(session);
    } catch (error) {
      console.error('Face tracking initialization:', error);
      this._fail(session, new Error('顔の追跡モデルを読み込めませんでした。通信環境を確認し、最新版の Chrome または Edge で開始し直してください。'));
    }
  }

  _faceLoop(session) {
    if (this._session !== session || !session.faceLandmarker) return;
    const video = session.video;
    if (video.readyState >= 2 && video.videoWidth && video.videoHeight &&
        video.currentTime !== session.faceLastVideoTime) {
      session.faceLastVideoTime = video.currentTime;
      const captureAt = performance.now();
      const timestamp = Math.max(captureAt, session.faceLastTimestamp + 1);
      session.faceLastTimestamp = timestamp;
      try {
        const face = session.faceLandmarker.detectForVideo(video, timestamp);
        session.latestFace = face;
        this._notify(this.onFace, { face, time: captureAt / 1000 });
      } catch (error) {
        console.error('Face inference:', error);
        this._fail(session, new Error('顔の追跡中にエラーが発生しました。カメラを開始し直してください。'));
        return;
      }
    }
    session.faceHandle = requestAnimationFrame(() => this._faceLoop(session));
  }

  _launchWorker(session, delegate) {
    if (this._session !== session || session.mode !== 'fullbody') return;
    let worker;
    try {
      worker = new Worker(new URL('./tracking-worker.js', import.meta.url), { type: 'module' });
      session.worker = worker;
      worker.onmessage = ({ data }) => {
        if (this._session !== session || session.worker !== worker) return;
        if (data.type === 'status') {
          this._notify(this.onStatus, data.message);
        } else if (data.type === 'retry-cpu' && delegate === 'GPU') {
          this._terminateWorker(session);
          this._notify(this.onStatus, 'GPU での体・手追跡を開始できなかったため、CPU に切り替えています…');
          this._launchWorker(session, 'CPU');
        } else if (data.type === 'ready') {
          session.workerReady = true;
          this._maybeReady(session);
        } else if (data.type === 'results') {
          clearTimeout(session.inferenceTimer);
          session.busy = false;
          const result = data.result;
          if (session.latestFace) result.face = session.latestFace;
          if (!session.trackHands) delete result.hands;
          this._notify(this.onResults, result);
          this._schedule(session);
        } else if (data.type === 'error') {
          this._fail(session, new Error(data.message));
        }
      };
      worker.onerror = (event) => {
        event.preventDefault();
        if (this._session !== session || session.worker !== worker) return;
        console.error('Tracking worker:', event.message);
        this._fail(session, new Error('追跡プログラムを読み込めませんでした。HTTPS または localhost で開き、通信環境とブラウザーの拡張機能を確認してください。'));
      };
      worker.onmessageerror = () => {
        if (this._session !== session || session.worker !== worker) return;
        this._fail(session, new Error('追跡結果を受信できませんでした。カメラを停止して、もう一度開始してください。'));
      };
      worker.postMessage({ type: 'init', delegate, quality: session.quality });
    } catch (error) {
      console.error('Tracking worker initialization:', error);
      this._fail(session, new Error('全身追跡を開始できませんでした。最新版の Chrome または Edge で、HTTPS または localhost から開いてください。'));
    }
  }

  _maybeReady(session) {
    if (this._session !== session || session.ready || !session.workerReady || !session.faceReady) return;
    session.ready = true;
    clearTimeout(session.startupTimer);
    session.resolve?.();
    session.resolve = session.reject = null;
    this._notify(this.onStatus, session.mode === 'face' ? '顔追跡中' : '全身追跡中');
    if (session.mode === 'fullbody') {
      session.frameTimer = setTimeout(() => this._schedule(session, 0), 0);
    }
  }

  _schedule(session, delay) {
    if (this._session !== session || session.mode !== 'fullbody' || !session.ready || session.busy) return;
    clearTimeout(session.frameTimer);
    const wait = delay ?? Math.max(0, session.lastCaptureAt + 1000 / session.fps - performance.now());
    session.frameTimer = setTimeout(() => this._capture(session), wait);
  }

  async _capture(session) {
    if (this._session !== session || session.mode !== 'fullbody' || session.busy) return;
    const video = session.video;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight ||
        video.currentTime === session.lastVideoTime) {
      this._schedule(session, 16);
      return;
    }
    session.busy = true;
    session.lastVideoTime = video.currentTime;
    session.lastCaptureAt = performance.now();
    const timestamp = Math.max(session.lastCaptureAt, session.lastTimestamp + 1);
    session.lastTimestamp = timestamp;
    const maxWidth = session.quality === 'light' ? 960 : 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    let bitmap;
    try {
      bitmap = await createImageBitmap(video, {
        resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
        resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)),
        resizeQuality: 'medium',
      });
      if (this._session !== session) {
        bitmap.close();
        return;
      }
      session.worker.postMessage({
        type: 'frame', bitmap, timestamp,
        time: session.lastCaptureAt / 1000,
        trackHands: session.trackHands,
      }, [bitmap]);
      bitmap = null;
      session.inferenceTimer = setTimeout(() => {
        this._fail(session, new Error('追跡処理が応答しなくなりました。軽量モードに切り替えるか、カメラを開始し直してください。'));
      }, 20000);
    } catch (error) {
      bitmap?.close();
      if (this._session !== session) return;
      console.error('Camera frame capture:', error);
      this._fail(session, new Error('カメラ映像を読み取れませんでした。カメラの接続を確認して、もう一度開始してください。'));
    }
  }

  _terminateWorker(session) {
    if (!session.worker) return;
    session.worker.onmessage = session.worker.onerror = session.worker.onmessageerror = null;
    session.worker.terminate();
    session.worker = null;
  }

  _fail(session, error) {
    if (this._session !== session) return;
    const wasStarting = Boolean(session.reject);
    session.reject?.(error);
    session.resolve = session.reject = null;
    this.stop();
    if (!wasStarting) this._notify(this.onError, error);
  }

  _notify(callback, value) {
    try { callback(value); }
    catch (error) { console.error('Tracking callback:', error); }
  }
}

const normalizeFps = value => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(60, Math.max(5, number)) : 24;
};
