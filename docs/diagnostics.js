(() => {
  const enabled = new URLSearchParams(location.search).get("debug") === "1";
  const panel = document.createElement("details");
  panel.id = "diagnostics";
  panel.open = true;
  panel.hidden = !enabled;
  panel.style.cssText = "position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;max-height:45vh;overflow:auto;background:#111;color:#fff;padding:12px;font:16px/1.4 monospace;text-align:left;";
  const title = document.createElement("summary");
  title.textContent = "診断 v1.8.2（タップで折りたたむ）";
  const output = document.createElement("pre");
  output.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;";
  panel.append(title, output);
  document.body.append(panel);

  const messages = [];
  let stage = "スクリプト読み込み";
  let frames = 0;
  let detections = 0;
  let faces = 0;
  let detectionMs = 0;
  let started = 0;
  let video;
  const boot = performance.now();
  const format = (value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === "string") return value;
    try { return JSON.stringify(value) ?? String(value); }
    catch { return String(value); }
  };
  const render = () => {
    if (panel.hidden) return;
    const track = video?.srcObject?.getVideoTracks()[0];
    output.textContent = [
      `経過: ${((performance.now() - boot) / 1000).toFixed(1)}秒 / ${stage}`,
      `描画: ${frames} / 検出完了: ${detections} / 顔: ${faces} / 検出時間: ${detectionMs.toFixed(0)}ms`,
      video ? `動画: ${video.currentTime.toFixed(2)}秒 / paused=${video.paused} / readyState=${video.readyState} / ${video.videoWidth}x${video.videoHeight}` : "動画: 未接続",
      `カメラ: ${track?.readyState ?? "なし"} / muted=${track?.muted ?? "-"} / 表示=${document.visibilityState}`,
      ...messages,
    ].join("\n");
  };
  const record = (label, value) => {
    messages.push(`[${((performance.now() - boot) / 1000).toFixed(1)}s] ${label}: ${format(value).slice(0, 3000)}`);
    if (messages.length > 8) messages.shift();
    render();
  };
  const report = (label, value) => {
    panel.hidden = false;
    record(label, value);
  };
  window.addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) {
      report("JavaScriptエラー", event.error || `${event.message} ${event.filename}:${event.lineno}:${event.colno}`);
    } else if (event.target instanceof HTMLScriptElement) {
      report("スクリプト読み込み失敗", event.target.src);
    }
  }, true);
  window.addEventListener("unhandledrejection", (event) => report("非同期エラー", event.reason));
  // Keep the original console output; some loaders catch errors internally.
  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const message = args.map(format).join(" ");
      if (message.startsWith("INFO:")) return;
      if (level === "error") report("console.error", message);
      else record("警告", message);
    };
  }
  window.vrmDiagnostics = {
    stage(value) { stage = value; render(); },
    camera(element) {
      video = element;
      for (const type of ["playing", "pause", "waiting", "stalled", "ended", "error"]) {
        video.addEventListener(type, () => record("動画イベント", `${type}${video.error ? `: ${video.error.message}` : ""}`));
      }
    },
    renderer(renderer) {
      renderer.domElement.addEventListener("webglcontextlost", () => report("WebGL", "描画用GPUコンテキストが失われました"));
    },
    frame() { frames++; },
    detectionStart() { started = performance.now(); stage = "顔検出中"; },
    detectionEnd(result) {
      detectionMs = performance.now() - started;
      detections++;
      faces = result.faceLandmarks?.length ?? 0;
      stage = "表情反映中";
    },
    detectionApplied() { stage = "次の検出待ち"; },
  };
  setInterval(render, 1000);
  render();
})();
