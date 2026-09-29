const ICONS = {
  palette: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0 0 18h1.2a2.3 2.3 0 0 0 1.5-4c-.5-.4-.2-1.2.4-1.2H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3Zm-4.2 9.1a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Zm2-4.1a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Zm4.6-.4a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Zm3 3.5a1.35 1.35 0 1 1 0-2.7 1.35 1.35 0 0 1 0 2.7Z"/></svg>',
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9.2l4.3-4.3a1 1 0 0 1 1.4 0l2.7 2.7 1.8-1.8a1 1 0 0 1 1.4 0L20 16.2V6H4Zm11 4.2a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z"/></svg>',
};

const style = document.createElement('style');
style.textContent = `
#image-control{display:block!important;margin-top:16px;padding-top:14px;border-top:1px solid #303b43}
#image-control::before{content:'背景画像';display:block;margin-bottom:9px;font-size:11px;color:#bdc9d1}
#image-control>.button,#image-control>button{display:block;width:100%;margin:8px 0;position:static}
#image-control>.hint{margin:8px 0 0;overflow-wrap:anywhere}
.background-quick-controls{position:fixed;right:18px;bottom:18px;z-index:6;display:flex;flex-direction:row;gap:8px;align-items:center;width:max-content}
.background-quick-button{position:relative;flex:0 0 44px;width:44px;height:44px;min-width:44px;min-height:44px;padding:10px;border:1px solid #6c827a;border-radius:9px;background:#172028da;color:#acedd1;display:grid;place-items:center;box-shadow:0 3px 14px #0005;transition:background .15s,border-color .15s,transform .15s}
.background-quick-button:hover{background:#26363e;border-color:#91b5a5}.background-quick-button:active{transform:translateY(1px)}
.background-quick-button svg{width:22px;height:22px;fill:currentColor;display:block}
.background-quick-button.drop-target{border-color:#acedd1;background:#29483d;box-shadow:0 0 0 3px #acedd12b,0 3px 14px #0005}
.background-palette-panel{position:absolute;right:52px;bottom:0;width:210px;padding:12px;background:#172028f2;border:1px solid #63776e;border-radius:10px;box-shadow:0 7px 24px #0008;color:#e7ebed}
.background-palette-panel[hidden]{display:none}.background-palette-title{font-size:11px;color:#b9c6ce;margin:0 0 9px}
.background-palette-presets{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:10px}
.background-palette-presets button{min-height:34px;padding:6px 4px;font-size:10px}.background-palette-presets button[data-bg="transparent"]{background:linear-gradient(135deg,#ddd 25%,#888 25%,#888 50%,#ddd 50%,#ddd 75%,#888 75%);background-size:10px 10px;color:#111;text-shadow:0 1px #fff}
.background-palette-presets button[data-bg="green"]{background:#00aa39;color:white}.background-palette-presets button[data-bg="blue"]{background:#135fd1;color:white}
.background-palette-color{display:flex;align-items:center;gap:9px;font-size:10px;color:#b9c6ce}.background-palette-color input{width:52px;height:32px;margin:0;padding:0;border:0;background:transparent;cursor:pointer}
.output .background-quick-controls{display:none!important}
@media(max-width:760px){.background-quick-controls{right:12px;bottom:12px}.background-palette-panel{right:0;bottom:52px}}
`;
document.head.appendChild(style);

const initBackgroundControls = () => {
  if (document.documentElement.classList.contains('output')) return;
  const visibleSelect = document.querySelector('select[data-setting="background"]');
  const storedColor = document.querySelector('[data-setting="backgroundColor"]');
  const fileInput = document.getElementById('background-file');
  if (!visibleSelect || !storedColor || !fileInput) return;

  const settingSelect = document.createElement('select');
  settingSelect.hidden = true;
  settingSelect.dataset.setting = 'background';
  for (const value of ['transparent','green','blue','color','image']) settingSelect.add(new Option(value, value));
  visibleSelect.removeAttribute('data-setting');
  visibleSelect.querySelector('option[value="image"]')?.remove();
  visibleSelect.insertAdjacentElement('afterend', settingSelect);

  visibleSelect.addEventListener('change', () => {
    settingSelect.value = visibleSelect.value;
    settingSelect.dispatchEvent(new Event('input', {bubbles:true}));
  });
  settingSelect.addEventListener('input', () => {
    if (settingSelect.value !== 'image') visibleSelect.value = settingSelect.value;
  });

  const root = document.createElement('div');
  root.className = 'background-quick-controls';
  root.innerHTML = `
    <div class="background-palette-panel" hidden>
      <p class="background-palette-title">背景色</p>
      <div class="background-palette-presets">
        <button type="button" data-bg="transparent">透過</button>
        <button type="button" data-bg="green">緑</button>
        <button type="button" data-bg="blue">青</button>
      </div>
      <label class="background-palette-color">好きな色 <input type="color" value="${storedColor.value || '#00ff00'}" aria-label="好きな背景色" /></label>
    </div>
    <button type="button" class="background-quick-button" data-action="palette" aria-label="背景色を設定" title="背景色を設定">${ICONS.palette}</button>
    <button type="button" class="background-quick-button" data-action="photo" aria-label="背景画像を設定。画像をここにドロップすることもできます" title="背景画像を設定・画像をドロップ">${ICONS.photo}</button>`;
  document.body.appendChild(root);

  const panel = root.querySelector('.background-palette-panel');
  const paletteButton = root.querySelector('[data-action="palette"]');
  const photoButton = root.querySelector('[data-action="photo"]');
  const quickColor = root.querySelector('input[type="color"]');

  const selectBackground = value => {
    settingSelect.value = value;
    settingSelect.dispatchEvent(new Event('input', {bubbles:true}));
  };
  const chooseImage = file => {
    if (!file?.type?.startsWith('image/')) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    fileInput.dispatchEvent(new Event('change', {bubbles:true}));
  };

  paletteButton.onclick = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) quickColor.value = storedColor.value;
  };
  photoButton.onclick = () => fileInput.click();
  panel.querySelectorAll('[data-bg]').forEach(button => {
    button.onclick = () => {
      selectBackground(button.dataset.bg);
      panel.hidden = true;
    };
  });
  quickColor.oninput = () => {
    storedColor.value = quickColor.value;
    storedColor.dispatchEvent(new Event('input', {bubbles:true}));
    if (settingSelect.value !== 'color') selectBackground('color');
  };

  for (const type of ['dragenter','dragover']) photoButton.addEventListener(type, event => {
    event.preventDefault();
    event.stopPropagation();
    if ([...event.dataTransfer.items].some(item => item.kind === 'file' && item.type.startsWith('image/'))) {
      event.dataTransfer.dropEffect = 'copy';
      photoButton.classList.add('drop-target');
    }
  });
  for (const type of ['dragleave','dragend']) photoButton.addEventListener(type, event => {
    event.preventDefault();
    event.stopPropagation();
    photoButton.classList.remove('drop-target');
  });
  photoButton.addEventListener('drop', event => {
    event.preventDefault();
    event.stopPropagation();
    photoButton.classList.remove('drop-target');
    chooseImage([...event.dataTransfer.files].find(file => file.type.startsWith('image/')));
  });

  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !root.contains(event.target)) panel.hidden = true;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) panel.hidden = true;
  });
};

initBackgroundControls();
