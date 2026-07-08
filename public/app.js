const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function handle401(status) {
  // Session expired or logged out elsewhere — drop back to the login screen.
  if (status === 401 && currentUser) {
    currentUser = null;
    showLogin();
  }
}

const api = {
  async get(url) {
    const r = await fetch(url);
    if (!r.ok) {
      handle401(r.status);
      throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    }
    return r.json();
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      handle401(r.status);
      const err = new Error(data.error || r.statusText);
      err.status = r.status;
      if (data.missingFiles) err.missingFiles = data.missingFiles;
      throw err;
    }
    return data;
  },
};

let currentUser = null;

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${u[i]}`;
}

let projects = [];
let statsTimer = null;
const projMem = {}; // projectId -> latest total memBytes
let memTotal = 0; // host RAM in bytes

// Stable-ish colors for project memory segments (free = gray, separate).
const MEM_COLORS = ['#3b6fd4', '#d9922b', '#2ea86a', '#d9534f', '#8b5cf6', '#1fb6a6', '#d9599b', '#2f9fd0'];

// ---------- System bar ----------
async function loadSystem() {
  try {
    const s = await api.get('/api/system');
    if (!s.dockerAvailable) {
      $('#system').innerHTML = `<span style="color:var(--red)">⚠ Docker not available</span>`;
      return;
    }
    memTotal = s.memTotal || memTotal;
    $('#system').innerHTML = `
      <span>Docker <b>${s.version || '?'}</b></span>
      <span>CPUs <b>${s.ncpu ?? '?'}</b></span>
      <span>RAM <b>${fmtBytes(s.memTotal)}</b></span>
      <span>Containers <b>${s.containersRunning}/${s.containersTotal}</b></span>`;
    renderMemoryBar();
  } catch { /* ignore */ }
}

// ---------- Memory overview bar (per-project usage + free) ----------
function renderMemoryBar() {
  const el = $('#membar');
  if (!el || !memTotal) { if (el) el.hidden = true; return; }

  const used = projects
    .map((p, i) => ({ name: p.name, mem: projMem[p.id] || 0, color: MEM_COLORS[i % MEM_COLORS.length] }))
    .filter((u) => u.mem > 0)
    .sort((a, b) => b.mem - a.mem);
  const sumUsed = used.reduce((a, u) => a + u.mem, 0);
  const free = Math.max(0, memTotal - sumUsed);

  const seg = (label, bytes, color, cls = '') =>
    `<div class="mseg ${cls}" style="width:${((bytes / memTotal) * 100).toFixed(3)}%${color ? `;background:${color}` : ''}"
      title="${esc(label)} — ${fmtBytes(bytes)}"><span>${esc(label)} · ${fmtBytes(bytes)}</span></div>`;

  el.querySelector('.membar-track').innerHTML =
    used.map((u) => seg(u.name, u.mem, u.color)).join('') + seg('Free', free, null, 'free');
  el.querySelector('.membar-cap').innerHTML =
    `Memory · <b>${fmtBytes(sumUsed)}</b> used by ${used.length} project${used.length === 1 ? '' : 's'} · <b>${fmtBytes(free)}</b> free of ${fmtBytes(memTotal)}`;
  el.hidden = false;
}

// ---------- Storage pie (per running container) ----------
function nameForStorageKey(key) {
  const p = projects.find((p) => p.slug === key);
  return p ? p.name : key;
}

async function loadStorage() {
  const card = $('#storagecard');
  if (!card) return;
  let groups;
  try {
    groups = (await api.get('/api/system/storage')).groups || [];
  } catch {
    return;
  }
  const running = groups.filter((g) => g.rootfsBytes > 0);
  if (!running.length) {
    card.hidden = true;
    return;
  }
  const total = running.reduce((a, g) => a + g.rootfsBytes, 0);
  let acc = 0;
  const stops = [];
  const legend = [];
  running.forEach((g, i) => {
    const color = MEM_COLORS[i % MEM_COLORS.length];
    const start = (acc / total) * 100;
    acc += g.rootfsBytes;
    const end = (acc / total) * 100;
    stops.push(`${color} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    const name = nameForStorageKey(g.key);
    const pct = ((g.rootfsBytes / total) * 100).toFixed(0);
    legend.push(`<div class="lg">
      <span class="sw" style="background:${color}"></span>
      <span class="lg-name" title="${esc(name)} · ${g.containers} container${g.containers > 1 ? 's' : ''}">${esc(name)}</span>
      <span class="lg-val">${fmtBytes(g.rootfsBytes)} · ${pct}%</span>
    </div>`);
  });
  $('#storage-pie').style.background = `conic-gradient(${stops.join(',')})`;
  $('#storage-legend').innerHTML = legend.join('');
  $('#storage-total').textContent = `${fmtBytes(total)} across ${running.length} app${running.length > 1 ? 's' : ''}`;
  card.hidden = false;
}

// ---------- Project list ----------
async function loadProjects() {
  try {
    projects = await api.get('/api/projects');
  } catch (e) {
    projects = [];
  }
  renderProjects();
}

function renderProjects() {
  const grid = $('#projects');
  $('#empty').hidden = projects.length > 0;
  grid.innerHTML = projects.map(projectCard).join('');
  const c = $('#tab-count-docker');
  if (c) c.textContent = projects.length || '';
}

// ---------- Top-level tabs (Docker projects / Static sites) ----------
function switchMainTab(name) {
  $$('.mtab').forEach((t) => t.classList.toggle('active', t.dataset.mtab === name));
  $('#pane-docker').hidden = name !== 'docker';
  $('#pane-static').hidden = name !== 'static';
}
$$('.mtab').forEach((t) => t.addEventListener('click', () => switchMainTab(t.dataset.mtab)));

function projectCard(p) {
  return `
  <div class="project" data-id="${p.id}">
    <div class="project-top">
      <div>
        <h3 class="project-name">${esc(p.name)}</h3>
        <div class="project-git">${esc(p.gitUrl)}${p.branch ? ' @ ' + esc(p.branch) : ''}</div>
        <div class="ports-line">${portLinks(p.ports)}</div>
        ${routeLinks(p.routes)}
      </div>
      <span class="badge ${p.status}">${p.status}</span>
    </div>
    <div class="meters" data-meters>
      <div class="meter">
        <div class="meter-head"><span>CPU</span><span data-cpu>—</span></div>
        <div class="bar"><span data-cpu-bar style="width:0"></span></div>
      </div>
      <div class="meter">
        <div class="meter-head"><span>Memory</span><span data-mem>—</span></div>
        <div class="bar mem"><span data-mem-bar style="width:0"></span></div>
      </div>
    </div>
    <div class="containers" data-containers></div>
    <div class="actions">
      ${p.status === 'stopped'
        ? '<button class="sm primary" data-act="start">▶ Start</button>'
        : '<button class="sm ghost" data-act="stop">■ Stop</button>'}
      <button class="sm ghost" data-act="restart">Restart</button>
      <button class="sm ghost" data-act="logs">Logs</button>
      <button class="sm ghost" data-act="shell">Shell</button>
      <div class="menu-wrap">
        <button class="sm ghost menu-btn" data-menu aria-label="More actions">⋯</button>
        <div class="menu" hidden>
          <button data-act="env">Environment</button>
          <button data-act="files">Files</button>
          <button data-act="compose">Compose override</button>
          <button data-act="routes">Proxy routes</button>
          <button data-act="branch">Switch branch</button>
          <div class="menu-sep"></div>
          <button data-act="rebuild">Rebuild image</button>
          <button data-act="redeploy">Pull &amp; Rebuild</button>
          <div class="menu-sep"></div>
          <button data-act="delete" class="danger-item">Delete project</button>
        </div>
      </div>
    </div>
    <div class="msg" data-msg></div>
    ${renderOplog(p.id)}
  </div>`;
}

// ---------- Live operation log (docker build/start/stop/… output) ----------
const opLogs = {}; // projectId -> { action, text, running, ok }
const OP_LABELS = { start: 'Starting', stop: 'Stopping', restart: 'Restarting', rebuild: 'Rebuilding', redeploy: 'Pull & Rebuild' };

function renderOplog(id) {
  const op = opLogs[id];
  if (!op) return '';
  const icon = op.running ? '<span class="spin">↻</span>' : op.ok ? '✓' : '✗';
  const cls = op.running ? 'running' : op.ok ? 'ok' : 'err';
  return `<div class="oplog ${cls}">
      <div class="oplog-head">
        <span>${icon} ${esc(op.action)}${op.running ? '…' : op.ok ? ' — done' : ' — failed'}</span>
        <button class="oplog-x" data-oplog-close="${id}" title="Hide log">×</button>
      </div>
      <pre class="oplog-body" data-oplog>${esc(op.text)}</pre>
    </div>`;
}

function appendOpLog(id, chunk) {
  const op = opLogs[id];
  if (!op) return;
  chunk = chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // strip ANSI escapes
  op.text += chunk;
  if (op.text.length > 200000) op.text = op.text.slice(-200000);
  const el = document.querySelector(`.project[data-id="${id}"] [data-oplog]`);
  if (el) {
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
    el.textContent = op.text;
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
}

// Unique host ports from "host:container" strings (compose lists IPv4+IPv6).
function hostPorts(ports) {
  return [...new Set((ports || []).map((p) => p.split(':')[0]))];
}

// Render published host ports as clickable links (assumes http on current host).
function portLinks(ports) {
  if (!ports || !ports.length) return '';
  const host = location.hostname || 'localhost';
  return (
    '<span class="ports-label">Ports:</span> ' +
    ports
      .map((p) => `<a class="port" href="http://${host}:${esc(p)}" target="_blank" rel="noopener">:${esc(p)} ↗</a>`)
      .join(' ')
  );
}

// Show configured reverse-proxy routes as clickable AppHub links.
function routeLinks(routes) {
  if (!routes || !routes.length) return '';
  return (
    '<div class="ports-line"><span class="ports-label">Proxy:</span> ' +
    routes
      .map((r) => `<a class="route" href="${esc(r.path)}/" target="_blank" rel="noopener">${esc(r.path)} → :${esc(r.port)} ↗</a>`)
      .join(' ') +
    '</div>'
  );
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Stats polling ----------
async function refreshStats() {
  if (!$('#auto-refresh').checked) return;
  await Promise.all(projects.map(updateProjectStats));
  renderMemoryBar();
}

async function updateProjectStats(p) {
  const card = $(`.project[data-id="${p.id}"]`);
  if (!card) return;
  let data;
  try {
    data = await api.get(`/api/projects/${p.id}/stats`);
  } catch {
    return;
  }
  projMem[p.id] = data.totals.memBytes; // feed the memory overview bar
  const ncpu = window.__ncpu || 1;
  const cpuPct = Math.min(100, data.totals.cpu / ncpu); // normalize to host cores
  $('[data-cpu]', card).textContent = data.totals.cpu.toFixed(1) + '%';
  $('[data-cpu-bar]', card).style.width = cpuPct + '%';
  $('[data-mem]', card).textContent =
    fmtBytes(data.totals.memBytes) + ` (${data.totals.memPerc.toFixed(1)}%)`;
  $('[data-mem-bar]', card).style.width = Math.min(100, data.totals.memPerc) + '%';

  $('[data-containers]', card).innerHTML = data.containers.length
    ? data.containers
        .map(
          (c) => `<div class="ctr"><span class="dot running"></span>
            <span class="svc">${esc(c.service)}${hostPorts(c.ports).length ? ` <span class="ports">:${esc(hostPorts(c.ports).join(', :'))}</span>` : ''}</span>
            <span>${c.cpu.toFixed(1)}% · ${fmtBytes(c.memBytes)}</span></div>`
        )
        .join('')
    : `<div class="ctr" style="color:var(--muted)">No running containers</div>`;
}

// ---------- Overflow menu (⋯) on project cards ----------
document.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-menu]');
  const openMenu = menuBtn ? menuBtn.parentElement.querySelector('.menu') : null;
  // Close every menu except the one we're toggling open.
  $$('.menu').forEach((m) => { if (m !== openMenu) m.hidden = true; });
  if (menuBtn) openMenu.hidden = !openMenu.hidden;
});

// ---------- Actions ----------
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  // A menu item was chosen — collapse the menu it lives in.
  const inMenu = btn.closest('.menu');
  if (inMenu) inMenu.hidden = true;
  const card = btn.closest('.project');
  const id = card.dataset.id;
  const project = projects.find((p) => p.id === id);
  const act = btn.dataset.act;
  const msg = $('[data-msg]', card);

  if (act === 'env') return openEnv(project);
  if (act === 'files') return openFiles(project);
  if (act === 'compose') return openCompose(project);
  if (act === 'routes') return openRoutes(project);
  if (act === 'branch') return openBranch(project);
  if (act === 'shell') return openShell(project);
  if (act === 'logs') return openLogs(project);

  if (act === 'delete') {
    if (!confirm(`Delete "${project.name}"? This runs "compose down" and removes the cloned repo.`)) return;
  }

  const buttons = $$('button', card);
  buttons.forEach((b) => (b.disabled = true));
  msg.className = 'msg';
  msg.textContent = `Running ${act}…`;

  // Live-tail the docker output for long-running operations, in-card.
  const streaming = ['start', 'stop', 'restart', 'rebuild', 'redeploy'].includes(act);
  let es = null;
  if (streaming) {
    opLogs[id] = { action: OP_LABELS[act] || act, text: '', running: true, ok: false };
    card.querySelector('.oplog')?.remove();
    card.insertAdjacentHTML('beforeend', renderOplog(id)); // inject; keeps button/msg refs valid
    es = new EventSource(`/api/projects/${id}/op-stream`);
    es.addEventListener('data', (e) => appendOpLog(id, JSON.parse(e.data)));
    es.addEventListener('end', () => es.close());
  }

  try {
    if (act === 'delete') {
      await api.send('DELETE', `/api/projects/${id}`);
      await loadProjects();
      loadStorage();
      return;
    }
    const res = await api.send('POST', `/api/projects/${id}/${act}`);
    if (opLogs[id]) { opLogs[id].running = false; opLogs[id].ok = true; }
    await loadProjects();
    await loadSystem();
    loadStorage();
  } catch (err) {
    if (opLogs[id]) { opLogs[id].running = false; opLogs[id].ok = false; appendOpLog(id, '\n' + err.message + '\n'); }
    msg.className = 'msg err';
    msg.textContent = err.message;
    buttons.forEach((b) => (b.disabled = false));
    // Missing bind-mount files → open Files so the user can add them.
    if (err.missingFiles) openFiles(project, err.missingFiles);
    renderProjects();
  } finally {
    if (es) es.close();
  }
});

// Dismiss an operation log panel.
document.addEventListener('click', (e) => {
  const x = e.target.closest('[data-oplog-close]');
  if (!x) return;
  delete opLogs[x.dataset.oplogClose];
  renderProjects();
});

// ---------- New project (Docker Compose) ----------
function openNewProject() {
  $('#new-form').reset();
  $('#new-msg').textContent = '';
  $('#new-msg').className = 'msg';
  $('#new-modal').hidden = false;
  $('#f-name').focus();
}
$('#open-new').addEventListener('click', openNewProject);

$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#new-msg');
  const btn = $('#create-btn');
  const body = {
    name: $('#f-name').value.trim(),
    gitUrl: $('#f-git').value.trim(),
    branch: $('#f-branch').value.trim() || undefined,
  };
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Cloning…';
  try {
    await api.send('POST', '/api/projects', body);
    await loadProjects();
    $('#new-modal').hidden = true;
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Static sites (served directly, no Docker) ----------
let statics = [];

function slugPreview(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function loadStatics() {
  try {
    statics = await api.get('/api/static-sites');
  } catch {
    statics = [];
  }
  renderStatics();
}

function renderStatics() {
  const grid = $('#statics');
  $('#statics-empty').hidden = statics.length > 0;
  grid.innerHTML = statics.map(staticCard).join('');
  const c = $('#tab-count-static');
  if (c) c.textContent = statics.length || '';
}

function staticCard(s) {
  const pub = s.publishDir && s.publishDir !== '.' ? s.publishDir : '(root)';
  return `
  <div class="project static-card" data-sid="${s.id}">
    <div class="project-top">
      <div>
        <h3 class="project-name">${esc(s.name)}</h3>
        <div class="project-git">${s.source === 'git' ? esc(s.gitUrl) + (s.branch ? ' @ ' + esc(s.branch) : '') : 'uploaded files'}</div>
        <div class="ports-line">
          <span class="ports-label">URL:</span>
          <a class="route" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.url)} ↗</a>
        </div>
        <div class="ports-line"><span class="ports-label">Publish:</span> <code>${esc(pub)}</code></div>
      </div>
      <span class="badge running">live</span>
    </div>
    <div class="actions">
      <button class="sm primary" data-sact="open" title="Open the site">Open ↗</button>
      <button class="sm ghost" data-sact="files">Files</button>
      ${s.source === 'git' ? '<button class="sm ghost" data-sact="pull">Pull latest</button>' : ''}
      <div class="menu-wrap">
        <button class="sm ghost menu-btn" data-menu aria-label="More actions">⋯</button>
        <div class="menu" hidden>
          <button data-sact="publish">Set publish dir</button>
          <button data-sact="copy">Copy URL</button>
          <div class="menu-sep"></div>
          <button data-sact="delete" class="danger-item">Delete site</button>
        </div>
      </div>
    </div>
    <div class="msg" data-smsg></div>
  </div>`;
}

function openNewStatic() {
  $('#new-static-form').reset();
  $('#new-static-msg').textContent = '';
  $('#new-static-msg').className = 'msg';
  staticFormSync();
  $('#s-url-preview').innerHTML = 'URL: <code>/_static_/…</code>';
  $('#new-static-modal').hidden = false;
  $('#s-name').focus();
}
function staticFormSync() {
  const git = $('#s-source').value === 'git';
  $('#s-git-wrap').hidden = !git;
  $('#s-branch-wrap').hidden = !git;
  $('#create-static-btn').textContent = git ? 'Clone & serve' : 'Create';
  $('#s-hint').innerHTML = git
    ? 'Clones the repo and serves it directly (no Docker). Leave publish dir blank to auto-detect (public/dist/_site…).'
    : 'Creates an empty site — after that, upload a <b>zip</b> or drop HTML files in <b>Files</b>.';
}
$('#open-new-static').addEventListener('click', openNewStatic);
$('#s-source').addEventListener('change', staticFormSync);
$('#s-name').addEventListener('input', () => {
  const slug = slugPreview($('#s-name').value);
  $('#s-url-preview').innerHTML = `URL: <code>/_static_/${esc(slug) || '…'}/</code>`;
});

$('#new-static-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#new-static-msg');
  const btn = $('#create-static-btn');
  const source = $('#s-source').value;
  const body = {
    name: $('#s-name').value.trim(),
    source,
    gitUrl: source === 'git' ? $('#s-git').value.trim() : undefined,
    branch: source === 'git' ? $('#s-branch').value.trim() || undefined : undefined,
    publishDir: $('#s-pub').value.trim() || undefined,
  };
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = source === 'git' ? 'Cloning…' : 'Creating…';
  try {
    const created = await api.send('POST', '/api/static-sites', body);
    await loadStatics();
    $('#new-static-modal').hidden = true;
    // Uploaded sites start empty — jump into Files so they can add content.
    if (source === 'upload') openFiles(created, null, '/api/static-sites');
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// Static-site card actions.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-sact]');
  if (!btn) return;
  const inMenu = btn.closest('.menu');
  if (inMenu) inMenu.hidden = true;
  const card = btn.closest('.static-card');
  const site = statics.find((s) => s.id === card.dataset.sid);
  if (!site) return;
  const act = btn.dataset.sact;
  const msg = $('[data-smsg]', card);
  msg.className = 'msg';
  msg.textContent = '';

  if (act === 'open') return window.open(site.url, '_blank', 'noopener');
  if (act === 'files') return openFiles(site, null, '/api/static-sites');
  if (act === 'copy') {
    const url = location.origin + site.url;
    try { await navigator.clipboard.writeText(url); msg.className = 'msg ok'; msg.textContent = 'Copied ' + url; }
    catch { msg.className = 'msg err'; msg.textContent = url; }
    return;
  }
  if (act === 'publish') {
    const pub = prompt('Publish directory (folder containing index.html; "." = site root):', site.publishDir || '.');
    if (pub == null) return;
    try {
      await api.send('PUT', `/api/static-sites/${site.id}/publish`, { publishDir: pub.trim() || '.' });
      await loadStatics();
    } catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    return;
  }
  if (act === 'pull') {
    msg.textContent = 'Pulling…';
    try { await api.send('POST', `/api/static-sites/${site.id}/pull`); msg.className = 'msg ok'; msg.textContent = 'Pulled latest.'; }
    catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    return;
  }
  if (act === 'delete') {
    if (!confirm(`Delete "${site.name}"? This removes its files and takes ${site.url} offline.`)) return;
    try { await api.send('DELETE', `/api/static-sites/${site.id}`); await loadStatics(); }
    catch (err) { msg.className = 'msg err'; msg.textContent = err.message; }
    return;
  }
});

// ---------- Env modal ----------
let envProject = null;
async function openEnv(project) {
  envProject = project;
  $('#env-title').textContent = project.name;
  $('#env-msg').textContent = '';
  const data = await api.get(`/api/projects/${project.id}/env`);
  $('#env-textarea').value = data.raw;
  renderEnvRows(data.pairs);
  switchTab('table');
  $('#env-modal').hidden = false;
}

function renderEnvRows(pairs) {
  $('#env-rows').innerHTML = pairs.map(envRow).join('') || envRow({ key: '', value: '' });
}
function envRow(p) {
  return `<div class="env-row">
    <input class="k" placeholder="KEY" value="${esc(p.key)}" />
    <input class="v" placeholder="value" value="${esc(p.value)}" />
    <button type="button" data-del>✕</button>
  </div>`;
}

$('#env-add').addEventListener('click', () => {
  $('#env-rows').insertAdjacentHTML('beforeend', envRow({ key: '', value: '' }));
});
$('#env-rows').addEventListener('click', (e) => {
  if (e.target.closest('[data-del]')) e.target.closest('.env-row').remove();
});

$$('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  $$('.tab[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('#env-table').hidden = name !== 'table';
  $('#env-raw').hidden = name !== 'raw';
  // sync form -> raw when switching to raw
  if (name === 'raw') $('#env-textarea').value = pairsToRaw();
  if (name === 'table') renderEnvRows(rawToPairs($('#env-textarea').value));
}

function currentPairs() {
  return $$('.env-row').map((r) => ({
    key: $('.k', r).value.trim(),
    value: $('.v', r).value,
  })).filter((p) => p.key);
}
function pairsToRaw() {
  return currentPairs().map((p) => `${p.key}=${p.value}`).join('\n') + '\n';
}
function rawToPairs(raw) {
  return raw.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() }; });
}

$('#env-save').addEventListener('click', async () => {
  const msg = $('#env-msg');
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  const isRaw = !$('#env-raw').hidden;
  const body = isRaw ? { raw: $('#env-textarea').value } : { pairs: currentPairs() };
  try {
    await api.send('PUT', `/api/projects/${envProject.id}/env`, body);
    msg.className = 'msg ok';
    msg.textContent = 'Saved. Restart the project to apply.';
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  }
});

// ---------- Secure env: picker (insert reference into the Env editor) ----------
$('#env-secure').addEventListener('click', openSecurePicker);

async function openSecurePicker() {
  const list = $('#secure-pick-list');
  list.innerHTML = '<div class="muted" style="padding:8px 0">Loading…</div>';
  $('#secure-pick-empty').hidden = true;
  $('#secure-pick-modal').hidden = false;
  try {
    const d = await api.get('/api/secure-env');
    const scopes = d.scopes || {};
    const names = Object.keys(scopes).sort();
    if (!names.length) {
      list.innerHTML = '';
      $('#secure-pick-empty').hidden = false;
      return;
    }
    list.innerHTML = names.map((scope) => `
      <div class="secure-scope">
        <div class="secure-scope-name">${esc(scope)}</div>
        ${scopes[scope].map((e) => `
          <div class="secure-row">
            <code class="secure-ref">@secure:${esc(scope)}/${esc(e.key)}</code>
            <button class="sm primary" data-pick data-scope="${esc(scope)}" data-key="${esc(e.key)}">Insert</button>
          </div>`).join('')}
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="msg err" style="padding:8px 0">${esc(e.message)}</div>`;
  }
}

$('#secure-pick-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pick]');
  if (!btn) return;
  const scope = btn.dataset.scope;
  const key = btn.dataset.key;
  // Add an env row referencing the secret (key defaults to the secret's name).
  $('#env-rows').insertAdjacentHTML('beforeend', envRow({ key, value: `@secure:${scope}/${key}` }));
  $('#secure-pick-modal').hidden = true;
  switchTab('table');
});

// ---------- Secure env: admin management modal ----------
async function openSecure() {
  $('#secure-msg').textContent = '';
  $('#secure-msg').className = 'msg';
  $('#secure-form').reset();
  $('#se-value').type = 'password';
  $('#se-show').textContent = 'Show';
  $('#secure-modal').hidden = false;
  await loadSecure();
}

const secureReveal = {}; // "scope/key" -> revealed value cache

async function loadSecure() {
  try {
    const d = await api.get('/api/secure-env');
    const scopes = d.scopes || {};
    const names = Object.keys(scopes).sort();
    $('#se-scopes').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
    $('#secure-list').innerHTML = names.length
      ? names.map((scope) => `
        <div class="secure-scope">
          <div class="secure-scope-name">${esc(scope)}
            <button class="fdel" data-delscope="${esc(scope)}" title="Delete entire scope">✕ scope</button>
          </div>
          ${scopes[scope].map((e) => `
            <div class="secure-row" data-scope="${esc(scope)}" data-key="${esc(e.key)}">
              <code class="secure-ref">${esc(e.key)}</code>
              <span class="secure-val" data-val>${e.value != null ? '••••••••' : ''}</span>
              <span class="secure-meta">${e.updatedBy ? 'by ' + esc(e.updatedBy) : ''}</span>
              <button class="sm ghost" data-reveal title="Reveal / hide">👁</button>
              <button class="fdel" data-delsecret title="Delete">✕</button>
            </div>`).join('')}
        </div>`).join('')
      : '<div class="muted" style="padding:8px 0">No secrets yet. Add one below.</div>';
    // stash values for reveal (admin response includes them)
    for (const scope of names) for (const e of scopes[scope]) {
      if (e.value != null) secureReveal[`${scope}/${e.key}`] = e.value;
    }
  } catch (e) {
    $('#secure-list').innerHTML = `<div class="msg err" style="padding:8px 0">${esc(e.message)}</div>`;
  }
}

bindPwToggle('#se-show', '#se-value');

$('#secure-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#secure-msg');
  const scope = $('#se-scope').value.trim();
  const key = $('#se-key').value.trim();
  const value = $('#se-value').value;
  const fail = (t) => { msg.className = 'msg err'; msg.textContent = t; };
  if (!scope || !key) return fail('Scope and key are required.');
  if (!/^[A-Za-z0-9._-]+$/.test(scope) || !/^[A-Za-z0-9._-]+$/.test(key)) {
    return fail('Scope/key: letters, numbers, . _ - only.');
  }
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    const r = await api.send('POST', '/api/secure-env', { scope, key, value });
    msg.className = 'msg ok';
    msg.textContent = `Saved. Reference: ${r.ref}`;
    $('#se-key').value = '';
    $('#se-value').value = '';
    $('#se-value').type = 'password';
    $('#se-show').textContent = 'Show';
    await loadSecure();
  } catch (err) {
    fail(err.message);
  }
});

$('#secure-list').addEventListener('click', async (e) => {
  const reveal = e.target.closest('[data-reveal]');
  const delSecret = e.target.closest('[data-delsecret]');
  const delScope = e.target.closest('[data-delscope]');
  if (reveal) {
    const row = reveal.closest('.secure-row');
    const valEl = $('[data-val]', row);
    const k = `${row.dataset.scope}/${row.dataset.key}`;
    const masked = valEl.textContent.startsWith('•') || valEl.textContent === '';
    valEl.textContent = masked ? (secureReveal[k] ?? '(hidden)') : '••••••••';
    valEl.classList.toggle('shown', masked);
  } else if (delSecret) {
    const row = delSecret.closest('.secure-row');
    if (!confirm(`Delete secret ${row.dataset.scope}/${row.dataset.key}?`)) return;
    try {
      await api.send('DELETE', `/api/secure-env?scope=${encodeURIComponent(row.dataset.scope)}&key=${encodeURIComponent(row.dataset.key)}`);
      await loadSecure();
    } catch (er) { $('#secure-msg').className = 'msg err'; $('#secure-msg').textContent = er.message; }
  } else if (delScope) {
    const scope = delScope.dataset.delscope;
    if (!confirm(`Delete the ENTIRE "${scope}" scope and all its secrets?`)) return;
    try {
      await api.send('DELETE', `/api/secure-env/scope?scope=${encodeURIComponent(scope)}`);
      await loadSecure();
    } catch (er) { $('#secure-msg').className = 'msg err'; $('#secure-msg').textContent = er.message; }
  }
});

// ---------- Files manager modal ----------
// Reused by both Docker projects and static sites; filesApiBase selects which
// REST collection the file endpoints live under.
let filesProject = null;
let filesApiBase = '/api/projects';
let filesCurrent = null; // path of the file open in the editor

async function openFiles(project, missing, apiBase = '/api/projects') {
  filesProject = project;
  filesApiBase = apiBase;
  filesCurrent = null;
  $('#files-title').textContent = project.name;
  $('#files-msg').textContent = '';
  $('#files-msg').className = 'msg';
  $('#files-path').textContent = 'Select a file to view or edit.';
  $('#files-textarea').hidden = true;
  $('#files-binary').hidden = true;
  $('#files-save').hidden = true;

  // If opened because of a failed start, show which files are missing.
  const banner = $('#files-banner');
  if (missing && missing.length) {
    banner.hidden = false;
    banner.innerHTML =
      '⚠ Missing files the compose expects (create them here): ' +
      missing.map((m) => `<button class="link-file" data-newfile="${esc(m.rel)}">${esc(m.rel)}</button>`).join(', ');
  } else {
    banner.hidden = true;
    banner.innerHTML = '';
  }

  $('#files-modal').hidden = false;
  await loadFilesList();
}

async function loadFilesList() {
  try {
    const d = await api.get(`${filesApiBase}/${filesProject.id}/files`);
    const rows = d.files.filter((f) => !f.dir);
    const dirs = d.files.filter((f) => f.dir);
    $('#files-list').innerHTML =
      (dirs.map((f) => `<div class="file-row is-dir"><span class="fname">${esc(f.path)}/</span><button class="fdel" data-del="${esc(f.path)}" title="Delete">✕</button></div>`).join('')) +
      (rows.length
        ? rows.map((f) => `<div class="file-row${f.path === filesCurrent ? ' active' : ''}" data-open="${esc(f.path)}">
            <span class="fname">${esc(f.path)}</span>
            <span class="fmeta">${fmtBytes(f.size)}</span>
            <button class="fdel" data-del="${esc(f.path)}" title="Delete">✕</button>
          </div>`).join('')
        : '<div class="muted" style="padding:10px">No files.</div>');
  } catch (e) {
    $('#files-list').innerHTML = `<div class="msg err" style="padding:10px">${esc(e.message)}</div>`;
  }
}

async function openFileInEditor(path) {
  try {
    const d = await api.get(`${filesApiBase}/${filesProject.id}/file?path=${encodeURIComponent(path)}`);
    filesCurrent = path;
    $('#files-path').textContent = `${path} · ${fmtBytes(d.size)} · mode ${d.mode}`;
    if (d.binary) {
      $('#files-textarea').hidden = true;
      $('#files-save').hidden = true;
      $('#files-binary').hidden = false;
      $('#files-binary').textContent = 'Binary file — cannot edit as text. Use Upload to replace it, or Delete.';
    } else {
      $('#files-binary').hidden = true;
      $('#files-textarea').hidden = false;
      $('#files-textarea').value = d.content;
      $('#files-save').hidden = false;
    }
    loadFilesList();
  } catch (e) {
    $('#files-msg').className = 'msg err';
    $('#files-msg').textContent = e.message;
  }
}

async function saveCurrentFile() {
  if (!filesCurrent) return;
  const msg = $('#files-msg');
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  try {
    await api.send('PUT', `${filesApiBase}/${filesProject.id}/file`, {
      path: filesCurrent,
      content: $('#files-textarea').value,
    });
    msg.className = 'msg ok';
    msg.textContent = filesApiBase.includes('static')
      ? 'Saved. Live immediately.'
      : 'Saved (mode 0644). Restart/rebuild to apply.';
    await loadFilesList();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
}

async function newFile(defaultName) {
  const name = prompt('New file path (relative to the project):', defaultName || '');
  if (!name) return;
  try {
    await api.send('PUT', `${filesApiBase}/${filesProject.id}/file`, { path: name.trim(), content: '' });
    $('#files-banner').hidden = true;
    await loadFilesList();
    await openFileInEditor(name.trim());
  } catch (e) {
    $('#files-msg').className = 'msg err';
    $('#files-msg').textContent = e.message;
  }
}

$('#files-save').addEventListener('click', saveCurrentFile);
$('#files-new').addEventListener('click', () => newFile());
$('#files-zip-btn').addEventListener('click', () => $('#files-zip').click());
$('#files-zip').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $('#files-msg');
  msg.className = 'msg';
  msg.textContent = 'Uploading & extracting…';
  try {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    await api.send('POST', `${filesApiBase}/${filesProject.id}/unzip`, { contentBase64: b64 });
    msg.className = 'msg ok';
    msg.textContent = `Extracted ${file.name}.`;
    $('#files-banner').hidden = true;
    await loadFilesList();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    e.target.value = '';
  }
});
$('#files-upload-btn').addEventListener('click', () => $('#files-upload').click());
$('#files-upload').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const name = prompt('Save uploaded file as (path relative to project):', file.name);
  if (!name) { e.target.value = ''; return; }
  const msg = $('#files-msg');
  msg.className = 'msg';
  msg.textContent = 'Uploading…';
  try {
    const b64 = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });
    await api.send('PUT', `${filesApiBase}/${filesProject.id}/file`, { path: name.trim(), contentBase64: b64 });
    msg.className = 'msg ok';
    msg.textContent = `Uploaded ${name.trim()}.`;
    $('#files-banner').hidden = true;
    await loadFilesList();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    e.target.value = '';
  }
});

// Delegated clicks inside the Files modal: open / delete / create-missing.
$('#files-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  const open = e.target.closest('[data-open]');
  if (del) {
    e.stopPropagation();
    if (!confirm(`Delete "${del.dataset.del}"?`)) return;
    try {
      await api.send('DELETE', `${filesApiBase}/${filesProject.id}/file?path=${encodeURIComponent(del.dataset.del)}`);
      if (filesCurrent === del.dataset.del) { filesCurrent = null; $('#files-textarea').hidden = true; $('#files-save').hidden = true; $('#files-path').textContent = 'Select a file to view or edit.'; }
      await loadFilesList();
    } catch (er) { $('#files-msg').className = 'msg err'; $('#files-msg').textContent = er.message; }
  } else if (open) {
    openFileInEditor(open.dataset.open);
  }
});
$('#files-banner').addEventListener('click', (e) => {
  const b = e.target.closest('[data-newfile]');
  if (b) newFile(b.dataset.newfile);
});

// ---------- Compose override modal ----------
let composeProject = null;
async function openCompose(project) {
  composeProject = project;
  $('#compose-title').textContent = project.name;
  $('#compose-msg').textContent = '';
  $('#compose-modal').hidden = false;
  switchCTab('override');
  $('#compose-textarea').value = 'Loading…';
  try {
    const d = await api.get(`/api/projects/${project.id}/compose`);
    $('#compose-textarea').value = d.override || '';
    $('#compose-base-textarea').value = d.base || '(compose file not found)';
    $('#compose-base .hint').textContent = `Original ${d.file} from the repo (read-only).`;
  } catch (e) {
    $('#compose-textarea').value = '';
    $('#compose-msg').className = 'msg err';
    $('#compose-msg').textContent = e.message;
  }
}

$$('.tab[data-ctab]').forEach((t) =>
  t.addEventListener('click', () => switchCTab(t.dataset.ctab))
);
function switchCTab(name) {
  $$('.tab[data-ctab]').forEach((t) => t.classList.toggle('active', t.dataset.ctab === name));
  $('#compose-override').hidden = name !== 'override';
  $('#compose-base').hidden = name !== 'base';
}

$('#compose-save').addEventListener('click', async () => {
  const msg = $('#compose-msg');
  msg.className = 'msg';
  msg.textContent = 'Validating & saving…';
  try {
    const r = await api.send('PUT', `/api/projects/${composeProject.id}/compose`, {
      override: $('#compose-textarea').value,
    });
    msg.className = 'msg ok';
    msg.textContent = r.overrideExists
      ? 'Saved & valid. Restart/rebuild to apply.'
      : 'Override removed.';
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
});

// ---------- Routes (reverse proxy) modal ----------
let routesProject = null;
let routesPorts = []; // published host ports detected for this project

async function openRoutes(project) {
  routesProject = project;
  $('#routes-title').textContent = project.name;
  $('#routes-msg').textContent = '';
  $('#routes-modal').hidden = false;

  // Detect the project's published ports so ports can be picked, not typed.
  routesPorts = [];
  try {
    const detail = await api.get(`/api/projects/${project.id}`);
    routesPorts = [
      ...new Set((detail.containers || []).flatMap((c) => c.ports || []).map((p) => p.split(':')[0])),
    ].sort((a, b) => a - b);
  } catch { /* ignore */ }

  try {
    const d = await api.get(`/api/projects/${project.id}/routes`);
    renderRouteRows(d.routes.length ? d.routes : [{ path: '', port: '', stripPrefix: true }]);
  } catch (e) {
    renderRouteRows([{ path: '', port: '', stripPrefix: true }]);
  }
  if (!routesPorts.length) {
    failRoutes('Tip: start the project first so its ports are detected. You can still pick "Other…" to enter one.');
  }
}

// Port picker: a dropdown of detected ports + an "Other…" manual option.
function portField(selected) {
  const list = [...routesPorts];
  if (selected && !list.map(String).includes(String(selected))) list.unshift(String(selected));
  const options = list
    .map((p) => `<option value="${esc(p)}"${String(p) === String(selected) ? ' selected' : ''}>${esc(p)}</option>`)
    .join('');
  return `<select class="rport">
      <option value=""${!selected ? ' selected' : ''} disabled>port…</option>
      ${options}
      <option value="__other">Other…</option>
    </select>
    <input class="rport-custom" type="number" min="1" max="65535" placeholder="port" style="display:none" />`;
}

function renderRouteRows(routes) {
  $('#routes-rows').innerHTML = routes.map(routeRow).join('');
}
function routeRow(r) {
  const slug = r.slug ?? String(r.path || '').replace(/^\/?_?/, '');
  return `<div class="route-row">
    <span class="prefix">/_</span>
    <input class="rp" placeholder="chat" value="${esc(slug)}" />
    <span class="arrow">→ :</span>
    ${portField(r.port)}
    <label class="strip" title="Strip the path prefix before forwarding (recommended)">
      <input type="checkbox" class="rstrip" ${r.stripPrefix !== false ? 'checked' : ''} /> strip
    </label>
    <label class="strip" title="Fix CORS for credentialed cross-origin calls: proxy echoes the caller's Origin, adds Allow-Credentials, and answers preflight (reflecting requested headers).">
      <input type="checkbox" class="rcors" ${r.cors ? 'checked' : ''} /> CORS
    </label>
    <button type="button" data-del>✕</button>
  </div>`;
}

$('#routes-add').addEventListener('click', () => {
  $('#routes-rows').insertAdjacentHTML('beforeend', routeRow({ path: '', port: '', stripPrefix: true }));
});
$('#routes-rows').addEventListener('click', (e) => {
  if (e.target.closest('[data-del]')) e.target.closest('.route-row').remove();
});
// Live-sanitize the name field: only letters, numbers, hyphens allowed.
$('#routes-rows').addEventListener('input', (e) => {
  if (e.target.classList.contains('rp')) {
    const clean = e.target.value.replace(/[^a-zA-Z0-9-]/g, '');
    if (clean !== e.target.value) e.target.value = clean;
  }
});
// Show the manual port input only when "Other…" is selected.
$('#routes-rows').addEventListener('change', (e) => {
  if (e.target.classList.contains('rport')) {
    const custom = e.target.nextElementSibling;
    const isOther = e.target.value === '__other';
    custom.style.display = isOther ? '' : 'none';
    if (isOther) custom.focus();
  }
});

function failRoutes(text) {
  const msg = $('#routes-msg');
  msg.className = 'msg err';
  msg.textContent = text;
}

$('#routes-save').addEventListener('click', async () => {
  const msg = $('#routes-msg');
  msg.className = 'msg';
  msg.textContent = 'Saving…';
  const rows = $$('.route-row').map((row) => {
    const sel = $('.rport', row);
    const portRaw = sel.value === '__other' ? $('.rport-custom', row).value.trim() : sel.value;
    return {
      slug: $('.rp', row).value.trim(),
      portRaw,
      stripPrefix: $('.rstrip', row).checked,
      cors: $('.rcors', row).checked,
    };
  });

  // Validate each non-empty row so nothing is silently dropped.
  const routes = [];
  for (const r of rows) {
    if (!r.slug && !r.portRaw) continue; // fully blank row: ignore
    if (!r.slug) { return failRoutes('Give the route a name (e.g. chat).'); }
    if (!/^[a-zA-Z0-9-]+$/.test(r.slug)) {
      return failRoutes(`"/_${r.slug}" is invalid — use letters, numbers, and hyphens only.`);
    }
    const port = parseInt(r.portRaw);
    if (!port || port < 1 || port > 65535) {
      return failRoutes(`Enter a valid port (1–65535) for "/_${r.slug}".`);
    }
    routes.push({ slug: r.slug, port, stripPrefix: r.stripPrefix, cors: r.cors });
  }
  // Reject duplicate names client-side too.
  const names = routes.map((r) => r.slug);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return failRoutes(`Duplicate route name "/_${dup}".`);

  try {
    await api.send('PUT', `/api/projects/${routesProject.id}/routes`, { routes });
    msg.className = 'msg ok';
    msg.textContent = 'Saved. Routes are live immediately.';
    await loadProjects();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
});

// ---------- Branch modal ----------
let branchProject = null;
async function openBranch(project) {
  branchProject = project;
  $('#branch-title').textContent = project.name;
  $('#branch-msg').textContent = '';
  $('#branch-current').textContent = 'loading…';
  $('#branch-select').innerHTML = '<option>loading…</option>';
  $('#branch-input').value = '';
  $('#branch-modal').hidden = false;
  try {
    const d = await api.get(`/api/projects/${project.id}/branches`);
    $('#branch-current').textContent = d.current || '(unknown)';
    const opts = (d.remote || []);
    $('#branch-select').innerHTML = opts.length
      ? opts.map((b) => `<option value="${esc(b)}"${b === d.current ? ' selected' : ''}>${esc(b)}</option>`).join('')
      : '<option value="">(no remote branches found)</option>';
  } catch (e) {
    $('#branch-current').textContent = '(error)';
    $('#branch-msg').className = 'msg err';
    $('#branch-msg').textContent = e.message;
  }
}

$('#branch-switch').addEventListener('click', async () => {
  const branch = $('#branch-input').value.trim() || $('#branch-select').value;
  const msg = $('#branch-msg');
  if (!branch) { msg.className = 'msg err'; msg.textContent = 'Pick or type a branch.'; return; }
  const btn = $('#branch-switch');
  btn.disabled = true;
  msg.className = 'msg';
  msg.textContent = 'Switching…';
  try {
    const res = await api.send('POST', `/api/projects/${branchProject.id}/branch`, {
      branch,
      rebuild: $('#branch-rebuild').checked,
    });
    msg.className = 'msg ok';
    msg.textContent = `Now on "${res.branch}".`;
    await loadProjects();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- Shell (interactive terminal) ----------
let shellProject = null;
let term = null;
let fitAddon = null;
let shellWs = null;

async function openShell(project) {
  shellProject = project;
  $('#shell-title').textContent = project.name;
  $('#shell-status').textContent = '';
  $('#shell-status').className = 'msg';
  $('#shell-modal').hidden = false;

  // Load running containers to choose from.
  const sel = $('#shell-container');
  sel.innerHTML = '<option>loading…</option>';
  let containers = [];
  try {
    const d = await api.get(`/api/projects/${project.id}`);
    containers = (d.containers || []).filter((c) => c.state === 'running');
  } catch { /* ignore */ }

  if (!containers.length) {
    sel.innerHTML = '<option value="">(no running containers)</option>';
    setShellStatus('Start the project first — no running containers to attach to.', true);
    return;
  }
  sel.innerHTML = containers
    .map((c) => `<option value="${esc(c.id)}">${esc(c.service)} (${esc(c.id.slice(0, 12))})</option>`)
    .join('');

  ensureTerm();
  connectShell();
}

function ensureTerm() {
  if (term) return;
  term = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    theme: { background: '#0a0e17', foreground: '#e6ecf5' },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open($('#terminal'));
  fitAddon.fit();

  // Keystrokes -> server
  term.onData((data) => {
    if (shellWs && shellWs.readyState === WebSocket.OPEN) shellWs.send(data);
  });

  window.addEventListener('resize', () => {
    if (!$('#shell-modal').hidden) fitResize();
  });
}

function fitResize() {
  try {
    fitAddon.fit();
    if (shellWs && shellWs.readyState === WebSocket.OPEN) {
      shellWs.send('\x00RESIZE' + JSON.stringify({ cols: term.cols, rows: term.rows }));
    }
  } catch { /* ignore */ }
}

function connectShell() {
  closeShellWs();
  const containerId = $('#shell-container').value;
  if (!containerId) return;
  term.reset();
  setShellStatus('Connecting…', false);

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws/exec?project=${encodeURIComponent(shellProject.id)}&container=${encodeURIComponent(containerId)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  shellWs = ws;

  ws.onopen = () => {
    setShellStatus('Connected. Type commands below.', false);
    fitResize();
    term.focus();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') term.write(ev.data);
    else term.write(new Uint8Array(ev.data));
  };
  ws.onclose = () => setShellStatus('Disconnected.', true);
  ws.onerror = () => setShellStatus('Connection error.', true);
}

function closeShellWs() {
  if (shellWs) {
    try { shellWs.close(); } catch { /* ignore */ }
    shellWs = null;
  }
}

function setShellStatus(msg, isErr) {
  const el = $('#shell-status');
  el.className = 'msg' + (isErr ? ' err' : ' ok');
  el.textContent = msg;
}

$('#shell-connect').addEventListener('click', () => { ensureTerm(); connectShell(); });
$('#shell-container').addEventListener('change', () => { ensureTerm(); connectShell(); });

// ---------- Logs modal ----------
let logsProject = null;
async function openLogs(project) {
  logsProject = project;
  $('#logs-title').textContent = project.name;
  $('#logs-content').textContent = 'Loading…';
  $('#logs-modal').hidden = false;
  await refreshLogs();
}
async function refreshLogs() {
  try {
    const d = await api.get(`/api/projects/${logsProject.id}/logs?tail=300`);
    $('#logs-content').textContent = d.logs || '(no logs)';
    $('#logs-content').scrollTop = $('#logs-content').scrollHeight;
  } catch (e) {
    $('#logs-content').textContent = e.message;
  }
}
$('#logs-refresh').addEventListener('click', refreshLogs);

// close modals
$$('[data-close]').forEach((b) =>
  b.addEventListener('click', () => {
    const modal = b.closest('.modal');
    if (modal) modal.hidden = true;
    if (modal && modal.id === 'shell-modal') closeShellWs();
  })
);
$$('.modal').forEach((m) =>
  m.addEventListener('click', (e) => {
    if (e.target === m) {
      m.hidden = true;
      if (m.id === 'shell-modal') closeShellWs();
    }
  })
);

// ---------- Auth: login screen ----------
function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-msg').textContent = '';
  $('#login-user').focus();
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
}
function hideLogin() {
  $('#login').hidden = true;
  $('#app').hidden = false;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#login-msg');
  msg.className = 'msg';
  msg.textContent = 'Signing in…';
  $('#login-btn').disabled = true;
  try {
    currentUser = await api.send('POST', '/api/auth/login', {
      username: $('#login-user').value.trim(),
      password: $('#login-pass').value,
    });
    $('#login-pass').value = '';
    hideLogin();
    await initApp();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    $('#login-btn').disabled = false;
  }
});

function renderUserbar() {
  const admin = currentUser.role === 'admin';
  $('#userbar').innerHTML = `
    <span class="whoami">${esc(currentUser.username)} <span class="role ${esc(currentUser.role)}">${esc(currentUser.role)}</span></span>
    ${admin ? '<button class="sm ghost" id="btn-users">Users</button>' : ''}
    ${admin ? '<button class="sm ghost" id="btn-sshkey">SSH key</button>' : ''}
    ${admin ? '<button class="sm ghost" id="btn-secure">Secure env</button>' : ''}
    ${admin ? '<button class="sm ghost" id="btn-prune">Prune</button>' : ''}
    <button class="sm ghost" id="btn-audit">Audit log</button>
    <button class="sm ghost" id="btn-pass">Password</button>
    <button class="sm ghost" id="btn-logout">Logout</button>`;
  if (admin) $('#btn-users').addEventListener('click', openUsers);
  if (admin) $('#btn-sshkey').addEventListener('click', openSshKey);
  if (admin) $('#btn-secure').addEventListener('click', openSecure);
  if (admin) $('#btn-prune').addEventListener('click', openPrune);
  $('#btn-audit').addEventListener('click', openAudit);
  $('#btn-pass').addEventListener('click', changePassword);
  $('#btn-logout').addEventListener('click', logout);
}

async function logout() {
  await api.send('POST', '/api/auth/logout').catch(() => {});
  currentUser = null;
  showLogin();
}

function changePassword() {
  $('#pw-current').value = '';
  $('#pw-new').value = '';
  $('#pw-confirm').value = '';
  const msg = $('#pw-msg');
  msg.className = 'msg';
  msg.textContent = '';
  $('#password-modal').hidden = false;
  $('#pw-current').focus();
}

async function submitPassword() {
  const cur = $('#pw-current').value;
  const nw = $('#pw-new').value;
  const cf = $('#pw-confirm').value;
  const msg = $('#pw-msg');
  const fail = (t) => { msg.className = 'msg err'; msg.textContent = t; };

  if (!cur) return fail('Enter your current password.');
  if (nw.length < 4) return fail('New password must be at least 4 characters.');
  if (nw !== cf) return fail('New passwords do not match.');

  msg.className = 'msg';
  msg.textContent = 'Updating…';
  $('#pw-save').disabled = true;
  try {
    await api.send('POST', '/api/auth/password', { currentPassword: cur, newPassword: nw });
    msg.className = 'msg ok';
    msg.textContent = 'Password updated.';
    setTimeout(() => { $('#password-modal').hidden = true; }, 900);
  } catch (e) {
    fail(e.message);
  } finally {
    $('#pw-save').disabled = false;
  }
}

$('#pw-save').addEventListener('click', submitPassword);
$('#password-form').addEventListener('submit', (e) => { e.preventDefault(); submitPassword(); });

// ---------- Users admin modal ----------
async function openUsers() {
  $('#users-msg').textContent = '';
  $('#users-modal').hidden = false;
  await loadUsers();
}
async function loadUsers() {
  const users = await api.get('/api/users');
  $('#users-list').innerHTML = users
    .map(
      (u) => `<div class="user-row">
        <span class="u-name">${esc(u.username)} <span class="role ${esc(u.role)}">${esc(u.role)}</span></span>
        <span class="u-meta">${u.created_by ? 'by ' + esc(u.created_by) : ''}</span>
        <button class="sm ghost" data-reset="${u.id}" data-name="${esc(u.username)}">Reset pw</button>
        ${u.id === currentUser.id ? '' : `<button class="sm danger" data-deluser="${u.id}" data-name="${esc(u.username)}">Delete</button>`}
      </div>`
    )
    .join('');
}
// Toggle a password input between hidden/visible and flip the button label.
function bindPwToggle(btnId, inputId) {
  $(btnId).addEventListener('click', () => {
    const input = $(inputId);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $(btnId).textContent = show ? 'Hide' : 'Show';
  });
}
// Generate a readable random password and reveal it.
function genPassword(inputId, btnId) {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const rnd = crypto.getRandomValues(new Uint32Array(14));
  for (let i = 0; i < 14; i++) out += chars[rnd[i] % chars.length];
  $(inputId).value = out;
  $(inputId).type = 'text';
  if (btnId) $(btnId).textContent = 'Hide';
}
bindPwToggle('#nu-show', '#nu-pass');
$('#nu-gen').addEventListener('click', () => genPassword('#nu-pass', '#nu-show'));

$('#create-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#users-msg');
  const fail = (t) => { msg.className = 'msg err'; msg.textContent = t; };
  const username = $('#nu-name').value.trim();
  const password = $('#nu-pass').value;
  if (!username) return fail('Enter a username.');
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
    return fail('Username: 2–32 chars, letters/numbers/. _ - only.');
  }
  if (password.length < 4) return fail('Password must be at least 4 characters.');

  msg.className = 'msg';
  msg.textContent = 'Creating…';
  $('#nu-create').disabled = true;
  try {
    await api.send('POST', '/api/users', { username, password, role: $('#nu-role').value });
    $('#nu-name').value = '';
    $('#nu-pass').value = '';
    $('#nu-pass').type = 'password';
    $('#nu-show').textContent = 'Show';
    $('#nu-role').value = 'user';
    msg.className = 'msg ok';
    msg.textContent = `User "${username}" created.`;
    await loadUsers();
  } catch (e2) {
    fail(e2.message);
  } finally {
    $('#nu-create').disabled = false;
  }
});

// Delete (native confirm — destructive) and Reset (proper modal).
$('#users-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-deluser]');
  const reset = e.target.closest('[data-reset]');
  if (del) {
    if (!confirm(`Delete user "${del.dataset.name}"? This cannot be undone.`)) return;
    const msg = $('#users-msg');
    msg.className = 'msg';
    try { await api.send('DELETE', `/api/users/${del.dataset.deluser}`); await loadUsers(); }
    catch (er) { msg.className = 'msg err'; msg.textContent = er.message; }
  } else if (reset) {
    openReset(reset.dataset.reset, reset.dataset.name);
  }
});

// ---------- Reset password modal ----------
let resetUserId = null;
function openReset(id, name) {
  resetUserId = id;
  $('#reset-title').textContent = name;
  $('#rp-pass').value = '';
  $('#rp-pass').type = 'password';
  $('#rp-show').textContent = 'Show';
  $('#reset-msg').textContent = '';
  $('#reset-modal').hidden = false;
  $('#rp-pass').focus();
}
bindPwToggle('#rp-show', '#rp-pass');
$('#rp-gen').addEventListener('click', () => genPassword('#rp-pass', '#rp-show'));

async function submitReset() {
  const pw = $('#rp-pass').value;
  const msg = $('#reset-msg');
  if (pw.length < 4) { msg.className = 'msg err'; msg.textContent = 'Password must be at least 4 characters.'; return; }
  msg.className = 'msg';
  msg.textContent = 'Setting…';
  $('#rp-save').disabled = true;
  try {
    await api.send('POST', `/api/users/${resetUserId}/password`, { password: pw });
    msg.className = 'msg ok';
    msg.textContent = 'Password updated.';
    setTimeout(() => { $('#reset-modal').hidden = true; }, 900);
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  } finally {
    $('#rp-save').disabled = false;
  }
}
$('#rp-save').addEventListener('click', submitReset);
$('#reset-form').addEventListener('submit', (e) => { e.preventDefault(); submitReset(); });

// ---------- Prune (docker GC) modal ----------
async function openPrune() {
  $('#prune-msg').textContent = '';
  $('#prune-msg').className = 'msg';
  $('#prune-out').hidden = true;
  $('#prune-modal').hidden = false;
  await loadPruneDf();
}
async function loadPruneDf() {
  try {
    const rows = await api.get('/api/system/disk');
    $('#prune-df').innerHTML = rows.map((r) =>
      `<tr><td>${esc(r.type)}</td><td>${esc(r.total)}</td><td>${esc(r.active)}</td><td>${esc(r.size)}</td><td class="muted">${esc(r.reclaimable)}</td></tr>`
    ).join('') || '<tr><td colspan="5" class="muted">No data.</td></tr>';
  } catch (e) { $('#prune-df').innerHTML = `<tr><td colspan="5" class="msg err">${esc(e.message)}</td></tr>`; }
}
$('#prune-run').addEventListener('click', async () => {
  const all = $('#prune-all').checked;
  if (all && !confirm('Remove ALL images not used by a container? Stopped projects will re-pull/rebuild on next start.')) return;
  const msg = $('#prune-msg');
  msg.className = 'msg'; msg.textContent = 'Pruning…';
  $('#prune-run').disabled = true;
  try {
    const r = await api.send('POST', '/api/system/prune', { all, buildCache: $('#prune-cache').checked });
    msg.className = 'msg ok'; msg.textContent = `Reclaimed ${r.reclaimed}.`;
    $('#prune-out').hidden = false; $('#prune-out').textContent = r.output || '';
    await loadPruneDf();
  } catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
  finally { $('#prune-run').disabled = false; }
});

// ---------- SSH key modal ----------
async function openSshKey() {
  $('#sshkey-msg').textContent = '';
  $('#sshkey-msg').className = 'msg';
  $('#sshkey-modal').hidden = false;
  await loadSshKey();
}
async function loadSshKey() {
  try {
    const d = await api.get('/api/ssh-key');
    $('#sshkey-text').value = d.publicKey || '';
    $('#sshkey-empty').hidden = d.exists;
    $('#sshkey-copy').hidden = !d.exists;
    $('#sshkey-gen').hidden = d.exists;
  } catch (e) {
    $('#sshkey-msg').className = 'msg err';
    $('#sshkey-msg').textContent = e.message;
  }
}
$('#sshkey-gen').addEventListener('click', async () => {
  const msg = $('#sshkey-msg');
  msg.className = 'msg';
  msg.textContent = 'Generating…';
  try { await api.send('POST', '/api/ssh-key'); msg.textContent = ''; await loadSshKey(); }
  catch (e) { msg.className = 'msg err'; msg.textContent = e.message; }
});
$('#sshkey-copy').addEventListener('click', async () => {
  const text = $('#sshkey-text').value;
  try { await navigator.clipboard.writeText(text); }
  catch { $('#sshkey-text').select(); document.execCommand('copy'); }
  $('#sshkey-msg').className = 'msg ok';
  $('#sshkey-msg').textContent = 'Copied to clipboard.';
});

// ---------- Audit log modal ----------
async function openAudit() {
  $('#audit-modal').hidden = false;
  await loadAudit();
}
async function loadAudit() {
  const rows = await api.get('/api/logs?limit=300');
  $('#audit-rows').innerHTML = rows
    .map(
      (l) => `<tr>
        <td>${esc(new Date(l.at).toLocaleString())}</td>
        <td>${esc(l.username || '—')}</td>
        <td>${esc(l.action)}${l.detail ? ' <span class="muted">(' + esc(l.detail) + ')</span>' : ''}</td>
        <td class="muted">${esc(l.target || '')}</td>
        <td><span class="st st-${String(l.status).charAt(0)}">${esc(l.status ?? '')}</span></td>
      </tr>`
    )
    .join('') || '<tr><td colspan="5" class="muted">No entries.</td></tr>';
}
$('#audit-refresh').addEventListener('click', loadAudit);

// ---------- Boot ----------
async function initApp() {
  renderUserbar();
  const s = await api.get('/api/system').catch(() => ({}));
  window.__ncpu = s.ncpu || 1;
  await loadSystem();
  await loadProjects();
  await loadStatics();
  await refreshStats();
  await loadStorage();
  statsTimer = setInterval(refreshStats, 4000);
  setInterval(loadSystem, 10000);
  setInterval(loadStorage, 20000); // docker ps -s is heavier — poll less often
}

async function boot() {
  try {
    currentUser = await api.get('/api/auth/me');
    hideLogin();
    await initApp();
  } catch {
    showLogin();
  }
}
boot();
