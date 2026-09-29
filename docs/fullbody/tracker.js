import {
  FaceLandmarker, FilesetResolver,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs';

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task';

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
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
        typeof createImageBitmap !== 'function') {
      throw new Error('このブラウザーは全身追跡に対応していません。最新版の Chrome または Edge で開いてください。');
    }
    if (!video) throw new Error('追跡するカメラ映像がありません。カメラを選び直してください。');

    const now = performance.now();
    const session = {
      video,
      fps: normalizeFps(fps),
      trackHands: Boolean(trackHands),
      quality: ['light', 'lite', 'performance'].includes(quality) ? 'light' : 'balanced',
      worker: null,
      workerReady: false,
      faceLandmarker: null,
      faceReady: false,
      faceHandle: null,
      faceLastVideoTime: -1,
      faceLastTimestamp: -Infinity,
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
      diagnostics: {
        windowAt: now,
        captureAttempts: 0,
        videoChanges: 0,
        sentFrames: 0,
        resultFrames: 0,
        bitmapMs: 0,
        bitmapCount: 0,
        poseMs: 0,
        handMs: 0,
        workerMs: 0,
        faceFrames: 0,
        faceMs: 0,
      },
    };
    this._session = session;
    return new Promise((resolve, reject) => {
      session.resolve = resolve;
      session.reject = reject;
      session.startupTimer = setTimeout(() => {
        this._fail(session, new Error('追跡モデルの読み込みがタイムアウトしました。通信環境を確認して、もう一度開始してください。'));
      }, 120000);
      this._launchWorker(session, 'GPU');
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
    try { session.faceLandmarker?.close?.(); } catch { /* continue */ }
    session.faceLandmarker = null;
    this._terminateWorker(session);
    session.video = null;
    session.reject?.(new DOMException('追跡の開始をキャンセルしました。', 'AbortError'));
    session.resolve = session.reject = null;
  }

  async _launchFace(session) {
    try {
      this._notify(this.onStatus, '顔の追跡モデルを準備しています…');
      const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
      const faceLandmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        numFaces: 1,
        runningMode: 'VIDEO',
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
      console.error('Main-thread face tracking initialization:', error);
      this._fail(session, new Error('顔追跡モデルを初期化できませんでした。'));
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
      const started = performance.now();
      try {
        const face = session.faceLandmarker.detectForVideo(video, timestamp);
        session.diagnostics.faceFrames++;
        session.diagnostics.faceMs += performance.now() - started;
        this._notify(this.onFace, { face, time: captureAt / 1000 });
      } catch (error) {
        console.error('Main-thread face inference:', error);
        this._fail(session, new Error('顔追跡中にエラーが発生しました。'));
        return;
      }
    }
    session.faceHandle = requestAnimationFrame(() => this._faceLoop(session));
  }

  _launchWorker(session, delegate) {
    if (this._session !== session) return;
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
          if (!session.trackHands) delete result.hands;
          this._recordResultDiagnostics(session, result.diagnostics);
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
    this._notify(this.onStatus, '全身追跡中（顔: main thread / 体・手: worker）');
    this._schedule(session, 0);
  }

  _schedule(session, delay) {
    if (this._session !== session || !session.ready || session.busy) return;
    clearTimeout(session.frameTimer);
    const wait = delay ?? Math.max(0, session.lastCaptureAt + 1000 / session.fps - performance.now());
    session.frameTimer = setTimeout(() => this._capture(session), wait);
  }

  async _capture(session) {
    if (this._session !== session || session.busy) return;
    const video = session.video;
    const diagnostics = session.diagnostics;
    diagnostics.captureAttempts++;
    if (video.readyState < 2 || !video.videoWidth || !video.videoHeight ||
        video.currentTime === session.lastVideoTime) {
      this._schedule(session, 16);
      return;
    }
    diagnostics.videoChanges++;
    session.busy = true;
    session.lastVideoTime = video.currentTime;
    session.lastCaptureAt = performance.now();
    const timestamp = Math.max(session.lastCaptureAt, session.lastTimestamp + 1);
    session.lastTimestamp = timestamp;
    const maxWidth = session.quality === 'light' ? 960 : 1280;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    let bitmap;
    try {
      const bitmapStart = performance.now();
      bitmap = await createImageBitmap(video, {
        resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
        resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)),
        resizeQuality: 'medium',
      });
      const bitmapMs = performance.now() - bitmapStart;
      diagnostics.bitmapMs += bitmapMs;
      diagnostics.bitmapCount++;
      if (this._session !== session) {
        bitmap.close();
        return;
      }
      diagnostics.sentFrames++;
      session.worker.postMessage({
        type: 'frame', bitmap, timestamp,
        time: session.lastCaptureAt / 1000,
        trackHands: session.trackHands,
        diagnostics: { bitmapMs },
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

  _recordResultDiagnostics(session, values = {}) {
    const d = session.diagnostics;
    d.resultFrames++;
    for (const key of ['poseMs', 'handMs', 'workerMs']) d[key] += Number(values[key]) || 0;
    const now = performance.now();
    const elapsed = now - d.windowAt;
    if (elapsed < 1000) return;
    const seconds = elapsed / 1000;
    const avg = (value, count) => count ? value / count : 0;
    const track = session.video?.srcObject?.getVideoTracks?.()[0];
    const trackFps = track?.getSettings?.().frameRate;
    const previewVisible = !session.video?.closest?.('#camera-preview')?.hidden;
    const message = [
      `計測 ${previewVisible ? 'PREVIEW ON' : 'PREVIEW OFF'}`,
      `track ${Number.isFinite(trackFps) ? trackFps.toFixed(1) : '?'} fps`,
      `face ${Math.round(d.faceFrames / seconds)}/s ${avg(d.faceMs, d.faceFrames).toFixed(1)} ms`,
      `body ${Math.round(d.resultFrames / seconds)}/s`,
      `bitmap ${avg(d.bitmapMs, d.bitmapCount).toFixed(1)} ms`,
      `worker ${avg(d.workerMs, d.resultFrames).toFixed(1)} ms`,
      `pose ${avg(d.poseMs, d.resultFrames).toFixed(1)}`,
      `hand ${avg(d.handMs, d.resultFrames).toFixed(1)} ms`,
    ].join(' · ');
    console.log(message);
    this._notify(this.onStatus, message);
    Object.assign(d, {
      windowAt: now,
      captureAttempts: 0,
      videoChanges: 0,
      sentFrames: 0,
      resultFrames: 0,
      bitmapMs: 0,
      bitmapCount: 0,
      poseMs: 0,
      handMs: 0,
      workerMs: 0,
      faceFrames: 0,
      faceMs: 0,
    });
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

function normalizeFps(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(60, Math.max(5, number)) : 24;
}
