const initCameraControls = () => {
  if (document.documentElement.classList.contains('output')) return;
  const cameraSelect = document.getElementById('cameraId');
  const cameraButton = document.getElementById('camera');
  const connection = document.getElementById('connection');
  if (!cameraSelect || !cameraButton || !connection) return;

  const keepSelectable = () => {
    if (connection.dataset.live === 'true' && cameraSelect.disabled) cameraSelect.disabled = false;
  };

  const restartTracking = () => {
    if (connection.dataset.live !== 'true') return;
    queueMicrotask(() => {
      if (connection.dataset.live !== 'true') return;
      cameraButton.click();
      setTimeout(() => cameraButton.click(), 0);
    });
  };

  new MutationObserver(keepSelectable).observe(cameraSelect, {
    attributes: true,
    attributeFilter: ['disabled'],
  });
  new MutationObserver(keepSelectable).observe(connection, {
    attributes: true,
    attributeFilter: ['data-live'],
  });
  cameraSelect.addEventListener('change', restartTracking);
  keepSelectable();
};

initCameraControls();
