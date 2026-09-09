/** Camera ownership stays with the caller; this class owns inference only. */
export class Tracker {
  constructor({ onResults = () => {}, onStatus = () => {}, onError = () => {} } = {}) {
    this.onResults = onResults;
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

    const session = {
      video,
      fps: normalizeFps(fps),
      trackHands: Boolean(trackHands),
      quality: ['light', 'lite', 'performance'].includes(quality) ? 'light' : 'balanced',
      worker: null,
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
      // An unavailable CDN or broken worker must never leave Start pending forever.
      session.startupTimer = setTimeout(() => {
        this._fail(session, new Error('追跡モデルの読み込みがタイムアウトしました。通信環境を確認して、もう一度開始してください。'));
      }, 120000);
      this._launchWorker(session, 'GPU');
    });
  }

  setOptions({ fps, trackHands } = {}) {
    const session = this._session;
    if (!session) return;
    if (fps !== undefined) session.fps = normalizeFps(fps);
    if (trackHands !== undefined) session.trackHands = Boolean(trackHands);
    // Options travel with each frame: no command queue and no ambiguous option
    // changes while a frame is being processed. In-flight hands are filtered below.
  }

  stop() {
    const session = this._session;
    if (!session) return;
    this._session = null;
    clearTimeout(session.frameTimer);
    clearTimeout(session.startupTimer);
    clearTimeout(session.inferenceTimer);
    this._terminateWorker(session);
    session.video = null;
    session.reject?.(new DOMException('追跡の開始をキャンセルしました。', 'AbortError'));
    session.resolve = session.reject = null;
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
          // Replacing the worker also releases partially initialized WASM graphs
          // that createFromOptions cannot return to us after a GPU failure.
          this._terminateWorker(session);
          this._notify(this.onStatus, 'GPU での追跡を開始できなかったため、CPU に切り替えています…');
          this._launchWorker(session, 'CPU');
        } else if (data.type === 'ready') {
          session.ready = true;
          clearTimeout(session.startupTimer);
          session.resolve?.();
          session.resolve = session.reject = null;
          this._notify(this.onStatus, delegate === 'GPU' ? '全身追跡中' : '全身追跡中（CPU・動きが重い場合は軽量モードを選んでください）');
          this._schedule(session, 0);
        } else if (data.type === 'results') {
          clearTimeout(session.inferenceTimer);
          session.busy = false;
          const result = data.result;
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

  _schedule(session, delay) {
    if (this._session !== session || !session.ready || session.busy) return;
    clearTimeout(session.frameTimer);
    const wait = delay ?? Math.max(0, session.lastCaptureAt + 1000 / session.fps - performance.now());
    session.frameTimer = setTimeout(() => this._capture(session), wait);
  }

  async _capture(session) {
    if (this._session !== session || session.busy) return;
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
      // Stop/start can finish while createImageBitmap is still pending.
      if (this._session !== session) {
        bitmap.close();
        return;
      }
      session.worker.postMessage({
        type: 'frame', bitmap, timestamp,
        time: session.lastCaptureAt / 1000,
        trackHands: session.trackHands,
      }, [bitmap]);
      bitmap = null; // The worker now owns (and always closes) this bitmap.
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
    // Terminate is intentional: it also cancels model fetches / initialization
    // and releases worker-owned bitmaps and graphs without waiting on inference.
    session.worker.terminate();
    session.worker = null;
  }

  _fail(session, error) {
    if (this._session !== session) return;
    const wasStarting = Boolean(session.reject);
    session.reject?.(error);
    session.resolve = session.reject = null;
    this.stop();
    // Initialization errors use the start() promise; later failures use onError.
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
