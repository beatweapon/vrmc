export const DEFAULTS = Object.freeze({
  cameraId: '', fps: 24, quality: 'balanced', trackHands: true, seated: false,
  bodySmoothing: .12, faceSmoothing: .08, minVisibility: .55,
  rootMotion: true, motionScale: 1, headStrength: 1, gazeStrength: 1,
  mouthStrength: 1, expressionStrength: .65, blinkLink: false, blinkHoldMs: 140,
  smileStrength: 1, surpriseStrength: 1, angryStrength: 1,
  eyeOpenLeft: .28, eyeOpenRight: .28, eyeClosedLeft: .08, eyeClosedRight: .08,
  background: 'transparent', backgroundColor: '#00ff00', mirrorPreview: true, mirrorAvatar: true,
});
const ranges = {
  fps: [10,30], bodySmoothing: [.02,.5], faceSmoothing: [.02,.3], minVisibility: [.3,.9],
  motionScale: [0,2], headStrength: [.25,1.5], gazeStrength: [0,2], mouthStrength: [0,2],
  expressionStrength: [0,1], blinkHoldMs: [50,350],
  smileStrength: [0,2], surpriseStrength: [0,2], angryStrength: [0,2],
  eyeOpenLeft: [.06,.6], eyeOpenRight: [.06,.6], eyeClosedLeft: [.01,.4], eyeClosedRight: [.01,.4],
};
export function sanitizeSettings(input = {}) {
  const settings = {...DEFAULTS};
  for (const [key, value] of Object.entries(input || {})) {
    if (!(key in DEFAULTS)) continue;
    if (ranges[key] && typeof value === 'number' && Number.isFinite(value)) {
      settings[key] = Math.max(ranges[key][0], Math.min(ranges[key][1], value));
    } else if (typeof DEFAULTS[key] === 'boolean' && typeof value === 'boolean') settings[key] = value;
    else if (key === 'cameraId' && typeof value === 'string') settings[key] = value;
    else if (key === 'background' && ['transparent','green','blue','color'].includes(value)) settings[key] = value;
    else if (key === 'quality' && ['balanced','light'].includes(value)) settings[key] = value;
    else if (key === 'backgroundColor' && /^#[\da-f]{6}$/i.test(value)) settings[key] = value;
  }
  for (const side of ['Left','Right']) {
    settings[`eyeOpen${side}`] = Math.max(settings[`eyeOpen${side}`], settings[`eyeClosed${side}`] + .02);
  }
  return settings;
}

const KEY = 'vrmc.fullbody.v1';
export function loadProfile() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved?.version === 1) return {settings: sanitizeSettings(saved.settings), calibration: saved.calibration || {}};
  } catch { /* Storage is optional. */ }
  return {settings: {...DEFAULTS}, calibration: {}};
}
export function saveProfile(settings, calibration) {
  try { localStorage.setItem(KEY, JSON.stringify({version:1, settings, calibration})); return true; }
  catch { return false; }
}

// Separate from the original app's store: failed writes never replace a working avatar.
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vrmc-fullbody', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('アバター保存用データベースを開けません。'));
  });
}
export async function modelStore(file) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('files', file === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('files');
      const request = file === undefined ? store.get('avatar') : file === null ? store.delete('avatar') : store.put(file, 'avatar');
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(tx.error || new Error('アバターを保存できません。'));
    });
  } finally { db.close(); }
}
