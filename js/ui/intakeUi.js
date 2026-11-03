// intakeUi.js - picker buttons, drag & drop, clipboard paste -> store.add(). Reports a
// summary through the toaster. Files never leave the page: they are read via File APIs only.

const hasFiles = (dt) => !!dt && Array.from(dt.types ?? []).includes('Files');

export function initIntake({ store, dropzone, fileInput, galleryInput, cameraInput, browseButtons, cameraBtn, galleryBtn, toaster, goToConvert, isConvertActive }) {
  async function ingest(files) {
    if (!files.length) return;
    goToConvert?.();
    dropzone.setAttribute('aria-busy', 'true');
    const res = await store.add(files);
    dropzone.setAttribute('aria-busy', 'false');
    toaster.show(...summary(res));
  }

  function summary({ added = 0, rejected = 0 }) {
    const parts = [];
    if (added) parts.push(`${added} ${added === 1 ? 'file' : 'files'} added`);
    if (rejected) parts.push(`${rejected} not accepted`);
    const text = parts.join(', ') + '.';
    if (added && !rejected) return [text, 'success'];
    return [rejected ? `${text} See the list for details.` : text, added ? 'info' : 'error'];
  }

  const pick = (input) => () => input.click();
  browseButtons.forEach((b) => b.addEventListener('click', pick(fileInput)));
  cameraBtn?.addEventListener('click', pick(cameraInput));
  galleryBtn?.addEventListener('click', pick(galleryInput));

  for (const input of [fileInput, galleryInput, cameraInput]) {
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? []);
      input.value = ''; // allow picking the same file again after removal
      ingest(files);
    });
  }

  // ----- drag & drop (window-wide so a miss never navigates the browser to the file) -----
  let depth = 0;
  const setOver = (on) => dropzone.classList.toggle('is-dragover', on);
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth += 1;
    setOver(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setOver(false);
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth = 0;
    setOver(false);
    ingest(Array.from(e.dataTransfer.files));
  });

  // ----- paste images (screenshots, copied images) -----
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA)$/.test(t.tagName)) && t.type !== 'file') return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length) return;
    e.preventDefault();
    // Pasted screenshots arrive as "image.png"; give each a unique name so they are distinguishable.
    const stamped = files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `pasted-${Date.now()}-${i + 1}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: f.type, lastModified: Date.now() })));
    ingest(stamped);
  });

  return { ingest };
}
