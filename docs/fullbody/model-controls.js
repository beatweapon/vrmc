import {sampleModels} from '../models/catalog.js';
import {modelStore, rememberModel, storedModels} from './settings.js';

const PERSON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0v1H5v-1Z"/></svg>';
const sampleNames = new Set(sampleModels.map(model => model.file.split('/').at(-1)));
const isSampleFile = file => !!file?.name && sampleNames.has(file.name);

const style = document.createElement('style');
style.textContent = `
.model-quick-controls{position:fixed;right:122px;bottom:18px;z-index:7;width:max-content}
.model-quick-button{width:44px;height:44px;min-width:44px;min-height:44px;padding:10px;border:1px solid #6c827a;border-radius:9px;background:#172028da;color:#acedd1;display:grid;place-items:center;box-shadow:0 3px 14px #0005;transition:background .15s,border-color .15s,transform .15s}
.model-quick-button:hover{background:#26363e;border-color:#91b5a5}.model-quick-button:active{transform:translateY(1px)}
.model-quick-button svg{width:22px;height:22px;fill:currentColor;display:block}
.model-picker{position:absolute;right:0;bottom:52px;width:min(460px,calc(100vw - 36px));max-height:min(72vh,620px);overflow:auto;padding:14px;background:#172028f7;border:1px solid #63776e;border-radius:12px;box-shadow:0 8px 30px #0009;color:#e7ebed;scrollbar-width:thin}
.model-picker[hidden]{display:none}.model-picker-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.model-picker-title{font-size:12px;font-weight:600;margin:0}.model-picker-add{min-height:32px;padding:6px 9px;font-size:10px}
.model-picker-section{margin-top:13px}.model-picker-section:first-of-type{margin-top:0}.model-picker-heading{font-size:10px;letter-spacing:.08em;color:#96a2aa;margin:0 0 8px}.model-picker-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.model-card{min-width:0;min-height:0;padding:7px;border:1px solid #34434a;border-radius:9px;background:#202a31;text-align:left;color:#e7ebed}.model-card:hover{background:#29363e;border-color:#607a70}.model-card[data-active=true]{border-color:#acedd1;box-shadow:0 0 0 1px #acedd1 inset}.model-card-preview{display:grid;place-items:center;width:100%;aspect-ratio:1/1;border-radius:6px;background:#111a20;overflow:hidden;margin-bottom:6px}.model-card-preview img{display:block;width:100%;height:100%;object-fit:contain}.model-card-preview svg{width:42%;height:42%;fill:#8aa99d}.model-card-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:9px;color:#d7e1e5}.model-card-meta{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;font-size:8px;color:#7f9099}.model-picker-empty{font-size:10px;color:#82929b;line-height:1.7;margin:3px 0}.output .model-quick-controls{display:none!important}
@media(max-width:760px){.model-quick-controls{right:116px;bottom:12px}.model-picker{right:-104px;bottom:52px;width:min(430px,calc(100vw - 24px))}.model-picker-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
`;
document.head.appendChild(style);

const initModelControls = async () => {
  if (document.documentElement.classList.contains('output')) return;
  const fileInput = document.getElementById('files');
  const sampleSelect = document.getElementById('sample-model');
  if (!fileInput || !sampleSelect) return;

  const root = document.createElement('div');
  root.className = 'model-quick-controls';
  root.innerHTML = `
    <div class="model-picker" hidden aria-label="アバターを選択">
      <div class="model-picker-header"><p class="model-picker-title">アバターを切り替える</p><button type="button" class="model-picker-add">＋ VRMを追加</button></div>
      <section class="model-picker-section"><p class="model-picker-heading">このブラウザに保存済み</p><div class="model-picker-grid" data-list="stored"></div><p class="model-picker-empty" hidden>読み込んだVRMがここに表示されます。</p></section>
      <section class="model-picker-section"><p class="model-picker-heading">サンプル</p><div class="model-picker-grid" data-list="samples"></div></section>
    </div>
    <button type="button" class="model-quick-button" aria-label="アバターを切り替える" aria-expanded="false" title="アバターを切り替える">${PERSON_ICON}</button>`;
  document.body.appendChild(root);

  const panel = root.querySelector('.model-picker');
  const toggle = root.querySelector('.model-quick-button');
  const add = root.querySelector('.model-picker-add');
  const samples = root.querySelector('[data-list="samples"]');
  const stored = root.querySelector('[data-list="stored"]');
  const empty = root.querySelector('.model-picker-empty');
  let thumbnailUrls = [];
  let selectingStored = false;

  const clearThumbnailUrls = () => {
    thumbnailUrls.forEach(url => URL.revokeObjectURL(url));
    thumbnailUrls = [];
  };
  const currentName = () => document.getElementById('model-name')?.textContent || '';
  const thumbnailUrl = thumbnail => {
    if (!thumbnail) return null;
    if (typeof thumbnail === 'string') return thumbnail;
    const url = URL.createObjectURL(thumbnail);
    thumbnailUrls.push(url);
    return url;
  };

  const selectFile = file => {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    selectingStored = true;
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', {bubbles:true}));
    selectingStored = false;
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  const selectSample = id => {
    sampleSelect.value = id;
    if (sampleSelect.value !== id) return;
    sampleSelect.dispatchEvent(new Event('change', {bubbles:true}));
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };

  const card = ({name, meta, thumbnail, active, onclick}) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-card';
    button.dataset.active = String(active);
    button.title = name;
    const preview = document.createElement('span');
    preview.className = 'model-card-preview';
    const src = thumbnailUrl(thumbnail);
    if (src) {
      const image = new Image();
      image.src = src;
      image.alt = '';
      image.loading = 'lazy';
      preview.append(image);
    } else preview.innerHTML = PERSON_ICON;
    const label = document.createElement('span');
    label.className = 'model-card-name';
    label.textContent = name;
    const detail = document.createElement('span');
    detail.className = 'model-card-meta';
    detail.textContent = meta;
    button.append(preview,label,detail);
    button.onclick = onclick;
    return button;
  };

  const render = async () => {
    clearThumbnailUrls();
    const selectedName = currentName();
    try {
      const entries = await storedModels();
      stored.replaceChildren(...entries.map(entry => card({
        name:entry.name,
        meta:`${Math.max(.1,entry.size/1024/1024).toFixed(1)} MB`,
        thumbnail:entry.thumbnail,
        active:selectedName === entry.name,
        onclick:()=>selectFile(entry.file),
      })));
      empty.hidden = entries.length > 0;
    } catch {
      stored.replaceChildren();
      empty.hidden = false;
      empty.textContent = '保存済みVRMを読み込めませんでした。';
    }
    samples.replaceChildren(...sampleModels.map(model => card({
      name:model.name,
      meta:model.author || 'サンプル',
      thumbnail:model.thumbnail,
      active:selectedName === model.file.split('/').at(-1) || (model.id === 'default' && selectedName === 'サンプルVRM'),
      onclick:()=>selectSample(model.id),
    })));
  };

  const remember = async file => {
    if (selectingStored || !file?.name?.toLowerCase().endsWith('.vrm') || isSampleFile(file)) return;
    try { await rememberModel(file); await render(); }
    catch { /* The avatar can still be used when persistent storage is unavailable. */ }
  };

  // Migrate the previous single-file cache into the multi-model library.
  try {
    const legacy = await modelStore();
    if (legacy && !isSampleFile(legacy)) await rememberModel(legacy);
  } catch { /* Storage is optional. */ }

  fileInput.addEventListener('change', () => remember(fileInput.files[0]));
  window.addEventListener('drop', event => remember([...event.dataTransfer.files].find(file => file.name?.toLowerCase().endsWith('.vrm'))), {capture:true});

  toggle.onclick = async () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) await render();
  };
  add.onclick = () => fileInput.click();
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !root.contains(event.target)) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded','false');
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded','false');
      toggle.focus();
    }
  });
  window.addEventListener('pagehide', clearThumbnailUrls, {once:true});

  await render();
};

initModelControls();
