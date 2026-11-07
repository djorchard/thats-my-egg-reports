const $ = (id) => document.getElementById(id);
let key = '', base = '', cursor = 0, busy = false, session = 0;
const urls = new Set();
function status(text) { $('inbox-status').textContent = text; }
async function request(path, requestKey) {
  const response = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${requestKey}` }, credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(response.status === 401 ? 'That access key was not accepted.' : 'Couldn’t load reports. Please try again.');
  return response;
}
async function load() {
  if (busy) return;
  busy = true; $('refresh').disabled = true; $('more').disabled = true;
  const current = session, requestKey = key;
  status('Checking for reports...');
  try {
    const data = await (await request(`/reports?since=${cursor}`, requestKey)).json();
    if (current !== session) return;
    $('access-form').hidden = true; $('inbox-controls').hidden = false;
    for (const report of data.reports) {
      const article = document.createElement('article'); article.className = 'report-card';
      const meta = document.createElement('div'); meta.className = 'report-meta';
      meta.textContent = `${new Date(report.created_at).toLocaleString()} · ${report.id}`;
      const description = document.createElement('p'); description.textContent = report.description;
      article.append(meta, description);
      if (report.hasImage) {
        const button = document.createElement('button'); button.className = 'text-button'; button.textContent = 'View screenshot';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const imageResponse = await request(`/reports/${report.id}/image`, requestKey);
            const blob = await imageResponse.blob();
            if (current !== session) return;
            const url = URL.createObjectURL(blob); urls.add(url);
            const image = document.createElement('img'); image.src = url; image.alt = 'Player screenshot with any red highlights';
            const link = document.createElement('a'); link.href = url; link.download = `${report.id}.jpg`; link.className = 'download-link'; link.textContent = 'Download screenshot';
            article.append(image, link); button.remove();
          } catch (error) { if (current === session) status(error.message); button.disabled = false; }
        });
        article.append(button);
      }
      $('reports').prepend(article);
    }
    cursor = data.nextCursor;
    $('more').hidden = data.reports.length < 50;
    status(data.reports.length ? `${data.reports.length} report${data.reports.length === 1 ? '' : 's'} loaded.` : cursor ? 'You’re all caught up.' : 'No reports yet.');
  } catch (error) { if (current === session) status(error.message); }
  finally { busy = false; $('refresh').disabled = false; $('more').disabled = false; }
}
$('access-form').addEventListener('submit', async (event) => {
  event.preventDefault(); if (busy) return;
  key = $('access-key').value; $('access-key').value = '';
  try {
    const config = await (await fetch('./config.json', { cache: 'no-store' })).json();
    base = (config.apiBaseUrl || '').replace(/\/$/, '');
    if (!base && !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) throw new Error('The report service has not been connected yet.');
    await load();
  } catch (error) { status(error.message); }
});
$('refresh').addEventListener('click', load); $('more').addEventListener('click', load);
$('logout').addEventListener('click', () => {
  session++; key = ''; cursor = 0; urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear();
  $('reports').replaceChildren(); $('inbox-controls').hidden = true; $('more').hidden = true; $('access-form').hidden = false;
  status('Inbox locked.'); $('access-key').focus();
});
