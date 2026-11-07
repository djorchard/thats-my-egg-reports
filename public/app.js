const $ = (id) => document.getElementById(id);
const form = $('report-form');
const zone = $('drop-zone');
const canvas = $('image-canvas');
const ctx = canvas.getContext('2d');
const input = $('image-input');
const description = $('description');
const submit = $('submit');
let original = null, hover = false, pointer = null, previous = null;
let loading = false, sending = false, loadRevision = 0;
let reportId = crypto.randomUUID(), widgetId, config;
const MAX_IMAGE = 750_000;

function message(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
}
function changed() { reportId = crypto.randomUUID(); }
function restore() {
  if (!original) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(original, 0, 0, canvas.width, canvas.height);
}
function clearImage() {
  loadRevision++;
  loading = false; submit.disabled = !config?.ready;
  original?.close(); original = null; pointer = null;
  canvas.hidden = true; $('upload-prompt').hidden = false;
  $('image-tools').hidden = true; zone.classList.remove('has-image');
  zone.setAttribute('role', 'button'); zone.tabIndex = 0;
  input.value = ''; changed();
}
async function loadImage(file) {
  if (sending || !file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    message('Choose a PNG, JPG or WebP image.', true); return;
  }
  if (file.size > 15 * 1024 * 1024) { message('That image is too large. Choose one under 15 MB.', true); return; }
  const revision = ++loadRevision;
  loading = true; submit.disabled = true;
  message('Opening your image...');
  try {
    const bitmap = await createImageBitmap(file);
    if (revision !== loadRevision) { bitmap.close(); return; }
    if (bitmap.width * bitmap.height > 40_000_000) {
      bitmap.close(); throw new Error('Choose an image smaller than 40 megapixels.');
    }
    original?.close(); original = bitmap;
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    restore(); canvas.hidden = false; $('upload-prompt').hidden = true;
    $('image-tools').hidden = false; zone.classList.add('has-image');
    zone.setAttribute('role', 'group'); zone.tabIndex = -1;
    changed(); message('Image ready. Draw in red to point out the issue.');
  } catch (error) {
    if (revision === loadRevision) message(error.message === 'Choose an image smaller than 40 megapixels.' ? error.message : 'We couldn’t open that image. Try another PNG, JPG or WebP.', true);
  } finally {
    if (revision === loadRevision) { loading = false; submit.disabled = !config?.ready; }
    input.value = '';
  }
}
zone.addEventListener('mouseenter', () => { hover = true; });
zone.addEventListener('mouseleave', () => { hover = false; });
zone.addEventListener('click', () => { if (!original && !sending && !loading) input.click(); });
zone.addEventListener('keydown', (event) => {
  if (!original && ['Enter', ' '].includes(event.key)) { event.preventDefault(); input.click(); }
});
input.addEventListener('change', () => loadImage(input.files[0]));
for (const name of ['dragenter', 'dragover']) zone.addEventListener(name, (event) => {
  event.preventDefault(); zone.classList.add('dragging');
});
zone.addEventListener('dragleave', (event) => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('dragging'); });
zone.addEventListener('drop', (event) => {
  event.preventDefault(); zone.classList.remove('dragging');
  loadImage(event.dataTransfer.files[0]);
});
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
document.addEventListener('paste', (event) => {
  if ((!hover && !zone.contains(document.activeElement)) || sending || loading) return;
  const file = [...(event.clipboardData?.items || [])].find((item) => item.type.startsWith('image/'))?.getAsFile();
  if (file) { event.preventDefault(); loadImage(file); }
});
function point(event) {
  const box = canvas.getBoundingClientRect();
  return { x: (event.clientX - box.left) * canvas.width / box.width, y: (event.clientY - box.top) * canvas.height / box.height };
}
function stroke(from, to) {
  ctx.strokeStyle = '#f12536'; ctx.fillStyle = '#f12536';
  ctx.lineWidth = Math.max(4, canvas.width / 250); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
  if (from.x === to.x && from.y === to.y) { ctx.beginPath(); ctx.arc(to.x, to.y, ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); }
}
canvas.addEventListener('pointerdown', (event) => {
  if (sending || loading || pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault(); pointer = event.pointerId; canvas.setPointerCapture(pointer);
  previous = point(event); stroke(previous, previous); changed();
});
canvas.addEventListener('pointermove', (event) => {
  if (pointer !== event.pointerId) return;
  const next = point(event); stroke(previous, next); previous = next;
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, (event) => {
  if (pointer === event.pointerId) { pointer = null; previous = null; }
});
$('reset').addEventListener('click', () => { if (!sending) { restore(); changed(); message('Red marks removed. Your screenshot is unchanged.'); } });
$('replace').addEventListener('click', () => { if (!sending && !loading) input.click(); });
$('remove').addEventListener('click', () => { if (!sending) { clearImage(); message('Image removed.'); } });
description.addEventListener('input', () => { $('character-count').textContent = `${description.value.length.toLocaleString('en')} / 4,000`; changed(); });

async function screenshot() {
  if (!original) return null;
  const output = document.createElement('canvas');
  let scale = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    output.width = Math.max(1, Math.round(canvas.width * scale));
    output.height = Math.max(1, Math.round(canvas.height * scale));
    output.getContext('2d').drawImage(canvas, 0, 0, output.width, output.height);
    const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/jpeg', .86));
    if (!blob) throw new Error('We couldn’t prepare your image. Please try a different screenshot.');
    if (blob.size <= MAX_IMAGE) return blob;
    scale *= .8;
  }
  throw new Error('Please choose a smaller screenshot.');
}
function lock(locked) {
  sending = locked;
  form.querySelectorAll('button, textarea, input').forEach((element) => { element.disabled = locked; });
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || loading || !config?.ready) return;
  if (!description.value.trim()) { message('Tell us what happened before sending your report.', true); description.focus(); return; }
  const token = widgetId !== undefined ? window.turnstile.getResponse(widgetId) : '';
  if (config.turnstileSiteKey && !token) { message('Complete the quick verification before submitting.', true); return; }
  lock(true); message('Saving your report...');
  let attempted = false;
  try {
    const data = new FormData();
    data.set('id', reportId); data.set('description', description.value.trim()); data.set('token', token);
    const image = await screenshot();
    if (image) data.set('image', image, 'screenshot.jpg');
    attempted = true;
    const response = await fetch(`${config.apiBaseUrl}/reports`, { method: 'POST', body: data, signal: AbortSignal.timeout(45_000), credentials: 'omit' });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.id !== reportId) throw new Error(result.error || 'Your report could not be confirmed. Please try again.');
    form.hidden = true; $('success').hidden = false;
    $('receipt').textContent = `Report ${result.id}`; $('success-title').focus();
    message('');
  } catch (error) {
    message(error.name === 'TimeoutError' || error.name === 'TypeError' ? 'We couldn’t confirm your report. Your image and message are still here. Submit again to safely check and retry.' : error.message, true);
    $('status').focus();
  } finally {
    lock(false);
    if (attempted && widgetId !== undefined) window.turnstile.reset(widgetId);
  }
});
$('another').addEventListener('click', () => {
  form.reset(); clearImage(); changed(); $('character-count').textContent = '0 / 4,000';
  $('success').hidden = true; form.hidden = false; zone.focus();
});
async function init() {
  submit.disabled = true;
  try {
    config = await (await fetch('./config.json', { cache: 'no-store' })).json();
    config.apiBaseUrl = (config.apiBaseUrl || '').replace(/\/$/, '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    config.ready = Boolean(config.apiBaseUrl) || local;
    if (!config.ready) { $('environment').hidden = false; $('environment').textContent = 'Reports are not open yet. Please check back soon.'; return; }
    if (config.apiBaseUrl && !config.apiBaseUrl.startsWith('https://') && !local) throw new Error('Invalid report service.');
    if (local) { $('environment').hidden = false; $('environment').textContent = 'Local preview. Submitted reports are saved on this computer.'; }
    if (config.turnstileSiteKey) {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
      widgetId = window.turnstile.render('#verification', { sitekey: config.turnstileSiteKey, action: 'report' });
    }
    submit.disabled = false;
  } catch {
    config = { ready: false }; message('Reports are temporarily unavailable. Please try again later.', true);
  }
}
init();
