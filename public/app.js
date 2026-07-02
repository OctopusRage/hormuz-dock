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
      throw new Error(data.error || r.statusText);
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

// ---------- System bar ----------
async function loadSystem() {
  try {
    const s = await api.get('/api/system');
    if (!s.dockerAvailable) {
      $('#system').innerHTML = `<span style="color:var(--red)">⚠ Docker not available</span>`;
      return;
    }
    $('#system').innerHTML = `
      <span>Docker <b>${s.version || '?'}</b></span>
      <span>CPUs <b>${s.ncpu ?? '?'}</b></span>
      <span>RAM <b>${fmtBytes(s.memTotal)}</b></span>
      <span>Containers <b>${s.containersRunning}/${s.containersTotal}</b></span>`;
  } catch { /* ignore */ }
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
}

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
  </div>`;
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

  try {
    if (act === 'delete') {
      await api.send('DELETE', `/api/projects/${id}`);
      await loadProjects();
      return;
    }
    const res = await api.send('POST', `/api/projects/${id}/${act}`);
    msg.className = 'msg ok';
    msg.textContent = ['pull', 'rebuild', 'redeploy'].includes(act)
      ? (res.output || `${act} done.`).split('\n').slice(-3).join(' ').slice(0, 200)
      : `${act} done.`;
    await loadProjects();
    await loadSystem();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
    buttons.forEach((b) => (b.disabled = false));
  }
});

// ---------- New project ----------
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
  msg.textContent = 'Cloning repository…';
  try {
    await api.send('POST', '/api/projects', body);
    msg.className = 'msg ok';
    msg.textContent = 'Project added!';
    $('#new-form').reset();
    await loadProjects();
  } catch (err) {
    msg.className = 'msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
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

$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
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
    routes.push({ slug: r.slug, port, stripPrefix: r.stripPrefix });
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
    <button class="sm ghost" id="btn-audit">Audit log</button>
    <button class="sm ghost" id="btn-pass">Password</button>
    <button class="sm ghost" id="btn-logout">Logout</button>`;
  if (admin) $('#btn-users').addEventListener('click', openUsers);
  $('#btn-audit').addEventListener('click', openAudit);
  $('#btn-pass').addEventListener('click', changePassword);
  $('#btn-logout').addEventListener('click', logout);
}

async function logout() {
  await api.send('POST', '/api/auth/logout').catch(() => {});
  currentUser = null;
  showLogin();
}

async function changePassword() {
  const cur = prompt('Current password:');
  if (cur == null) return;
  const nw = prompt('New password (min 4 chars):');
  if (!nw) return;
  try {
    await api.send('POST', '/api/auth/password', { currentPassword: cur, newPassword: nw });
    alert('Password changed.');
  } catch (e) {
    alert(e.message);
  }
}

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
        <button class="sm ghost" data-reset="${u.id}">Reset pw</button>
        ${u.id === currentUser.id ? '' : `<button class="sm danger" data-deluser="${u.id}" data-name="${esc(u.username)}">Delete</button>`}
      </div>`
    )
    .join('');
}
$('#nu-create').addEventListener('click', async () => {
  const msg = $('#users-msg');
  msg.className = 'msg';
  try {
    await api.send('POST', '/api/users', {
      username: $('#nu-name').value.trim(),
      password: $('#nu-pass').value,
      role: $('#nu-role').value,
    });
    $('#nu-name').value = '';
    $('#nu-pass').value = '';
    msg.className = 'msg ok';
    msg.textContent = 'User created.';
    await loadUsers();
  } catch (e) {
    msg.className = 'msg err';
    msg.textContent = e.message;
  }
});
$('#users-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-deluser]');
  const reset = e.target.closest('[data-reset]');
  const msg = $('#users-msg');
  msg.className = 'msg';
  if (del) {
    if (!confirm(`Delete user "${del.dataset.name}"?`)) return;
    try { await api.send('DELETE', `/api/users/${del.dataset.deluser}`); await loadUsers(); }
    catch (er) { msg.className = 'msg err'; msg.textContent = er.message; }
  } else if (reset) {
    const pw = prompt('New password for this user:');
    if (!pw) return;
    try { await api.send('POST', `/api/users/${reset.dataset.reset}/password`, { password: pw }); msg.className = 'msg ok'; msg.textContent = 'Password reset.'; }
    catch (er) { msg.className = 'msg err'; msg.textContent = er.message; }
  }
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
  await refreshStats();
  statsTimer = setInterval(refreshStats, 4000);
  setInterval(loadSystem, 10000);
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
