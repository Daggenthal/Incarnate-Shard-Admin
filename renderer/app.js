// Shard Admin window. Everything goes through window.shard (preload.js).
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let info = null;
let status = null;
let localHtml = '';     // this shard's own servers, shown under it in Shards
let subTab = { shard: 'services', xshard: 'services' };  // the tab open inside a shard's page
let svcEvents = [];     // this shard's last 40 progress events and alerts, for its Services tab
let svcTrouble = {};    // server -> its last 'stopped' or crash alert { time, title }
let openShards = {};    // shard name -> its servers shown in the sidebar
// The names shown for servers whose program name is short for something
const SERVER_TITLES = { DBServer: 'Database Server', sql: 'SQL Server' };
// Every program name as words: AuthServer -> Auth Server, MapServer-12 -> Map Server 12
const serverTitle = (name) => {
  if (!name) return name;
  if (SERVER_TITLES[name]) return SERVER_TITLES[name];
  return String(name).replace(/^([A-Z][a-z]+)(Server|Client)\b/, '$1 $2').replace(/^Map Server-(\d+)$/, 'Map Server $1')
    .replace(/^Map Server-standby$/, 'Map Server (Standby)').replace(/^Map Server-names$/, 'Map Server (Chat Names)')
    .replace(/\.prev$/, ', Previous Run');
};

let sel = { key: 'DBServer', title: 'Database Server', about: '', restart: 'DBServer' };
let logLines = [];
const MAX_LINES = 6000;
// Clear: the log's size when it was cleared, per log. The file is left alone (the servers keep
// writing to it, and it's what Copy Logs Here and Show File use); the view shows only what was
// written after that point. A log that was started over (smaller than that) shows from the top.
const clearedAt = {};
const logSize = {};
function sinceCleared(key, text, size) {
  if (size !== undefined) logSize[key] = size;
  const at = clearedAt[key];
  if (at === undefined || size === undefined) return text;
  if (size < at) { delete clearedAt[key]; return text; }
  return size - at >= text.length ? text : text.slice(text.length - (size - at));
}
function clearLog(key) {
  if (key === '*') { for (const k of Object.keys(logSize)) clearedAt[k] = logSize[k]; }
  else clearedAt[key] = logSize[key] || 0;
  if (sel.key === key || key === '*') {
    logLines = [];
    renderLog(true);
    $('#logView').innerHTML = `<span class="dim">Cleared at ${new Date().toLocaleTimeString([], { hour12: false })}. New lines show here.</span>`;
  }
}
let unseenAlerts = 0;
let target = { kind: 'local', id: 'local', name: 'This computer', state: 'connected' };

// ---- Formatting ----

function ago(sec) {
  if (!sec) return '';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}
const mb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${n} MB`);
const clock = (t) => new Date(t).toLocaleTimeString();

// Same colors as the terminal tools (tools/colorize.sh)
function lineClass(l) {
  if (/^===== started/.test(l)) return 's';
  if (/Initialized error log/.test(l)) return '';
  if (/Shared heap disabled|directory watching is not available|OpenThread: only the calling|performance counter|regfileLoadKeyValue|socketSetBufferSize|ERRORLOG|FILEERROR/.test(l)) return 'w';
  if (/AddressSanitizer|^SUMMARY:|==\d+==(ERROR|ABORTING)|crashed: signal|TSR: stack/.test(l)) return 'E';
  if (/^\s+#\d+ 0x|^\d+\s+\S+\s+0x[0-9a-f]+ /.test(l)) return 'c';
  if (/\b(errors?|fail(s|ed|ure)?|fatal|assert(ion)?|crash(ed|es)?|segmentation|abort(ed|ing)?|exception|invalid|corrupt|cannot|can.t|could not|unable|refused)\b/i.test(l)) return 'e';
  if (/\b(warn(ing)?s?|deprecated|missing|not found|no such|retry(ing)?|time[d ]?out|not available|skipp(ed|ing))\b/i.test(l)) return 'w';
  if (/\b(done|ready|connected|success(ful)?|launching|linked|loaded|found)\b/i.test(l)) return 'g';
  return '';
}

// ---- Toasts ----

function toast(title, body, level = 'error', onClick) {
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.innerHTML = `<div class="t">${esc(spaceNames(title))}</div>${body ? `<div class="b">${esc(spaceNames(body))}</div>` : ''}`;
  el.onclick = () => { el.remove(); if (onClick) onClick(); };
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), level === 'error' ? 12000 : 6000);
}

async function call(name, arg, okText) {
  const r = await window.shard[name](arg);
  // These report through the Activity feed (and its toasts) already
  const reportsItself = ['start', 'stop', 'restartAll', 'restart', 'build', 'buildChanged', 'backup', 'importDatabases', 'importRollback'].includes(name);
  if (r && r.ok === false && !reportsItself) toast(`${name} failed`, r.error || '', 'error');
  else if (okText) toast(okText, '', 'ok');
  return r;
}

// ---- Tabs ----

function showTab(name) {
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${name}`));
  if (name === 'alerts') { unseenAlerts = 0; updateAlertBadge(); }
  if (name === 'settings') loadSettings();
  if (name === 'staff') { loadStaff(); }
  if (name === 'tracker') loadTracker();
  if (name === 'machines') { loadMachines(); renderHost(); }
  if (name === 'messages') loadMessages();
  if (name === 'shard') loadShard(); else stopShardPoll();
  if (name === 'chat') startChat(); else stopChat();
  if (name === 'xshard') renderXshard();
  if (name === 'shard') renderSvc();
  for (const g of ['shard', 'xshard']) if (name === g) showSub(g, subTab[g]);
}

// The tabs inside a shard's page
function showSub(group, name) {
  subTab[group] = name;
  $$(`[data-subtabs="${group}"] button`).forEach((b) => b.classList.toggle('on', b.dataset.sub === name));
  $$('[data-subpane]').forEach((p) => { if (p.dataset.subpane.startsWith(`${group}:`)) p.classList.toggle('on', p.dataset.subpane === `${group}:${name}`); });
  if (group === 'shard' && name === 'services') renderSvc();
}
$$('[data-subtabs]').forEach((bar) => { bar.onclick = (e) => { const b = e.target.closest('[data-sub]'); if (b) showSub(bar.dataset.subtabs, b.dataset.sub); }; });
// Open a shard's page on one of its tabs
function openShardPage(which, sub) {
  if (which === 'main') { subTab.shard = sub; showTab('shard'); } else { xsPick = which; xsLogKey = ''; subTab.xshard = sub; showTab('xshard'); }
  renderShardItem();
}
$$('.tabs button').forEach((b) => (b.onclick = () => {
  // Logs from a shard's page: that shard's logs (Freedom's all at once, another shard's through
  // its container), not whatever was picked last
  if (b.dataset.tab === 'logs') {
    if ($('#pane-shard').classList.contains('on')) { selectLog('*', 'All Logs', 'Every log of this shard, live', null); return; }
    if ($('#pane-xshard').classList.contains('on') && xsPick) { showXsLogsInViewer(xsPick); return; }
  }
  showTab(b.dataset.tab);
}));

// Another shard's logs in the Logs tab: what All Its Logs shows, kept up to date while it's open
async function showXsLogsInViewer(name) {
  sel = { key: `xs:${name}`, title: `${name}: All Its Logs`, about: "The container's own output, then the last lines of every server's log", restart: null };
  $('#logName').textContent = sel.title;
  $('#logAbout').textContent = sel.about;
  $('#btnRestartOne').classList.add('hidden');
  showTab('logs');
  const r = await window.shard.extraShardLog({ name, server: 'all' });
  if (sel.key !== `xs:${name}`) return;
  logLines = (r && r.ok !== false ? r.text || '' : (r && r.error) || 'No log').split('\n');
  renderLog(true);
}

// ---- Servers ----

function serverMeta(s) {
  if (s.state === 'down') return s.built === false ? 'not built yet' : 'not running';
  const bits = [];
  if (s.state === 'starting') bits.push('starting');
  if (s.pid) bits.push(`pid ${s.pid}`);
  if (s.uptime) bits.push(`up ${ago(s.uptime)}`);
  if (s.cpu !== undefined) bits.push(`${s.cpu.toFixed(1)}% CPU`);
  if (s.rssMB) bits.push(mb(s.rssMB));
  return bits.join(' · ');
}

function renderServers() {
  if (!status) return;
  document.body.classList.toggle('offline', !!status.offline);
  const list = $('#serverList');
  // Global: shared by every shard on this machine (the login server and its list); Local: this
  // shard's own (each other shard runs its own copies, in its own container)
  const one = (s) => `
    <li class="srv ${sel.key === s.name ? 'sel' : ''}" data-log="${esc(s.name)}" data-restart="${esc(s.name)}" title="${esc(s.about)}">
      <span class="dot ${s.state}"></span>
      <span class="nm" title="${esc(s.name)}">${esc(serverTitle(s.name))}</span>
      <span class="tags">
        ${s.outdated ? '<span class="tag update" title="The code changed since this was built">update</span>' : ''}
        ${s.restartNeeded ? '<span class="tag restart" title="A newer build is ready: restart to run it">restart</span>' : ''}
      </span>
      <span class="meta">${esc(serverMeta(s))}</span>
    </li>`;
  const global = status.servers.filter((s) => GLOBAL_SERVERS.includes(s.name));
  const own = status.servers.filter((s) => !GLOBAL_SERVERS.includes(s.name));
  list.innerHTML = `${global.map(one).join('')}
    <li class="srv plain" data-log="sql" data-ctx="sql" title="One SQL Server; each shard has its own databases in it"><span class="dot ${status.sqlUp ? 'up' : 'down'}"></span><span class="nm">SQL Server</span><span class="meta">${status.sqlUp ? 'up · ' : 'not running · '}every shard's databases</span></li>`;
  // This shard's own servers and map servers go under it in Shards (renderShardItem)
  localHtml = own.map((s) => one(s).replace('class="srv ', 'class="srv nest ')).join('')
    + (status.extras.length ? `<li class="grouphead nest">Map Servers</li>${status.extras.map((s) => `
    <li class="srv nest ${sel.key === s.logName ? 'sel' : ''}" data-log="${esc(s.logName)}" data-title="${esc(s.name)}">
      <span class="dot up"></span><span class="nm">${esc(s.name)}</span>
      <span class="tags">${s.restartNeeded ? '<span class="tag restart" title="A newer build is ready: restart to run it">restart</span>' : ''}<button class="link danger" data-stop="${s.pid}" title="Stop this process">stop</button></span>
      <span class="meta">${esc(serverMeta(s))}</span></li>`).join('')}` : '');
  const extras = $('#extraList');
  extras.innerHTML = status.extras.length ? status.extras.map((s) => `
    <li class="srv ${sel.key === s.logName ? 'sel' : ''}" data-log="${esc(s.logName)}" data-title="${esc(s.name)}">
      <span class="dot up"></span>
      <span class="nm">${esc(s.name)}</span>
      <span class="tags">${s.restartNeeded ? '<span class="tag restart" title="A newer build is ready: restart to run it">restart</span>' : ''}<button class="link danger" data-stop="${s.pid}" title="Stop this process">stop</button></span>
      <span class="meta">${esc(serverMeta(s))}</span>
    </li>`).join('') : '<li class="dim empty">none</li>';
  $('#mapCount').textContent = status.totals.maps ? `(${status.totals.maps} maps)` : '';

  renderShardCount();
  // The shard's share of the machine: 125% CPU is 1.25 cores busy
  const h = status.host;
  $('#totals').textContent = status.totals.rssMB
    ? `${status.totals.cpu.toFixed(0)}% CPU${h ? ` (${(status.totals.cpu / 100).toFixed(2)} of ${h.cores} cores)` : ''} · ${mb(status.totals.rssMB)} in RAM${h && h.memTotalMB ? ` (${Math.round(100 * status.totals.rssMB / h.memTotalMB)}%)` : ''}`
    : 'shard is stopped';
  renderHost();

  const n = status.outdatedCount;
  $('#outdatedBadge').textContent = n;
  $('#outdatedBadge').classList.toggle('hidden', !n);
  $('#btnBuildChanged').title = n ? `${n} servers have changes to build` : 'Every server is up to date';

  const busy = status.busy;
  // Anything of the shard still running (a server, a map, a beacon) counts, so Stop always
  // works after a crash; Start waits until the DBServer is gone
  const anything = status.servers.some((s) => s.state !== 'down') || status.extras.length > 0;
  const dbRunning = status.servers.some((s) => s.name === 'DBServer' && s.state !== 'down');
  const authUp = status.servers.some((s) => s.name === 'AuthServer' && s.state === 'up');
  const globalUp = !!status.sqlUp && (authUp || !!(status.toggles && status.toggles.fakeAuth));
  $('#btnStart').disabled = !!busy || globalUp || !!status.offline;
  $('#btnStop').disabled = busy === 'stopping' || (!anything && busy !== 'starting');
  $('#btnRestartAll').disabled = (!!busy && busy !== 'starting') || !anything;
  $('#btnStart').textContent = globalUp ? 'Global Running' : busy === 'starting' ? 'Starting...' : 'Start Global';
  $('#btnBuildChanged').disabled = !!busy;
  $('#btnBuildAll').disabled = !!busy;
  $('#btnBuildClient').disabled = !!busy;
  const stale = status.servers.filter((s) => s.restartNeeded).length + status.extras.filter((e) => e.restartNeeded).length;
  $('#updatedBadge').textContent = stale;
  $('#updatedBadge').classList.toggle('hidden', !stale);
  $('#btnRestartUpdated').disabled = !!busy || !stale;
  $('#btnBackup').disabled = !!busy;
  // What the shard is doing right now, so a start or restart never looks like nothing happened
  const showBusy = !!busy || status.warming || status.restarting;
  $('#busyNotice').classList.toggle('hidden', !showBusy);
  const doing = status.restarting ? 'Restarting' : busy ? `${busy[0].toUpperCase()}${busy.slice(1)}` : '';
  if (busy || status.restarting) $('#busyNotice').textContent = `${doing}: ${status.lastProgress || '...'} (${status.up}/${status.total} up)`;
  else if (status.warming) $('#busyNotice').textContent = `Starting: ${status.up}/${status.total} servers up. The Launcher starts the rest; give it a minute or two.`;
  $('#btnRestartAll').textContent = status.restarting ? 'Restarting...' : 'Restart All';
  $('#pendingNotice').classList.toggle('hidden', !status.pendingRestart);
  renderPlanned(status.plannedRestart);
  $('#btnClient').textContent = status.clientRunning ? 'Stop Client' : 'Start Client';
  renderToggles();
  renderShardItem();
  // The selected server's about line and restart button
  const cur = status.servers.find((s) => s.name === sel.key);
  $('#btnRestartOne').disabled = !cur;
}

$('#serverList').onclick = (e) => {
  const li = e.target.closest('.srv');
  if (li) selectLog(li.dataset.log, li.dataset.log, li.title, li.dataset.restart);
};
$('#extraList').onclick = async (e) => {
  const stop = e.target.closest('[data-stop]');
  if (stop) { e.stopPropagation(); await call('stopPid', +stop.dataset.stop, 'Stopped'); return; }
  const li = e.target.closest('.srv');
  if (li) selectLog(li.dataset.log, li.dataset.title, '', null);
};
$$('.side .plain').forEach((li) => (li.onclick = () => selectLog(li.dataset.log, li.textContent.trim(), '', null)));

// ---- Logs ----

async function selectLog(key, title, about, restart) {
  sel = { key, title: serverTitle(title || key), about: about || '', restart };
  $('#logName').textContent = sel.title;
  $('#logAbout').textContent = sel.about;
  $('#btnRestartOne').classList.toggle('hidden', !restart);
  showTab('logs');
  renderServers();
  if (key === '*') {
    // Every log at once: the last lines of each, then everything new as it comes, each
    // line marked with where it came from
    const keys = await window.shard.logKeys();
    const parts = await Promise.all(keys.filter((k) => k !== 'build').map((k) => window.shard.readLog(k)));
    logLines = [];
    for (const p of parts) {
      const lines = sinceCleared(p.key, p.text || '', p.size).split('\n').filter((l) => l.trim()).slice(-40);
      for (const l of lines) logLines.push(`[${p.key}] ${l}`);
    }
    allPartial = {};
    renderLog(true);
    return;
  }
  const r = await window.shard.readLog(key);
  const text = sinceCleared(key, r.text || '', r.size);
  logLines = text.split('\n');
  if (logLines.length > MAX_LINES) logLines = logLines.slice(-MAX_LINES);
  renderLog(true);
  if (!r.text) $('#logView').innerHTML = `<span class="dim">No log yet: ${esc(r.file || '')}</span>`;
  else if (!text) $('#logView').innerHTML = '<span class="dim">Cleared. New lines show here.</span>';
}

function visibleLines() {
  const f = $('#logFilter').value.toLowerCase();
  const errs = $('#logErrors').checked;
  return logLines.filter((l) => (!f || l.toLowerCase().includes(f)) && (!errs || /[eEwc]/.test(lineClass(l) || '-')));
}

function renderLog(scroll) {
  const view = $('#logView');
  view.innerHTML = visibleLines().map((l) => {
    const c = lineClass(l);
    return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
  }).join('\n');
  if (scroll || $('#logFollow').checked) view.scrollTop = view.scrollHeight;
}

function appendLog(text) {
  const parts = text.split('\n');
  if (logLines.length) logLines[logLines.length - 1] += parts.shift();
  logLines.push(...parts);
  if (logLines.length > MAX_LINES) logLines = logLines.slice(-MAX_LINES);
  const view = $('#logView');
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  if ($('#logFilter').value || $('#logErrors').checked) renderLog();
  else {
    // cheap append: re-render only the tail
    renderLog(false);
  }
  if ($('#logFollow').checked && atBottom) view.scrollTop = view.scrollHeight;
}

$('#logFilter').oninput = () => renderLog();
$('#logErrors').onchange = () => renderLog();
$('#logFollow').onchange = () => renderLog(true);
$('#btnReveal').onclick = () => window.shard.reveal(sel.key);
$('#btnClearLog').onclick = () => clearLog(sel.key);
$('#btnCopyLog').onclick = async () => {
  const lines = visibleLines();
  const text = lines.join('\n').replace(/\n+$/, '');
  if (!text.trim()) { toast('Nothing to copy', 'This log is empty', 'warn'); return; }
  await window.shard.copyText(`${sel.title}${target.kind === 'remote' ? ` (${target.name})` : ''}:\n${text}\n`);
  toast(`Copied ${lines.length} lines of ${sel.title}`, '', 'ok');
};
$('#btnRestartOne').onclick = async () => {
  if (!sel.restart) return;
  const whole = sel.restart === 'DBServer' ? 'This restarts the whole shard. ' : '';
  if (!confirm(`${whole}Restart the ${serverTitle(sel.restart)}?`)) return;
  call('restart', sel.restart);
};

let allPartial = {}; // the unfinished last line of each log, for the All logs view
window.shard.onLog(({ key, text }) => {
  if (logSize[key] !== undefined) logSize[key] += text.length;
  if (key === 'machine' && stepRunning) appendStepOut(text);
  if (key === sel.key) { appendLog(text); return; }
  if (sel.key !== '*' || key === 'build') return;
  const lines = ((allPartial[key] || '') + text).split('\n');
  allPartial[key] = lines.pop();
  const add = lines.filter((l) => l.trim()).map((l) => `[${key}] ${l}`);
  if (!add.length) return;
  logLines.push(...add);
  if (logLines.length > MAX_LINES) logLines = logLines.slice(-MAX_LINES);
  const view = $('#logView');
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 40;
  renderLog(false);
  if ($('#logFollow').checked && atBottom) view.scrollTop = view.scrollHeight;
});
window.shard.onFocusLog((key) => selectLog(key, key, '', null));

// ---- Status, progress, alerts ----

window.shard.onStatus((s) => {
  status = s;
  if (s.target && (s.target.state !== target.state || s.target.id !== target.id || s.target.busy !== target.busy)) {
    const changed = s.target.id !== target.id;
    target = s.target;
    renderTarget();
    if (changed) reloadAll();
  }
  renderServers();
  if ($('#pane-shard').classList.contains('on') && subTab.shard === 'services') renderSvc();
});

window.shard.onProgress((p) => {
  svcNote(p.text, p.level, p.time);
  const li = document.createElement('li');
  li.innerHTML = `<span class="dim">${clock(p.time || Date.now())}</span> <span class="${p.level}">${esc(spaceNames(p.text))}</span>`;
  $('#activityList').prepend(li);
  if (p.level === 'ok' || p.level === 'error' || p.level === 'warn') toast(p.text, '', p.level);
});

function updateAlertBadge() {
  $('#alertBadge').textContent = unseenAlerts;
  $('#alertBadge').classList.toggle('hidden', !unseenAlerts);
}

window.shard.onAlert((a) => {
  if (/stopped|crash/i.test(a.title)) svcTrouble[a.source] = { time: a.time || Date.now(), title: a.title };
  if (a.level === 'error' || a.level === 'warn') svcNote(a.title, a.level, a.time);
  const li = document.createElement('li');
  li.className = a.level;
  li.innerHTML = `<div class="t">${esc(spaceNames(a.title))} <span class="dim">${clock(a.time)}</span></div><div class="b">${esc(spaceNames(a.body))}</div>`;
  li.onclick = () => selectLog(a.source, a.source, '', null);
  $('#alertList').prepend(li);
  if (!$('#pane-alerts').classList.contains('on')) { unseenAlerts++; updateAlertBadge(); }
  toast(a.title, a.body, a.level, () => selectLog(a.source, a.source, '', null));
});
$('#btnClearAlerts').onclick = () => { $('#alertList').innerHTML = ''; unseenAlerts = 0; updateAlertBadge(); };

// ---- Top bar ----

$('#btnStart').onclick = () => call('startGlobal');
$('#btnStop').onclick = () => {
  const others = ((xshards && xshards.shards) || []).filter((h) => h.container && /running/i.test(h.container.state)).map((h) => h.name);
  const msg = `Stop everything? ${[status && status.serverName || 'This shard', ...others].join(', ')}, the AuthServer${status && status.toggles ? '' : ''} and SQL Server${(status && status.sqlUp) ? '' : ' (not running)'}. Players are disconnected.`;
  if (confirm(msg)) call('stopAll');
};
// Freedom from the sidebar (double-click, right-click): start, stop (Global stays up)
function startMain() { return call('start'); }
function stopMain() {
  const starting = status && (status.busy === 'starting' || status.warming);
  if (confirm(starting ? `${status.serverName} is still starting (${status.up}/${status.total} up). Stop it anyway?` : `Stop ${(status && status.serverName) || 'this shard'}? Its players are disconnected. The AuthServer and SQL Server stay up for the other shards.`)) call('stopShard');
}
// Restart all: players online are told (now, or after a countdown in chat)
$('#btnRestartAll').onclick = () => {
  const dbUp = status && status.servers.some((s) => s.name === 'DBServer' && s.state === 'up');
  const f = $('#restartForm');
  f.warn.disabled = !dbUp;
  f.text.disabled = !dbUp;
  if (!dbUp) f.warn.value = '0';
  f.text.value = '';
  f.text.placeholder = (lastMessages && lastMessages.restartMessage) || 'The server is restarting. It will be back in a few minutes.';
  $('#restartWho').textContent = dbUp
    ? 'Players online get the message in chat. When it restarts, every map saves and players go to the login screen with it.'
    : 'The Database Server isn\'t up, so there is nobody to tell: it restarts right away.';
  $('#restartDialog').showModal();
};
$('#restartDialog').addEventListener('close', () => {
  if ($('#restartDialog').returnValue !== 'ok') return;
  const f = $('#restartForm');
  call('restartAll', { warnMinutes: +f.warn.value || 0, message: f.text.value });
});
$('#btnCancelRestart').onclick = () => call('cancelRestart', null, 'Restart cancelled');
$('#btnApply').onclick = () => $('#btnRestartAll').click();
// Every build starts on an empty Build log, so what shows is this build's output only (the
// last one's stays in the file until this one starts writing). The Machine log too: a remote
// machine's build reports there
async function freshBuildLog() {
  await selectLog('build', 'Build', '', null);
  clearLog('build');
  if (target.kind === 'remote') { clearedAt.machine = logSize.machine || (await window.shard.readLog('machine')).size || 0; }
}
$('#btnBuildChanged').onclick = async () => { await freshBuildLog(); call('buildChanged'); };
$('#btnRestartUpdated').onclick = () => call('restartUpdated');
$('#btnBuildAll').onclick = async () => { await freshBuildLog(); call('build'); };
$('#btnBuildClient').onclick = async () => { await freshBuildLog(); call('buildClient'); };
$('#btnBackup').onclick = () => call('backup');
$('#btnReconnect').onclick = () => call('machineStep', 'connect');
$('#btnConnLog').onclick = () => selectLog('machine', 'Machine', 'tools/remote-shard.sh: copying, ssh, setup', null);
$('#btnClient').onclick = () => call(status && status.clientRunning ? 'stopClient' : 'startClient');

// ---- Optimizations ----

function renderToggles() {
  if (!info || !status) return;
  const box = $('#toggleList');
  const t = status.toggles || {};
  const a = status.applied;
  const running = status.servers.some((s) => s.state !== 'down');
  box.innerHTML = info.toggles.map((x) => {
    const on = !!t[x.key];
    let state = 'Applies when the shard starts';
    let cls = '';
    if (running && a) {
      const was = !!a[x.key];
      state = was === on ? `Running with: ${was ? 'on' : 'off'}` : `Running with ${was ? 'on' : 'off'}; ${on ? 'on' : 'off'} after a restart`;
      if (was !== on) cls = 'pending';
    }
    return `<div class="card">
      <div class="h">${esc(x.title)} <span class="where">${esc(x.where)}</span>
        <label class="switch sw"><input type="checkbox" data-toggle="${x.key}" ${on ? 'checked' : ''}><span></span></label></div>
      <p>${esc(x.about)}</p>
      <div class="state ${cls}">${esc(state)}</div>
    </div>`;
  }).join('');
}
$('#toggleList').onchange = async (e) => {
  const k = e.target.dataset.toggle;
  if (!k) return;
  const saved = await window.shard.setSettings({ toggles: { [k]: e.target.checked } });
  // The backend may switch another off with it (shared memory and the Debug build)
  status.toggles = { ...status.toggles, ...((saved && saved.toggles) || { [k]: e.target.checked }) };
  if (info && saved) info.settings = saved;
  renderToggles();
};

function renderClientOpts() {
  $('#clientOpts tbody').innerHTML = info.clientOptimizations.map((o) =>
    `<tr><td>${esc(o.title)}</td><td><code>${esc(o.command)}</code></td><td class="dim">${esc(o.about)}</td></tr>`).join('');
}

// ---- Settings ----

let cfg = null;
async function loadSettings() {
  cfg = await window.shard.readCfg();
  if (!cfg || cfg.ok === false) return;
  const groups = {};
  for (const f of cfg.fields) (groups[f.group] ||= []).push(f);
  // Per machine when a machine is picked (its Machines entry), not in the file here
  const machineOwned = (k) => cfg.remote && (k === 'AdvertisedIp');
  $('#cfgForm').innerHTML = Object.entries(groups).map(([g, fs]) => `<fieldset><legend>${esc(g)}</legend>${fs.map((f) => `
    <label>${esc(f.title)}
      <input name="${f.key}" value="${esc(cfg.values[f.key])}" ${f.check ? `pattern="${esc(f.check)}"` : ''} ${machineOwned(f.key) ? 'disabled' : ''}>
      <span class="hint dim">${machineOwned(f.key) ? `Set for ${esc(cfg.remote.name)} in the Machines tab` : esc(f.hint)}</span>
      ${f.warn && cfg.values[f.key] && cfg.values[f.key] !== '0' ? `<span class="warnline">${esc(f.warn)}</span>` : ''}
    </label>`).join('')}</fieldset>`).join('');
  renderNetwork();
  for (const r of $$('#grantForm input')) r.checked = r.value === cfg.grants;
  const lf = $('#listForm');
  lf.name.value = cfg.serverList ? cfg.serverList.name : '';
  lf.ip.value = cfg.serverList ? cfg.serverList.ip : '';
  const af = $('#appForm');
  af.startSql.checked = !!info.settings.startSql;
  af.notify.checked = !!info.settings.notify;
  af.autoRestart.checked = info.settings.autoRestart !== false;
  af.buildDir.value = info.settings.buildDir || 'build-native';
  $('#shardName').textContent = cfg.values.ShardName ? `Shard: ${cfg.values.ShardName}` : '';
  $('#btnBuildClient').title = 'The game client here (build-mingw), then staged into build-mingw/dist';
}
$('#btnSaveCfg').onclick = async () => {
  const values = {};
  for (const i of $$('#cfgForm input')) if (!i.disabled) values[i.name] = i.value;
  if (!cfg.remote) values.StaffFakeAuthFrom = $('#staffFrom') ? $('#staffFrom').value : cfg.values.StaffFakeAuthFrom;
  const r = await call('writeCfg', values, 'Saved servers.cfg. Restart all to apply.');
  if (r && r.ok !== false) loadSettings();
};
// Network: what other computers need to reach this shard
function renderNetwork() {
  const box = $('#netBox');
  if (cfg.remote) {
    box.innerHTML = `<p>The shard runs on <b>${esc(cfg.remote.name)}</b> (${esc(cfg.remote.ssh)}). Players connect to <code>${esc(cfg.values.AdvertisedIp || '?')}</code>; staff logins come from <code>${esc(cfg.values.StaffFakeAuthFrom)}</code>. Both are set in the Machines tab. The settings below are the source here, copied over when saved.</p>
      <div class="row"><button id="btnManifest">Launcher manifest for it</button></div>`;
  } else {
    const n = cfg.network || { addresses: [] };
    const adv = cfg.values.AdvertisedIp || '';
    const lan = n.addresses.find((a) => a.address === adv);
    box.innerHTML = `<p>Players on other computers connect to the <b>Advertised IP</b>. <code>127.0.0.1</code> works on this computer only. This computer's addresses:</p>
      <div class="addrs">${n.addresses.length ? n.addresses.map((a) => `<button data-useip="${esc(a.address)}" title="${esc(a.name)}, network ${esc(a.network)}">Use ${esc(a.address)} <span class="dim">(${esc(a.name)})</span></button>`).join('') : '<span class="dim">none found</span>'}
        <button data-useip="127.0.0.1">Use 127.0.0.1 <span class="dim">(this computer only)</span></button></div>
      <div class="form row">
        <label>Staff logins from <input id="staffFrom" value="${esc(cfg.values.StaffFakeAuthFrom)}" placeholder="this computer only">
          <span class="hint dim">With fake auth, other computers that get the staff levels: addresses or networks, comma separated${n.addresses[0] ? `, like ${esc(n.addresses[0].network)}` : ''}. Empty: this computer only.</span></label>
      </div>
      <p class="dim">Also: <b>Share the status page</b> (Optimizations) for launchers on other computers, the ServerListConfig IP below for the client's server list, and the firewall: macOS asks to allow the servers the first time. For players outside your network, the router has to forward the ports (docs/REMOTE_SHARD.md).</p>
      <div class="row"><button id="btnManifest" ${adv && adv !== '127.0.0.1' ? '' : 'disabled title="Set the Advertised IP to an address on your network first"'}>Launcher manifest for ${esc(adv && adv !== '127.0.0.1' ? adv : 'this address')}</button>
        ${lan ? '' : adv && adv !== '127.0.0.1' ? `<span class="warnline">${esc(adv)} isn't one of this computer's addresses</span>` : ''}</div>`;
  }
  box.onclick = async (e) => {
    const ip = e.target.closest('[data-useip]');
    if (ip) {
      const i = $('#cfgForm input[name="AdvertisedIp"]');
      if (i) i.value = ip.dataset.useip;
      toast(`Advertised IP: ${ip.dataset.useip}. Save, then restart all.`, '', 'ok');
      return;
    }
    if (e.target.id === 'btnManifest') {
      const r = await call('writeManifest', cfg.values.AdvertisedIp);
      if (r && r.ok) toast('Launcher manifest written', `${r.file}: in the launcher, From file...`, 'ok');
    }
  };
}
// ---- Database import ----

function importArgs(dryRun) {
  const f = $('#importForm');
  const map = {};
  for (const pair of f.map.value.split(/[\s,]+/).filter(Boolean)) {
    const [k, v] = pair.split('=');
    if (!/^\w+$/.test(k || '') || !/^\w+$/.test(v || '')) { toast('Other names: Name=cohdb, comma separated', '', 'error'); return null; }
    map[k] = v;
  }
  if (!f.dir.value) { toast('Choose the folder with the backups first', '', 'error'); return null; }
  return { dir: f.dir.value, dryRun, quick: f.quick.checked, force: f.force.checked, stopShard: f.stopShard.checked, map };
}
$('#btnPickImport').onclick = async () => {
  const dir = await window.shard.pickFolder('The folder with the other server\'s .bak files');
  if (dir) $('#importForm').dir.value = dir;
};
async function runImport(dryRun) {
  const a = importArgs(dryRun);
  if (!a) return;
  if (!dryRun && !confirm(`Import the databases in ${a.dir} into ${target.kind === 'remote' ? target.name : 'this shard'}? ${a.stopShard ? 'The shard stops for it and starts again after.' : 'The shard has to be stopped already.'} This shard's own databases are backed up and kept, and Undo puts them back.`)) return;
  if (target.kind === 'remote') selectLog('machine', 'Machine', 'tools/remote-shard.sh: copying, ssh, setup', null);
  else showTab('activity');
  for (const b of ['#btnImportCheck', '#btnImport']) $(b).disabled = true;
  const r = await call('importDatabases', a);
  for (const b of ['#btnImportCheck', '#btnImport']) $(b).disabled = false;
  if (r && r.reportDir) toast(r.ok ? (dryRun ? 'Check passed: nothing changed' : 'Import done') : 'Import stopped: nothing changed', `Report: ${r.reportDir}`, r.ok ? 'ok' : 'error');
}
$('#btnImportCheck').onclick = () => runImport(true);
$('#btnImport').onclick = () => runImport(false);
$('#rollbackForm').onsubmit = async (e) => {
  e.preventDefault();
  const stamp = e.target.stamp.value.trim();
  if (!/^\d{14}$/.test(stamp)) { toast('The import\'s stamp: 14 digits, its folder name in .local/imports', '', 'error'); return; }
  if (!confirm(`Put this shard's databases from before import ${stamp} back? The imported ones are kept under another name.`)) return;
  await call('importRollback', stamp, 'Import undone');
};

$('#grantForm').onchange = async (e) => {
  const r = await call('writeGrants', e.target.value, 'Saved. Restart the AccountServer, then log in again.');
  if (r && r.ok === false) loadSettings();
};
$('#listForm').onsubmit = async (e) => {
  e.preventDefault();
  await call('writeServerList', { name: e.target.name.value, ip: e.target.ip.value }, 'Saved the server list');
};
$('#appForm').onchange = async () => {
  const f = $('#appForm');
  info.settings = await window.shard.setSettings({ startSql: f.startSql.checked, notify: f.notify.checked, autoRestart: f.autoRestart.checked,
    buildDir: f.buildDir.value.trim() || 'build-native' });
};

// ---- Staff ----

async function loadStaff() {
  const c = await window.shard.readCfg();
  if (!c || c.ok === false) return;
  $('#staffTable tbody').innerHTML = c.staff.length ? c.staff.map((s) => `
    <tr><td>${esc(s.account)}</td><td>${s.level}</td>
      <td><button class="link danger" data-remove="${esc(s.account)}">remove</button></td></tr>`).join('')
    : '<tr><td colspan="3" class="dim">No staff accounts</td></tr>';
  searchCharacters();
  loadAccounts();
}

// ---- Accounts (real auth) ----

async function loadAccounts() {
  const r = await window.shard.accounts();
  const body = $('#acctTable tbody');
  if (!r || r.ok === false) {
    const err = (r && r.error) || '';
    body.innerHTML = `<tr><td colspan="5" class="dim">${esc(/cohauth|Invalid object|Cannot open database/i.test(err) ? 'No AuthServer database yet: start SQL Server (tools/db-up.sh makes cohauth)' : `Couldn't read the accounts: ${err}`)}</td></tr>`;
    return;
  }
  const real = status && status.realAuth;
  body.innerHTML = r.rows.length ? r.rows.map((a) => `
    <tr><td>${esc(a.account)}</td><td>${a.uid}</td>
      <td>${a.blocked ? '<span class="warnline">blocked</span>' : a.hasPassword ? 'active' : '<span class="warnline">no password</span>'}</td>
      <td class="dim">${esc(a.last || 'never')}</td>
      <td><button class="link" data-pw="${esc(a.account)}">password</button> ${a.linked ? '' : `<button class="link" data-link="${esc(a.account)}" title="Its uid becomes the id fake auth used for this name, so the characters made under fake auth are this account's">link fake-auth characters</button> `}<button class="link ${a.blocked ? '' : 'danger'}" data-block="${esc(a.account)}" data-to="${a.blocked ? 0 : 1}">${a.blocked ? 'unblock' : 'block'}</button></td></tr>`).join('')
    : `<tr><td colspan="5" class="dim">No accounts yet${real ? ': nobody can log in until there is one' : ''}</td></tr>`;
}
$('#acctForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await call('setAccount', { account: f.account.value.trim(), password: f.password.value, create: true });
  if (r && r.ok !== false) { f.account.value = ''; f.password.value = ''; loadAccounts(); }
};
$('#acctTable').onclick = async (e) => {
  const pw = e.target.dataset.pw;
  if (pw) {
    // A small inline form: Electron has no prompt()
    const row = e.target.closest('tr');
    if (row.nextElementSibling && row.nextElementSibling.classList.contains('pwrow')) return;
    const tr = document.createElement('tr');
    tr.className = 'pwrow';
    tr.innerHTML = `<td colspan="5"><form class="form row"><label>New password for ${esc(pw)} <input type="password" minlength="6" maxlength="16" autocomplete="new-password"></label><button type="submit">Save</button> <button type="button" class="link">cancel</button></form></td>`;
    row.after(tr);
    const form = tr.querySelector('form');
    form.querySelector('input').focus();
    form.querySelector('.link').onclick = () => tr.remove();
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const res = await call('setAccount', { account: pw, password: form.querySelector('input').value });
      if (res && res.ok !== false) { tr.remove(); loadAccounts(); }
    };
    return;
  }
  const ln = e.target.dataset.link;
  if (ln) {
    if (!confirm(`Give ${ln} the characters made under fake auth with that name? Log in again after.`)) return;
    await call('setAccount', { account: ln, relink: true });
    loadAccounts();
    return;
  }
  const acc = e.target.dataset.block;
  if (acc) {
    const to = e.target.dataset.to === '1';
    if (to && !confirm(`Block ${acc}? It can't log in until unblocked.`)) return;
    await call('setAccount', { account: acc, blocked: to });
    loadAccounts();
  }
};
$('#staffTable').onclick = async (e) => {
  const acc = e.target.dataset.remove;
  if (acc && confirm(`Remove staff access for ${acc}? It applies at their next login.`)) {
    await call('setStaff', { account: acc, level: 0 }, `${acc} removed`);
    loadStaff();
  }
};
$('#staffForm').onsubmit = async (e) => {
  e.preventDefault();
  await call('setStaff', { account: e.target.account.value.trim(), level: e.target.level.value }, 'Saved. It applies at the next login.');
  e.target.account.value = '';
  loadStaff();
};

async function searchCharacters() {
  const f = $('#charForm');
  $('#charNote').textContent = 'Searching...';
  const r = await window.shard.characters({ search: f.search.value, minLevel: f.minLevel.value });
  const running = status && status.servers.some((s) => s.name === 'DBServer' && s.state !== 'down');
  if (!r.ok) {
    $('#charNote').textContent = `Couldn't read the database: ${r.error}`;
    $('#charTable tbody').innerHTML = '';
    return;
  }
  $('#charNote').textContent = `${r.rows.length} characters.${running ? ' Changing a character\'s level needs the shard stopped (the Database Server would write its copy back).' : ''}`;
  $('#charTable tbody').innerHTML = r.rows.map((c) => `
    <tr><td>${esc(c.name)}</td><td>${esc(c.account)}</td><td>${c.level}</td>
      <td><input type="number" min="0" max="11" value="${c.access}" data-id="${c.id}" ${running ? 'disabled' : ''}></td>
      <td>${c.accountAccess}</td><td class="dim">${esc(c.last || '')}</td>
      <td><button data-set="${c.id}" ${running ? 'disabled' : ''}>Set</button></td></tr>`).join('');
}
$('#charForm').onsubmit = (e) => { e.preventDefault(); searchCharacters(); };
$('#charTable').onclick = async (e) => {
  const id = e.target.dataset.set;
  if (!id) return;
  const input = $(`#charTable input[data-id="${id}"]`);
  await call('setCharacterAccess', { id: +id, level: input.value }, 'Access level saved');
  searchCharacters();
};

// ---- Tracker ----

// The little Markdown the lists use: **bold** and `code`
const md = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');

async function loadTracker() {
  const t = await window.shard.readTracker();
  if (!t || t.ok === false) return;
  const open = t.tests.filter((x) => !x.done);
  const done = t.tests.filter((x) => x.done);
  const item = (x) => `<li class="${x.done ? 'done' : ''}"><input type="checkbox" data-line="${x.line}" ${x.done ? 'checked' : ''}><span class="txt">${md(x.text)}</span></li>`;
  $('#testList').innerHTML = open.length ? open.map(item).join('') : '<li class="dim">Nothing waiting on a test</li>';
  $('#testDoneList').innerHTML = done.map(item).join('');
  $('#testCount').textContent = `(${open.length} open)`;
  $('#testDoneCount').textContent = `(${done.length})`;
  $('#todoList').innerHTML = t.todo.map((x) => `<li>${md(x.text)}</li>`).join('');
  $('#todoCount').textContent = `(${t.todo.length})`;
  $('#testBadge').textContent = open.length;
  $('#testBadge').classList.toggle('hidden', !open.length);
}
$('#pane-tracker').onchange = async (e) => {
  const line = e.target.dataset.line;
  if (line === undefined) return;
  await call('setTestDone', { line: +line, done: e.target.checked });
  loadTracker();
};
$('#btnReloadTracker').onclick = loadTracker;

// ---- Machines ----

let machineList = [];
const stateWords = { connected: 'connected', connecting: 'connecting...', down: 'not reachable', idle: '', closed: '' };

function renderTarget() {
  const sel = $('#targetSel');
  sel.innerHTML = `<option value="local">This computer</option>${machineList.map((m) => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}<option value="__manage">Machines...</option>`;
  sel.value = target.id;
  $('#targetDot').className = `dot ${target.state}`;
  $('#targetDot').title = target.kind === 'local' ? 'This computer' : `${target.ssh}: ${stateWords[target.state] || target.state}${target.error ? `: ${target.error}` : ''}`;
  $('#machineLogItem').classList.toggle('hidden', target.kind !== 'remote');
  const n = $('#connNotice');
  const show = target.kind === 'remote' && target.state !== 'connected';
  n.classList.toggle('hidden', !show);
  n.classList.toggle('bad', target.state === 'down');
  if (show) {
    $('#connText').textContent = target.state === 'down'
      ? `Can't reach ${target.name}: ${target.error}${/Try again\.$|terminal\.$/.test(target.error || '') ? '' : '. Trying again on its own.'}`
      : `Connecting to ${target.name} (${target.ssh}): copying the source, then the control service...`;
  }
  $('#btnClient').title = target.kind === 'remote' ? `The game here, connected to ${target.name} (tools/remote-shard.sh client)` : 'tools/run-client.sh';
}

$('#targetSel').onchange = async (e) => {
  const v = e.target.value;
  if (v === '__manage') { e.target.value = target.id; showTab('machines'); return; }
  await call('useTarget', v);
};

async function loadMachines() {
  const r = await window.shard.machines();
  if (!r || r.ok === false) return;
  machineList = r.list;
  target = r.target;
  renderTarget();
  const cards = [{ id: 'local', name: 'This computer', d: 'the shard in this repo' }, ...machineList.map((m) => ({ ...m,
    d: `${m.ssh}${m.port !== '22' ? `:${m.port}` : ''} · ~/${m.dir} · ${m.box === 'none' ? 'no container' : `container ${m.box}`} · players: ${m.ip || 'the SSH address'} · staff from ${m.staffFrom}` }))];
  $('#machineList').innerHTML = cards.map((m) => {
    const on = m.id === target.id;
    const st = on ? target.state : '';
    return `<li class="${on ? 'on' : ''}">
      <div class="h">${on ? `<span class="dot ${st}"></span>` : ''}${esc(m.name)}${on ? ` <span class="dim">(${m.id === 'local' ? 'picked' : esc(stateWords[st] || st)})</span>` : ''}</div>
      <div class="d">${esc(m.d)}</div>
      ${on && target.error ? `<div class="err">${esc(target.error)}</div>` : ''}
      <div class="b">${on ? '' : `<button data-use="${esc(m.id)}">Use</button>`}
        ${m.id === 'local' ? '' : `<button data-edit="${esc(m.id)}">Edit</button><button class="danger" data-del="${esc(m.id)}">Delete</button>`}</div>
    </li>`;
  }).join('');
  $('#machineSteps').classList.toggle('hidden', target.kind !== 'remote');
  $('#stepsName').textContent = target.kind === 'remote' ? target.name : '';
  for (const b of $$('#machineSteps button')) b.disabled = !!target.busy;
}

function editMachine(m) {
  const f = $('#machineForm');
  f.classList.remove('hidden');
  $('#machineFormTitle').textContent = m ? `Edit ${m.name}` : 'Add a Machine';
  $('#machineFormNote').textContent = '';
  for (const k of ['id', 'name', 'ssh', 'port', 'ip', 'dir', 'box', 'staffFrom']) f[k].value = m ? (m[k] || '') : '';
  if (!m) { f.port.value = '22'; f.dir.value = 'Incarnate'; f.box.value = 'incarnate'; f.staffFrom.value = 'auto'; }
  f.ssh.focus();
}
$('#btnAddMachine').onclick = () => editMachine(null);
$('#btnCancelMachine').onclick = () => $('#machineForm').classList.add('hidden');
$('#machineForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const p = {};
  for (const k of ['id', 'name', 'ssh', 'port', 'ip', 'dir', 'box', 'staffFrom']) p[k] = f[k].value.trim();
  if (!p.id) delete p.id;
  const r = await window.shard.saveMachine(p);
  if (!r || r.ok === false) { $('#machineFormNote').textContent = r ? r.error : 'Not saved'; return; }
  f.classList.add('hidden');
  toast(`Saved ${r.saved.name}`, target.id === r.saved.id ? 'Reconnecting with the new settings' : 'Pick it at the top to use it', 'ok');
  loadMachines();
};
$('#machineList').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.use) { await call('useTarget', b.dataset.use); loadMachines(); }
  if (b.dataset.edit) editMachine(machineList.find((m) => m.id === b.dataset.edit));
  if (b.dataset.del) {
    const m = machineList.find((x) => x.id === b.dataset.del);
    if (m && confirm(`Delete ${m.name} from this list? Nothing on the machine changes; its shard keeps running.`)) { await call('deleteMachine', m.id); loadMachines(); }
  }
};
$('#machineSteps').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.term) {
    const r = await call('machineTerminal', b.dataset.term);
    if (r && r.ok) {
      $('#termCmd').classList.remove('hidden');
      $('#termCmd').textContent = r.opened ? `Opened in Terminal:\n${r.command}` : `Run this in a terminal:\n${r.command}`;
    }
    return;
  }
  const step = b.dataset.step;
  if (step === 'copy-db' && !confirm(`Replace ${target.name}'s databases (characters, accounts) with this computer's? The shard there stops. SQL Server here has to be running.`)) return;
  // The output shows right here, under the buttons, as it comes (and stays in the Machine log)
  const label = b.textContent.replace(/^\d\. /, '');
  stepRunning = true;
  $('#stepBox').classList.remove('hidden');
  $('#stepTitle').textContent = label;
  $('#stepState').textContent = 'running...';
  $('#stepState').className = 'dim';
  $('#stepOut').innerHTML = '';
  const r = await call('machineStep', step);
  stepRunning = false;
  const ok = r && r.ok;
  $('#stepState').textContent = ok ? 'done' : `failed${r && r.error ? `: ${r.error}` : ''}`;
  $('#stepState').className = ok ? 'okline' : 'warnline';
  if (step === 'connect' && !$('#stepOut').textContent.trim()) appendStepOut(ok ? 'Connected.\n' : `${(r && r.error) || 'Not connected'}\n`);
  loadMachines();
};

// Step output in the Machines tab
let stepRunning = false;
function appendStepOut(text) {
  const out = $('#stepOut');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  for (const line of text.split('\n')) {
    if (!line && out.lastChild) { out.append('\n'); continue; }
    const c = lineClass(line);
    const span = document.createElement('span');
    if (c) span.className = c;
    span.textContent = line;
    out.append(span, '\n');
  }
  if (atBottom) out.scrollTop = out.scrollHeight;
}
$('#btnStepClose').onclick = () => $('#stepBox').classList.add('hidden');
$('#btnStepLog').onclick = () => selectLog('machine', 'Machine', 'tools/remote-shard.sh: copying, ssh, setup', null);
$('#btnStepCopy').onclick = async () => {
  await window.shard.copyText(`${$('#stepTitle').textContent} (${target.name}):\n${$('#stepOut').textContent}`);
  toast('Copied', '', 'ok');
};

window.shard.onTarget(async (t) => {
  const changed = t.id !== target.id;
  const nowUp = t.state === 'connected' && target.state !== 'connected';
  target = t;
  renderTarget();
  if ($('#pane-machines').classList.contains('on')) loadMachines();
  if (changed || nowUp) await reloadAll();
});

// Everything the window shows comes from the picked shard: read it all again
async function reloadAll() {
  info = await window.shard.info();
  if (info && info.ok !== false) renderClientOpts();
  status = await window.shard.status();
  if (status && status.ok !== false) renderServers();
  loadSettings();
  if ($('#pane-staff').classList.contains('on')) loadStaff();
  $('#activityList').innerHTML = '';
  const db = status && status.servers ? status.servers.find((s) => s.name === 'DBServer') : null;
  selectLog('DBServer', 'DBServer', db ? db.about : '', 'DBServer');
}

// ---- Light and dark ----

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  $$('#theme button').forEach((b) => b.classList.toggle('on', b.dataset.theme === t));
  window.shard.setTheme(t); // the window frame and scrollbars follow too
}
$('#theme').onclick = async (e) => {
  const t = e.target.dataset.theme;
  if (!t) return;
  applyTheme(t);
  info.settings = await window.shard.setSettings({ theme: t });
};

// ---- Start ----

(async () => {
  const m = await window.shard.machines();
  if (m && m.list) { machineList = m.list; target = m.target; }
  renderTarget();
  info = await window.shard.info();
  applyTheme(info.settings.theme || 'system');
  renderClientOpts();
  status = await window.shard.status();
  renderServers();
  loadSettings();
  loadTracker();
  const db = status.servers.find((s) => s.name === 'DBServer');
  selectLog('DBServer', 'DBServer', db ? db.about : '', 'DBServer');
})();

// ---- Messages to players and schedules (backend: Shard.broadcast, schedulerTick) ----

let lastMessages = null;
let plannedTimer = null;

function renderPlanned(p) {
  clearInterval(plannedTimer);
  $('#plannedNotice').classList.toggle('hidden', !p);
  if (!p) return;
  const draw = () => {
    const left = Math.max(0, Math.round((p.at - Date.now()) / 1000));
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    $('#plannedText').textContent = `Restart at ${new Date(p.at).toLocaleTimeString()} (in ${mm}:${ss}). Players are being warned in chat${p.message ? `: "${p.message}"` : ''}.`;
  };
  draw();
  plannedTimer = setInterval(draw, 1000);
}

const repeatText = (every) => !every ? 'Once' : every === 60 ? 'Every hour' : every === 1440 ? 'Every day'
  : every === 10080 ? 'Every week' : every % 1440 === 0 ? `Every ${every / 1440} days` : `Every ${every} minutes`;
// datetime-local wants local time without a zone
const localInput = (t) => { const d = new Date(t - new Date(t).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

async function loadMessages() {
  const r = await window.shard.schedules();
  if (!r || r.ok === false) return;
  lastMessages = r;
  const tb = $('#schedTable tbody');
  tb.innerHTML = r.schedules.length ? r.schedules.map((x) => `<tr data-id="${esc(x.id)}">
      <td>${x.kind === 'restart' ? `<b>Restart</b>${x.warn ? `<div class="dim">warns ${x.warn} min before</div>` : ''}` : 'Message'}</td>
      <td>${esc(x.text) || '<span class="dim">(none)</span>'}</td>
      <td>${esc(new Date(x.at).toLocaleString())}</td>
      <td>${esc(repeatText(x.every))}</td>
      <td><input type="checkbox" data-act="toggle" ${x.enabled ? 'checked' : ''}></td>
      <td><button class="link" data-act="edit">Edit</button> <button class="link danger" data-act="del">Delete</button></td></tr>`).join('')
    : '<tr><td colspan="6" class="dim">Nothing scheduled</td></tr>';
  $('#restartMsgForm').text.value = r.restartMessage || '';
  $('#msgHistory').innerHTML = r.history.map((h) => `<li><span class="dim">${esc(new Date(h.time).toLocaleString())}</span> <span class="${h.ok ? 'ok' : 'warn'}">${h.ok ? 'sent' : 'not sent'}</span> ${esc(h.text)}${h.ok ? '' : ` <span class="dim">(${esc(h.error)})</span>`}</li>`).join('')
    || '<li class="dim">Nothing sent yet</li>';
  const f = $('#schedForm');
  if (!f.at.value) f.at.value = localInput(Date.now() + 60 * 60000);
}

function schedFormKind() {
  const f = $('#schedForm');
  $('#warnLabel').classList.toggle('hidden', f.kind.value !== 'restart');
  $('#everyLabel').classList.toggle('hidden', f.repeat.value !== 'custom');
  f.text.placeholder = f.kind.value === 'restart' ? 'added to the warnings (optional)' : 'Double XP all weekend!';
}
$('#schedForm').kind.onchange = schedFormKind;
$('#schedForm').repeat.onchange = schedFormKind;

function resetSchedForm() {
  const f = $('#schedForm');
  f.reset();
  f.id.value = '';
  f.at.value = localInput(Date.now() + 60 * 60000);
  f.querySelector('button[type=submit]').textContent = 'Add';
  $('#btnSchedCancel').classList.add('hidden');
  schedFormKind();
}
$('#btnSchedCancel').onclick = resetSchedForm;

$('#schedForm').onsubmit = async (e) => {
  e.preventDefault();
  const f = e.target;
  const every = f.repeat.value === 'custom' ? +f.every.value : +f.repeat.value;
  const item = { id: f.id.value || undefined, kind: f.kind.value, text: f.text.value, at: new Date(f.at.value).getTime(), every, warn: +f.warn.value };
  const r = await call('saveSchedule', item, f.id.value ? 'Schedule saved' : 'Scheduled');
  if (r && r.ok !== false) { resetSchedForm(); loadMessages(); }
};

$('#schedTable').onclick = async (e) => {
  const tr = e.target.closest('tr[data-id]');
  const act = e.target.dataset.act;
  if (!tr || !act || !lastMessages) return;
  const x = lastMessages.schedules.find((y) => y.id === tr.dataset.id);
  if (!x) return;
  if (act === 'del') { await call('deleteSchedule', x.id); loadMessages(); }
  if (act === 'toggle') { await call('saveSchedule', { ...x, enabled: e.target.checked, at: Math.max(x.at, Date.now() + 1000) }); loadMessages(); }
  if (act === 'edit') {
    const f = $('#schedForm');
    f.id.value = x.id; f.kind.value = x.kind; f.text.value = x.text; f.at.value = localInput(x.at);
    const preset = ['0', '60', '1440', '10080'].includes(String(x.every));
    f.repeat.value = preset ? String(x.every) : 'custom';
    f.every.value = x.every || 30;
    f.warn.value = String(x.warn || 0);
    f.querySelector('button[type=submit]').textContent = 'Save';
    $('#btnSchedCancel').classList.remove('hidden');
    schedFormKind();
  }
};

$('#msgForm').onsubmit = async (e) => {
  e.preventDefault();
  const r = await call('broadcast', e.target.text.value, 'Sent to every player');
  if (r && r.ok !== false) e.target.text.value = '';
  loadMessages();
};

$('#restartMsgForm').onsubmit = async (e) => {
  e.preventDefault();
  await call('setSettings', { restartMessage: e.target.text.value.trim() }, 'Saved');
  loadMessages();
};
schedFormKind();

// ---- Shards: zones, instances and players (backend: Shard.overview, playerAction) ----

let shardData = null;
let shardPick = null;   // player id shown in the card
let shardPoll = null;
let shardOpen = {};     // map id -> collapsed

let otherServersOpen = false;
function renderShardItem() {
  const up = status && status.servers.some((x) => x.name === 'DBServer' && x.state === 'up');
  const n = shardData && up ? shardData.players.length : null;
  const on = $('#pane-shard').classList.contains('on');
  const name = (status && status.serverName) || (status && status.shardName) || 'Shard';
  // The zones under it, busiest first (from the last overview)
  const zones = up && shardData ? shardData.maps.filter((m) => m.static).sort((a, b) => b.players - a.players || mapTitle(a).localeCompare(mapTitle(b))) : [];
  const hosted = (xshards && xshards.shards) || [];
  const others = ((status && status.serverNames) || []).filter((x) => !x.ours && !hosted.some((h) => h.name === x.name));
  const mainOpen = !!openShards[name];
  const caret = (key, open) => `<button class="caret" data-toggle="${esc(key)}" title="${open ? 'Hide' : 'Show'} its servers">${open ? '▾' : '▸'}</button>`;
  $('#shardList').innerHTML = `<li class="srv hascaret ${on ? 'sel' : ''}" id="shardItem" title="${esc(name)} in the game's server list (shard ${esc((status && status.shardName) || '')}, server id ${(status && status.serverId) || 1}). Click for its page: Services (what's up, starting or down) and Zones and players. The arrow shows its servers here.">
    ${caret(name, mainOpen)}<span class="dot ${up ? 'up' : 'down'}"></span><span class="nm">${esc(name)}</span>
    <span class="meta">${up ? (n === null ? 'players, zones' : `${n} player${n === 1 ? '' : 's'}`) : 'not running'}</span></li>
    ${mainOpen ? `<li class="grouphead nest">Its Servers</li>${localHtml}${zones.length ? '<li class="grouphead nest">Zones</li>' : ''}` : ''}
    ${mainOpen ? zones.map((m) => `<li class="srv sub nest" data-zone="${esc(m.zone || m.fileName)}"><span class="nm">${esc(m.zone || m.fileName)}</span><span class="meta">${m.players}</span></li>`).join('') : ''}
    ${hosted.map((h) => { const st = xsState(h); const open = !!openShards[h.name]; const srvs = (h.status && h.status.servers) || [];
      return `<li class="srv hascaret ${xsPick === h.name && $('#pane-xshard').classList.contains('on') ? 'sel' : ''}" data-xshard="${esc(h.name)}" title="Server ${h.id}, its own container, game clients on port ${h.port}">
      ${caret(h.name, open)}<span class="dot ${st.dot}"></span><span class="nm">${esc(h.name)}</span><span class="meta">${esc(st.text)}</span></li>
      ${open ? srvs.map((x) => `<li class="srv nest" data-xshard="${esc(h.name)}" data-xsserver="${esc(x.name)}"><span class="dot ${x.state === 'up' ? 'up' : x.state === 'starting' ? 'starting' : 'down'}"></span><span class="nm">${esc(serverTitle(x.name))}</span><span class="meta">${esc(x.state)}${x.pid ? ` · ${mb(Math.round(x.rssMB || 0))}` : ''}</span></li>`).join('')
        + ((h.status && h.status.maps) || []).map((x) => `<li class="srv nest" data-xshard="${esc(h.name)}" data-xsserver="${esc(x.logName || x.name)}"><span class="dot up"></span><span class="nm">${esc(x.name)}</span><span class="meta">${mb(Math.round(x.rssMB || 0))}</span></li>`).join('')
        || (open ? '<li class="srv nest dim">Not running</li>' : '') : ''}`; }).join('')}
    ${others.length ? `<li class="srv sub more" id="otherServers"><span class="nm dim">${otherServersOpen ? 'Hide' : 'Show'} the other ${others.length} server names</span></li>` : ''}
    ${otherServersOpen ? others.map((x) => `<li class="srv sub off" data-xstart="${esc(x.name)}" title="Not hosted here (server id ${x.id}). ${xshards && xshards.podman ? 'Start it as another shard on this machine, in its own container' : 'Other shards run on Linux (the Steam Machine): pick it at the top'}"><span class="dot down"></span><span class="nm">${esc(x.name)}</span><span class="meta">${xshards && xshards.podman ? '<button class="link" data-xstartbtn>Start</button>' : 'not hosted'}</span></li>`).join('') : ''}`;
}
$('#shardList').onclick = async (e) => {
  if (e.target.closest('#otherServers')) { otherServersOpen = !otherServersOpen; renderShardItem(); return; }
  const tg = e.target.closest('[data-toggle]');
  if (tg) {
    e.stopPropagation();
    openShards[tg.dataset.toggle] = !openShards[tg.dataset.toggle];
    renderShardItem();
    return;
  }
  // This shard's own servers and map servers: their log, like before
  const stop = e.target.closest('[data-stop]');
  if (stop) { e.stopPropagation(); await call('stopPid', +stop.dataset.stop, 'Stopped'); return; }
  const own = e.target.closest('li.nest[data-log]');
  if (own) { selectLog(own.dataset.log, own.dataset.title || own.dataset.log, own.title, own.dataset.restart); return; }
  const xs = e.target.closest('[data-xshard]');
  if (xs) {
    xsPick = xs.dataset.xshard; xsLogKey = ''; showTab('xshard'); renderShardItem();
    if (xs.dataset.xsserver) xsShowLog(xs.dataset.xsserver);
    return;
  }
  const st = e.target.closest('[data-xstartbtn]') && e.target.closest('[data-xstart]');
  if (st) { xsStart(st.dataset.xstart); return; }
  if (e.target.closest('.off')) return;
  const z = e.target.closest('[data-zone]');
  if (z) subTab.shard = 'zones';
  showTab('shard');
  $('#shardFilter').value = z ? z.dataset.zone : '';
  renderShard();
  renderShardItem();
};

function stopShardPoll() { clearInterval(shardPoll); shardPoll = null; }

async function loadShard() {
  if (!shardPoll) shardPoll = setInterval(() => { if ($('#pane-shard').classList.contains('on')) loadShard(); }, 5000);
  const r = await window.shard.overview();
  if (!r || r.ok === false) {
    $('#shardTitle').textContent = (status && status.shardName) || 'Shard';
    $('#shardSummary').textContent = r ? r.error : '';
    $('#shardMaps').innerHTML = '';
    shardData = null;
    renderShardItem();
    return;
  }
  shardData = r;
  renderShard();
  renderShardItem();
}
$('#btnShardRefresh').onclick = () => loadShard();
$('#shardFilter').oninput = () => renderShard();

const mapLabel = (m) => m.zone || (m.static ? m.fileName : `${m.mission ? 'Mission' : 'Instance'}: ${m.fileName}`);
// "Atlas Park: Map 1", "Mission: <file>, Map 12"
const mapTitle = (m) => (m.static ? `${mapLabel(m)}: Map ${m.id}` : `${mapLabel(m)}, Map ${m.id}`);

function renderShard() {
  const d = shardData;
  if (!d) return;
  $('#shardTitle').textContent = d.serverName || d.shard;
  renderStaffBox();
  const missions = d.maps.filter((m) => !m.static).length;
  const nz = d.maps.length - missions;
  $('#shardSummary').textContent = `${d.players.length} online · ${nz} zone${nz === 1 ? '' : 's'}, ${missions} mission${missions === 1 ? '' : 's'} and instances running`;
  const q = $('#shardFilter').value.trim().toLowerCase();
  const hit = (p, m) => !q || [p.name, p.account, p.zone, m && mapLabel(m)].some((x) => (x || '').toLowerCase().includes(q));
  // Missions and instances go under the zone their players came from
  const byId = new Map(d.maps.map((m) => [m.id, m]));
  const zones = d.maps.filter((m) => m.static);
  const kids = new Map();
  const loose = [];
  for (const m of d.maps.filter((x) => !x.static)) {
    const p = d.players.find((x) => x.map === m.id);
    const host = p ? p.staticMap : m.base;
    if (host && byId.has(host)) { if (!kids.has(host)) kids.set(host, []); kids.get(host).push(m); } else loose.push(m);
  }
  const players = (m) => d.players.filter((p) => p.map === m.id && hit(p, m)).map((p) => `
      <li class="pl ${shardPick === p.id ? 'sel' : ''}" data-pid="${p.id}"><span class="pn">${esc(p.name)}</span>
        <span class="dim">${p.loading ? '<span class="loadtag" title="Loading into a map">map xfer</span> ' : ''}Level ${p.level} ${esc(p.archetype)}</span>
        <span class="dim pa">@${esc(p.account)}${Math.max(p.access, p.accountAccess) >= 2 ? ' · staff' : ''}</span></li>`).join('');
  const block = (m, cls) => {
    const inner = (kids.get(m.id) || []).map((k) => block(k, 'inst')).join('');
    const pl = players(m);
    if (q && !pl && !inner && !mapLabel(m).toLowerCase().includes(q)) return '';
    return `<li class="${cls}"><div class="zh"><span>${esc(mapTitle(m))}${m.starting ? ' <span class="dim">(starting)</span>' : ''}</span>
      <span class="dim">${m.players} player${m.players === 1 ? '' : 's'}</span></div>${mapStats(m)}<ul>${pl}</ul>${inner ? `<ul>${inner}</ul>` : ''}</li>`;
  };
  const html = [...zones, ...loose].sort((a, b) => b.players - a.players || mapLabel(a).localeCompare(mapLabel(b)))
    .map((m) => block(m, 'zone')).join('');
  // Players on no map we know about (between maps)
  const lost = d.players.filter((p) => !byId.has(p.map) && hit(p));
  $('#shardMaps').innerHTML = html + (lost.length ? `<li class="zone"><div class="zh"><span>Between maps</span><span class="dim">${lost.length}</span></div><ul>${
    lost.map((p) => `<li class="pl ${shardPick === p.id ? 'sel' : ''}" data-pid="${p.id}"><span class="pn">${esc(p.name)}</span><span class="dim">${p.loading ? '<span class="loadtag" title="Loading into a map">map xfer</span> ' : ''}Map ${p.map}</span><span class="dim pa">@${esc(p.account)}</span></li>`).join('')}</ul></li>` : '')
    || '<li class="dim">Nobody online, and no zone running.</li>';
  renderShardStats();
  renderEnts();
  renderPlayerCard();
}

// ServerMonitor's View Ents: the Database Server's player list as a table, all of it (-1) or
// one map; null is hidden
let entsMap = null;
function renderEnts() {
  const box = $('#entsView');
  const d = shardData;
  if (!d || entsMap === null) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  const list = d.players.filter((p) => entsMap === -1 || p.map === entsMap).sort((a, b) => a.map - b.map || a.name.localeCompare(b.name));
  const m = d.maps.find((x) => x.id === entsMap);
  box.innerHTML = `<div class="zh"><b>View Ents: ${entsMap === -1 ? 'every map' : esc(m ? mapTitle(m) : `Map ${entsMap}`)}</b>
      <span>${entsMap !== -1 ? '<button class="mini" data-ents-all>All maps</button> ' : ''}<button class="mini" data-ents-close>Close</button></span></div>
    <table class="ents"><tr><th>Auth</th><th>Name</th><th>IP</th><th>Map</th><th>Static map</th><th>Team</th><th>Supergroup</th><th>Task force</th><th>League</th><th>Connected</th></tr>
    ${list.map((p) => `<tr data-pid="${p.id}" class="${shardPick === p.id ? 'sel' : ''}"><td>${esc(p.account)}</td><td>${esc(p.name)}</td><td>${esc(p.ip || '')}</td><td>${p.map}</td><td>${p.staticMap}</td>
      <td>${p.team || ''}</td><td>${p.supergroup || ''}</td><td>${p.taskforce || ''}</td><td>${p.league || ''}</td><td>${p.loading ? 'no' : 'yes'}</td></tr>`).join('')
      || '<tr><td colspan="10" class="dim">Nobody</td></tr>'}</table>`;
}
$('#entsView').onclick = (e) => {
  if (e.target.closest('[data-ents-close]')) { entsMap = null; renderShard(); return; }
  if (e.target.closest('[data-ents-all]')) { entsMap = -1; renderShard(); return; }
  const tr = e.target.closest('[data-pid]');
  if (tr) { shardPick = +tr.dataset.pid; renderShard(); }
};

// ServerMonitor's per-map columns, under each map's name (needs a DBServer with "stats")
function mapStats(m) {
  if (m.ents === undefined || !m.running) return '';
  const stale = m.secsSinceUpdate > 30;
  const bits = [
    `${m.heroes} hero${m.heroes === 1 ? '' : 'es'}, ${m.villains} villain${m.villains === 1 ? '' : 's'}`,
    `${m.monsters} critters, ${m.ents} entities`,
    `${m.ticksSec.toFixed(1)} ticks/s${m.longTick > 0.5 ? `, longest ${m.longTick.toFixed(2)} s` : ''}`,
    m.players ? `ping ${m.pingAvg} ms (worst ${m.pingMax})` : '',
    m.status ? esc(m.status) : '',
  ].filter(Boolean);
  return `<div class="mstats"><span class="${stale ? 'warn' : 'dim'}">${bits.join(' · ')}${stale ? ` · no word for ${m.secsSinceUpdate} s` : ''}</span>
    <span><button class="mini" data-ents="${m.id}" title="ServerMonitor's View Ents: everyone on this map, with their address, team, supergroup, task force and league">View Ents</button>
    <button class="mini" data-delink="${m.id}" title="ServerMonitor's Delink: the Database Server lets go of map server ${m.id} (for one that hangs). Its players go back to the login screen; logging in again starts a new one.">Delink</button></span></div>`;
}

const OVERLOAD_WHY = [[1, 'servers.cfg'], [2, 'launchers full'], [4, 'turned on here'], [8, 'SQL queue']];
const kb = (k) => (k >= 1048576 ? `${(k / 1048576).toFixed(1)} GB` : `${Math.round(k / 1024)} MB`);
const secsTag = (name, s) => (s < 0 ? '' : s > 30 ? `<span class="warn" title="Seconds since the Database Server last heard from it">${name}: ${s} s</span>` : '');

// ServerMonitor's shard numbers: logins, the SQL queue, Overload Protection, the launchers
function renderShardStats() {
  const box = $('#shardStats');
  const d = shardData;
  if (!d || !d.stats) { box.innerHTML = d ? '<p class="dim">Shard numbers need this Database Server build: Build all, then Restart all.</p>' : ''; return; }
  const st = d.stats;
  const xfer = d.players.filter((p) => p.loading).length;
  const why = OVERLOAD_WHY.filter(([b]) => st.overload & b).map(([, w]) => w);
  const ours = !!(st.overload & 4);
  const stale = [secsTag('MissionServer', st.missionServerSecs), secsTag('AuctionServer', st.auctionServerSecs),
    secsTag('AccountServer', st.accountServerSecs), secsTag('StatServer', st.statServerSecs),
    secsTag('ArenaServer', st.arenaServerSecs), secsTag('TurnstileServer', st.turnstileServerSecs)].filter(Boolean);
  box.innerHTML = `<div class="statrow">
      <div class="stat"><b>${st.connected}</b><span>connected</span></div>
      <div class="stat"><b>${st.loggingIn}</b><span>logging in</span></div>
      <div class="stat ${st.queued ? 'warnbox' : ''}"><b>${st.queued}</b><span>in the queue</span></div>
      <div class="stat"><b>${xfer}</b><span>map xfer</span></div>
      <div class="stat"><b>${st.entsLoaded}</b><span>characters loaded</span></div>
      <div class="stat ${st.sqlQueue > 100 ? 'warnbox' : ''}" title="SQL: waiting, done per second, average and worst time"><b>${st.sqlQueue}</b><span>SQL queue · ${st.sqlThroughput}/s · ${(st.sqlAvgLatUs / 1000).toFixed(1)} ms (worst ${(st.sqlWorstLatUs / 1000).toFixed(0)})</span></div>
      <div class="stat" title="The Database Server's main loop, per pass"><b>${(st.tickLen * 1000).toFixed(1)} ms</b><span>DB tick</span></div>
    </div>
    <div class="acts">
      <span class="${why.length ? 'warn' : 'dim'}">Overload Protection: ${why.length ? `on (${why.join(', ')})` : 'off'}</span>
      <button id="btnOverload" title="${ours ? 'Back to automatic: it comes on by itself when the launchers are full or SQL falls behind' : 'New logins wait in the queue and no new maps start, until you turn it back'}">${ours ? 'Back to automatic' : 'Turn on'}</button>
      <button id="btnViewEnts" title="ServerMonitor's View Ents: every player the Database Server has, as a table">${entsMap === null ? 'View Ents' : 'Hide Ents'}</button>
      <button id="btnMsReset" title="ServerMonitor's Reset Mission Link: the Database Server drops its MissionServer link and connects again (Architect searches stuck)">Reset Mission Link</button>
      ${stale.length ? `<span>${stale.join(' ')}</span>` : ''}
    </div>
    ${d.launchers && d.launchers.length ? `<table class="launchers"><tr><th>Launcher</th><th>CPU</th><th>Memory free</th><th>Map servers</th><th>Crashed</th><th>Crashes</th><th>Delinks</th></tr>
      ${d.launchers.map((l) => `<tr${l.suspended ? ' class="warn" title="Suspended: starts no maps"' : ''}><td>${esc(l.ip)} <span class="dim">(${l.cpus} cores)</span></td><td>${l.cpu}%</td>
        <td>${kb(l.memAvailKb)} of ${kb(l.memTotalKb)}</td><td>${l.mapservers}</td><td>${l.crashedMapservers}</td><td>${l.crashes}</td><td>${l.delinks}</td></tr>`).join('')}</table>` : ''}`;
}

$('#shardStats').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b || !shardData || !shardData.stats) return;
  b.disabled = true;
  if (b.id === 'btnOverload') {
    const on = !(shardData.stats.overload & 4);
    if (on && !confirm('Turn on Overload Protection? New logins wait in the queue and no new maps start until you turn it back.')) { b.disabled = false; return; }
    await call('serverAction', { action: 'overload', arg: on }, on ? 'Overload Protection on' : 'Overload Protection back to automatic');
  } else if (b.id === 'btnViewEnts') {
    entsMap = entsMap === null ? -1 : null;
    b.disabled = false;
    renderShard();
    return;
  } else if (b.id === 'btnMsReset') {
    await call('serverAction', { action: 'mslinkreset' }, 'Mission link reset');
  }
  b.disabled = false;
  setTimeout(loadShard, 1000);
};

$('#shardMaps').onclick = async (e) => {
  const ve = e.target.closest('[data-ents]');
  if (ve) { entsMap = +ve.dataset.ents; renderShard(); return; }
  const dl = e.target.closest('[data-delink]');
  if (dl) {
    const id = +dl.dataset.delink;
    if (!confirm(`Delink map server ${id}? The Database Server lets go of it; its players go back to the login screen.`)) return;
    dl.disabled = true;
    await call('serverAction', { action: 'delink', arg: id }, `Map ${id} delinked`);
    setTimeout(loadShard, 1500);
    return;
  }
  const li = e.target.closest('[data-pid]');
  if (!li) return;
  shardPick = +li.dataset.pid;
  renderShard();
};

let zoneList = null;
async function loadZones() {
  if (zoneList) return;
  const r = await window.shard.zones();
  if (r && r.ok) { zoneList = r.zones; renderPlayerCard(); }
}

function renderPlayerCard() {
  const box = $('#playerCard');
  const d = shardData;
  const p = d && d.players.find((x) => x.id === shardPick);
  if (!p) { box.innerHTML = '<p class="dim">Click a player.</p>'; return; }
  // Not while a list or the reason is being picked or typed (this redraws every 5 seconds)
  const busy = document.activeElement && box.contains(document.activeElement) && /^(SELECT|INPUT)$/.test(document.activeElement.tagName);
  if (busy && box.dataset.pid === String(p.id)) return;
  box.dataset.pid = String(p.id);
  loadZones();
  const m = d.maps.find((x) => x.id === p.map);
  const me = d.staffAs && d.players.find((x) => x.id === d.staffAs.charId && !x.loading);
  const meNote = !d.staffAs ? 'Log in above (Login for Controls) with a staff account first.'
    : !me ? `${esc(d.staffAs.charName)} isn't in the game. Spectate Player starts the game as it; Bring them to me needs it in the game.`
    : me.id === p.id ? 'That\'s your own character.' : '';
  const others = d.players.filter((x) => x.id !== p.id && !x.loading).sort((a, b) => a.name.localeCompare(b.name));
  const keep = (id) => { const el = $(`#${id}`); return el ? el.value : ''; };
  const zoneSel = keep('tpZone') || String(p.staticMap || '');
  const otherSel = keep('tpPlayer');
  if (p.loading) {
    // Handed to a map that hasn't taken them yet: only what the DBServer can do
    box.innerHTML = `<h3>${esc(p.name)} <span class="loadtag" title="Loading into a map">map xfer</span></h3>
      <dl>
        <dt>Account</dt><dd>@${esc(p.account)}</dd>
        <dt>Loading into</dt><dd>${esc(m ? mapTitle(m) : `Map ${p.map}`)}${m && m.starting ? ' <span class="dim">(the map is still starting)</span>' : ''}</dd>
        <dt>From</dt><dd>${esc(p.zone || `Map ${p.staticMap}`)}</dd>
      </dl>
      <p class="dim">Stuck on a loading screen: Log out sends them to the login screen; logging back in puts them in their zone when the map they were going to is gone. Kill its mapserver first if it's hung.</p>
      <div class="acts">
        <button data-act="stopMap" class="danger" title="Ends the map server for map ${p.map}">Kill mapserver ${p.map}</button>
        <button data-act="logout" class="danger" title="The Database Server logs them out (dbForceLogout)">Log out</button>
      </div>`;
    return;
  }
  box.innerHTML = `<h3>${esc(p.name)}</h3>
    <dl>
      <dt>Account</dt><dd>@${esc(p.account)} (auth id ${p.authId})</dd>
      <dt>Level</dt><dd>${p.level} ${esc(p.archetype)}</dd>
      <dt>Where</dt><dd>${esc(m ? mapTitle(m) : `Map ${p.map}`)}${p.onMission || (m && !m.static) ? `<div class="dim">from ${esc(p.zone || `Map ${p.staticMap}`)}</div>` : ''}</dd>
      <dt>Access</dt><dd>character ${p.access}, account ${p.accountAccess}</dd>
      ${p.team ? `<dt>Team</dt><dd>${p.team}</dd>` : ''}${p.supergroup ? `<dt>Supergroup</dt><dd>${p.supergroup}</dd>` : ''}${p.taskforce ? `<dt>Task force</dt><dd>${p.taskforce}</dd>` : ''}${p.league ? `<dt>League</dt><dd>${p.league}</dd>` : ''}
      ${p.ip ? `<dt>Address</dt><dd>${esc(p.ip)}</dd>` : ''}
    </dl>
    <h4>Teleport them</h4>
    <div class="acts">
      <button data-act="exitMission" ${m && !m.static ? '' : 'disabled'} title="Out of the mission or instance, to its door">Out of the mission</button>
      <button data-act="toZone" ${p.staticMap > 0 ? '' : 'disabled'} title="${esc(p.zone || '')}: the zone's spawn point">To ${esc(p.zone || 'their zone')}</button>
      <button data-act="stuck" title="The game's /stuck, as them">Unstuck</button>
    </div>
    <div class="acts tp">
      <select id="tpZone">${(zoneList || []).map((z) => `<option value="${z.id}" ${String(z.id) === zoneSel ? 'selected' : ''}>${esc(z.name)}</option>`).join('') || '<option value="">Loading zones...</option>'}</select>
      <button data-act="toMap" ${zoneList ? '' : 'disabled'} title="To that zone's spawn point (/mapmove)">Send to zone</button>
    </div>
    <div class="acts tp">
      <select id="tpPlayer">${others.map((x) => `<option value="${x.id}" ${String(x.id) === otherSel ? 'selected' : ''}>${esc(x.name)}${x.zone ? ` (${esc(x.zone)})` : ''}</option>`).join('') || '<option value="">Nobody else is online</option>'}</select>
      <button data-act="toPlayer" ${others.length ? '' : 'disabled'} title="To that player, into their mission too (/goto)">Send to player</button>
    </div>
    <h4>You and them${d.staffAs ? ` <span class="dim">(as ${esc(d.staffAs.charName)})</span>` : ''}</h4>
    <div class="acts">
      <button data-act="bring" ${me && me.id !== p.id ? '' : 'disabled'} title="Them to your character (/teleport)">Bring them to me</button>
      <button data-act="watch" ${d.staffAs && !(me && me.id === p.id) ? '' : 'disabled'} title="Your character goes invisible, untargetable and invincible, then to them, into their mission too (/invisible, /goto). Game closed: Shard Admin starts it as your character first.">Spectate Player</button>
    </div>
    ${meNote ? `<p class="dim">${meNote}</p>` : ''}
    <h4>Account</h4>
    <div class="acts">
      <button data-act="freeze" title="/freeze">Freeze</button><button data-act="unfreeze" title="/freeze 0">Unfreeze</button>
      <button data-act="kick" class="danger" title="/svrkick">Kick...</button>
      ${status && status.realAuth ? '<button data-act="block" class="danger" title="Staff tab, Accounts: no more logins until unblocked">Block account</button>' : ''}
    </div>
    <label>Kick reason <input id="kickReason" maxlength="200" placeholder="Kicked by staff" value="${esc(keep('kickReason'))}"></label>`;
}

$('#playerCard').onclick = async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b || !shardData) return;
  const p = shardData.players.find((x) => x.id === shardPick);
  if (!p) return;
  const act = b.dataset.act;
  if (act === 'block') {
    if (!confirm(`Block @${p.account}? They can't log in until it's unblocked (Staff tab, Accounts).`)) return;
    await call('setAccount', { account: p.account, blocked: true }, `Blocked @${p.account}`);
    await call('playerAction', { id: p.id, action: 'kick', arg: 'Your account is blocked' });
    return;
  }
  if (act === 'kick' && !confirm(`Kick ${p.name}?`)) return;
  if (act === 'stopMap' && !confirm(`Kill mapserver ${p.map}? Everyone on it goes back to the login screen.`)) return;
  if (act === 'logout' && !confirm(`Log ${p.name} out?`)) return;
  const arg = act === 'kick' ? $('#kickReason').value : act === 'toMap' ? $('#tpZone').value : act === 'toPlayer' ? $('#tpPlayer').value : undefined;
  b.disabled = true;
  if (act === 'watch') {
    // The game closed: Shard Admin starts it as your staff character, then goes
    const r = await call('ghostTo', { id: p.id });
    if (r && r.ok) toast(r.starting ? 'Starting the game' : 'Spectate Player: sent', r.starting ? 'It signs in as your staff character, then goes to them invisibly' : '', 'ok');
    b.disabled = false;
    return;
  }
  await call('playerAction', { id: p.id, action: act, arg }, `${b.textContent.trim()}: sent`);
  b.disabled = false;
  setTimeout(loadShard, 1500);
};

// ---- Staff sign-in: the account and character the Shards view acts as ----
let staffChars = null;
function renderStaffBox() {
  const box = $('#staffBox');
  const a = (shardData && shardData.staffAs) || (status && status.staffAs);
  const realAuth = status && status.realAuth;
  if (!a) {
    // This runs every 5 seconds: keep the form (and what's typed in it) unless it changed
    const mode = realAuth ? 'password' : 'nopassword';
    const form = box.querySelector('#staffSignIn');
    if (form && form.dataset.mode === mode) return;
    box.innerHTML = `<form id="staffSignIn" class="form row" data-mode="${mode}">
      <span class="dim">Login for Controls:</span>
      <input name="account" maxlength="14" autocomplete="username" placeholder="Username" aria-label="Username">
      ${realAuth ? '<input name="password" type="password" maxlength="16" autocomplete="current-password" placeholder="Password" aria-label="Password">' : '<span class="dim">(fake auth: no password)</span>'}
      <button type="submit" class="primary">Log in</button></form>`;
    return;
  }
  if (box.querySelector('#staffPick') && document.activeElement === box.querySelector('#staffPick')) return;
  const online = new Set(((shardData && shardData.players) || []).map((p) => p.id));
  const chars = staffChars || [{ id: a.charId, name: a.charName, staff: true, access: 0, accountAccess: 0, level: 0 }];
  box.innerHTML = `<div class="form row"><span>Logged in as <b>@${esc(a.account)}</b>, acting as</span>
    <select id="staffPick">${chars.map((c) => `<option value="${c.id}" ${c.id === a.charId ? 'selected' : ''} ${c.staff ? '' : 'disabled'}>${esc(c.name)}${c.level ? ` (level ${c.level}, access ${Math.max(c.access, c.accountAccess)})` : ''}${online.has(c.id) ? ' · online' : ''}${c.staff ? '' : ' · not staff'}</option>`).join('')}</select>
    <span class="dot ${online.has(a.charId) ? 'up' : 'down'}" title="${online.has(a.charId) ? 'In the game' : 'Not in the game: log in with it for Bring and Spectate Player'}"></span>
    <button id="btnStaffOut" class="link">Log out</button></div>`;
  if (!staffChars) window.shard.staffCharacters().then((r) => { if (r && r.ok) { staffChars = r.rows; renderStaffBox(); } });
}
$('#staffBox').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const r = await call('staffSignIn', { account: f.account.value, password: f.password ? f.password.value : '' });
  if (f.password) f.password.value = '';
  if (r && r.ok) { staffChars = r.characters; if (shardData) shardData.staffAs = r.staffAs; renderStaffBox(); renderPlayerCard(); }
});
$('#staffBox').addEventListener('change', async (e) => {
  if (e.target.id !== 'staffPick') return;
  const r = await call('staffPick', { id: +e.target.value });
  if (r && r.ok && shardData) { shardData.staffAs = r.staffAs; e.target.blur(); renderStaffBox(); renderPlayerCard(); }
});
$('#staffBox').addEventListener('click', async (e) => {
  if (e.target.id !== 'btnStaffOut') return;
  await call('staffSignOut');
  staffChars = null;
  if (shardData) shardData.staffAs = null;
  if (status) status.staffAs = null;
  renderStaffBox(); renderPlayerCard();
});

// ---- Memory errors (debug build) ----
$('#btnMemErrors').onclick = async () => {
  const r = await call('memoryErrors');
  if (!r || r.ok === false) return;
  await window.shard.copyText(r.text);
  $('#memNote').textContent = r.unique
    ? `${r.unique} different crashes and memory errors (${r.total} in all), copied. Most: ${r.summary.slice(0, 3).map((e) => `${e.kind} in ${e.where} (${e.count}x)`).join('; ')}. Also in .local/memory-errors.txt.`
    : `No crashes or memory errors in the logs${r.debug ? '' : '. For memory errors: Optimizations, Debug build, then Build all and Restart all'}.`;
  toast(r.unique ? `Copied ${r.unique} crashes and memory errors` : 'No crashes or memory errors', '', 'ok');
};


// ---- Chat: ChatAdmin (backend: Shard.chatLogin, chatPoll, chatRun; ChatServer shardnet.c) ----

const CH_JOIN = 1, CH_SEND = 2, CH_OP = 4;
let chat = null;          // the last poll
let chatSeq = 0;          // the newest line seen
let chatTimer = null;
let chatPick = '';        // channel shown in the middle
let chatUserPick = '';    // @handle in the card
let chatStatusOf = null;  // CsrStatus answer for chatUserPick
const chatMsgs = new Map(); // channel (lower case) -> [{ time, from, text, sys }]
const chatOther = [];       // everything else: tells, replies, errors

// A line from the ChatServer: its words, quoted ones whole and unescaped (backend.js chatWords)
function chatWords(line) {
  const un = (v) => v.replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', q: '"', s: "'", p: '%', d: '$', 0: '', '\\': '\\' })[c] ?? c);
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(un(m[1] !== undefined ? m[1] : m[2]));
  return out;
}

function chatKeep(list, item, max = 300) { list.push(item); if (list.length > max) list.splice(0, list.length - max); }

// Sort what came in: channel talk under its channel, the rest in the general list
function chatTake(lines) {
  const now = Date.now();
  for (const line of lines || []) {
    const w = chatWords(line);
    const k = w[0];
    if (k === 'ChanMsg') { chatKeep(chatList(w[1]), { time: now, from: w[2], text: w.slice(3).join(' ') }); continue; }
    if (k === 'ChanSysMsg') { chatKeep(chatList(w[1]), { time: now, sys: true, text: w.slice(2).join(' ') }); continue; }
    if (k === 'Join' || k === 'Leave') {
      // Join <chan> <who> <db id> <flags> <refresh>: a refresh is the member list, not news
      if (k === 'Join' && w[5] === '1') continue;
      chatKeep(chatList(w[1]), { time: now, sys: true, text: `${w[2]} ${k === 'Join' ? 'joined' : 'left'}` });
      continue;
    }
    if (k === 'CsrStatus') { chatStatusOf = { name: w[1], words: w }; renderChatUserCard(); continue; }
    if (k === 'UserMsg') { chatKeep(chatOther, { time: now, from: w[1], text: `(tell) ${w.slice(2).join(' ')}` }); continue; }
    if (k === 'SysMsg') { chatKeep(chatOther, { time: now, sys: true, text: w.slice(1).join(' ') }); continue; }
    if (k === 'CsrSendAll') { chatKeep(chatOther, { time: now, from: w[1], text: `(to everyone) ${w.slice(2).join(' ')}` }); continue; }
    if (/^(Login|LoginEnd|AccessLevel|Friend|Friends|Renameable|Watching|chanmember|Chaninfo|Channel|Invisible|Visible|chanmotd)$/.test(k)) {
      if (k === 'chanmotd') chatKeep(chatList(w[1]), { time: now, sys: true, text: `Message of the day: ${w.slice(4).join(' ') || w.slice(2).join(' ')}` });
      continue;
    }
    chatKeep(chatOther, { time: now, sys: true, text: w.join(' ') });
  }
}
function chatList(name) {
  const key = String(name || '').toLowerCase();
  if (!chatMsgs.has(key)) chatMsgs.set(key, []);
  return chatMsgs.get(key);
}

function stopChat() { clearInterval(chatTimer); chatTimer = null; }
function startChat() {
  if (!chatTimer) chatTimer = setInterval(() => { if ($('#pane-chat').classList.contains('on')) pollChat(); }, 2000);
  pollChat();
}

async function pollChat() {
  const r = await window.shard.chatPoll(chatSeq);
  if (!r || r.ok === false) {
    chat = null;
    $('#chatStatus').textContent = (r && r.error) || 'The ChatServer didn\'t answer';
    renderChat();
    return;
  }
  // The ChatServer restarted: its numbers start over
  if (r.seq < chatSeq) chatSeq = 0;
  chatTake(r.lines);
  chatSeq = r.seq;
  chat = r;
  renderChat();
}

async function chatRun(cmd, args, okText) {
  const r = await window.shard.chatRun({ cmd, args });
  if (r && r.lines) chatTake(r.lines);
  if (r && typeof r.seq === 'number' && r.seq > chatSeq) chatSeq = r.seq;
  // A reply that says what went wrong (SysMsg NotAllowed, InvalidUser ...)
  const err = r && r.lines && r.lines.map(chatWords).find((w) => /SysMsg$/.test(w[0]) && /Invalid|NotAllowed|NoPermission|DoesNotExist|NotInChannel|Failed|Wrong|TooLong|Bad/i.test(w.join(' ')));
  if (!r || r.ok === false) toast(`${cmd} failed`, (r && r.error) || '', 'error');
  else if (err) toast(`${cmd}: ${err.slice(err[0] === 'ChanSysMsg' ? 2 : 1).join(' ')}`, '', 'warn');
  else if (okText) toast(okText, '', 'ok');
  setTimeout(pollChat, 300);
  return r;
}

const chatIn = (name) => chat && chat.watching.find((w) => w.name.toLowerCase() === String(name).toLowerCase());
const chatAgo = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const mins = (secs) => (secs >= 3600 ? `${Math.round(secs / 3600)} h` : `${Math.max(1, Math.round(secs / 60))} min`);

function renderChat() {
  const on = !!(chat && chat.online);
  $('#btnChatLogin').classList.toggle('hidden', on);
  $('#btnChatLogout').classList.toggle('hidden', !on);
  if (chat) $('#chatStatus').textContent = on ? `Logged in as ${chat.me}` : 'Not logged in to chat (log in to join channels and moderate)';
  // Channels
  const cq = $('#chatChanFilter').value.trim().toLowerCase();
  const chans = chat ? chat.channels.filter((c) => !cq || c.name.toLowerCase().includes(cq)) : [];
  chans.sort((a, b) => (!!chatIn(b.name) - !!chatIn(a.name)) || b.online - a.online || a.name.localeCompare(b.name));
  $('#chatChanCount').textContent = chat ? `${chat.channels.length}` : '';
  $('#chatChannels').innerHTML = chans.slice(0, 300).map((c) => `<li class="${chatPick.toLowerCase() === c.name.toLowerCase() ? 'sel' : ''}" data-chan="${esc(c.name)}" title="${esc(c.description || '')}">
      <span class="pn">${chatIn(c.name) ? '● ' : ''}${esc(c.name)}</span><span class="dim">${c.online}/${c.members}</span></li>`).join('')
    || `<li class="dim">${chat ? 'No channels yet.' : ''}</li>`;
  // Players
  const uq = $('#chatUserFilter').value.trim().toLowerCase().replace(/^@/, '');
  const users = chat ? chat.users.filter((u) => !uq || u.name.toLowerCase().includes(uq)) : [];
  users.sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  $('#chatUserCount').textContent = chat ? `${chat.users.filter((u) => u.online).length} online` : '';
  $('#chatUsers').innerHTML = users.slice(0, 300).map((u) => `<li class="${chatUserPick === u.name ? 'sel' : ''}" data-user="${esc(u.name)}">
      <span class="pn">@${esc(u.name)}</span><span class="dim">${u.online ? '' : 'offline · '}${u.silencedSecs ? `silenced ${mins(u.silencedSecs)} · ` : ''}${u.chatBanSecs ? 'chat ban · ' : ''}${u.admin ? 'staff' : ''}</span></li>`).join('')
    || `<li class="dim">${chat ? 'Nobody in chat.' : ''}</li>`;
  renderChatChannel();
  renderChatUserCard();
}

function renderChatChannel() {
  const head = $('#chatChannelHead');
  const name = chatPick;
  const c = chat && name ? chat.channels.find((x) => x.name.toLowerCase() === name.toLowerCase()) : null;
  const w = c && chatIn(c.name);
  const on = !!(chat && chat.online);
  $('#chatSendForm').classList.toggle('hidden', !w);
  if (!name) {
    head.innerHTML = '<p class="dim">Pick a channel on the left. Joined ones (●) show what\'s said in them. Tells to ShardAdmin and replies show here meanwhile.</p>';
    renderChatLog(chatOther);
    $('#chatMembers').innerHTML = '';
    return;
  }
  if (!c) { chatPick = ''; renderChatChannel(); return; }
  head.innerHTML = `<h3>${esc(c.name)} <span class="dim">${c.online} online, ${c.members} members</span></h3>
    ${c.description ? `<p class="dim">${esc(c.description)}</p>` : ''}
    <div class="acts">
      ${w ? '<button data-chat="leave">Leave</button>' : `<button data-chat="join" class="primary" ${on ? '' : 'disabled'} title="Join it as ShardAdmin, to see what's said and moderate">Join</button>`}
      <button data-chat="motd" ${w ? '' : 'disabled'} title="ChanMotd">Message of the day...</button>
      <button data-chat="desc" ${w ? '' : 'disabled'} title="ChanDesc">Description...</button>
      <button data-chat="mute" ${w ? '' : 'disabled'} title="ChanMode -send: only operators can talk">Mute channel</button>
      <button data-chat="unmute" ${w ? '' : 'disabled'} title="ChanMode +send">Unmute</button>
      <button data-chat="kill" class="danger" ${on ? '' : 'disabled'} title="CsrChanKill: the channel is deleted, everyone in it leaves">Delete channel</button>
      <button data-chat="other" title="Tells to ShardAdmin, replies and errors">Other messages</button>
    </div>`;
  renderChatLog(w ? chatList(c.name) : null);
  if (!w) { $('#chatMembers').innerHTML = ''; return; }
  const members = [...w.members].sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  $('#chatMembers').innerHTML = `<h4>Members <span class="dim">(${members.length})</span></h4><table class="chatmembers">
    ${members.map((m) => `<tr data-member="${esc(m.name)}"><td><a href="#" data-pickuser="${esc(m.name)}">@${esc(m.name)}</a> <span class="dim">${m.online ? '' : 'offline'}${m.admin ? ' staff' : ''}${m.access & CH_OP ? ' operator' : ''}${m.access & CH_SEND ? '' : ' muted'}</span></td>
      <td class="acts">
        <button class="mini" data-mode="${m.access & CH_SEND ? '-send' : '+send'}" title="Their voice in this channel">${m.access & CH_SEND ? 'Mute' : 'Unmute'}</button>
        <button class="mini" data-mode="${m.access & CH_OP ? '-operator' : '+operator'}">${m.access & CH_OP ? 'Remove operator' : 'Make operator'}</button>
        <button class="mini danger" data-mode="-join" title="Out of the channel (UserMode -join)">Kick</button></td></tr>`).join('')}</table>`;
}

function renderChatLog(list) {
  const box = $('#chatLog');
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.innerHTML = list === null ? '<p class="dim">Join the channel to see what\'s said in it (from then on).</p>'
    : (list.map((m) => `<div class="${m.sys ? 'sys' : ''}"><span class="dim">${chatAgo(m.time)}</span> ${m.from ? `<b>@${esc(m.from)}</b> ` : ''}${esc(m.text)}</div>`).join('')
      || '<p class="dim">Nothing yet.</p>');
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function renderChatUserCard() {
  const box = $('#chatUserCard');
  if (!chatUserPick) { box.innerHTML = '<p class="dim">Click a player.</p>'; return; }
  const busy = document.activeElement && box.contains(document.activeElement) && /^(SELECT|INPUT)$/.test(document.activeElement.tagName);
  if (busy) return;
  const u = chat && chat.users.find((x) => x.name === chatUserPick);
  const st = chatStatusOf && chatStatusOf.name.toLowerCase() === chatUserPick.toLowerCase() ? chatStatusOf.words : null;
  const mine = chat ? chat.watching.map((w) => w.name) : [];
  const on = !!(chat && chat.online);
  box.innerHTML = `<h3>@${esc(chatUserPick)}</h3>
    <dl>
      ${u ? `<dt>Online</dt><dd>${u.online ? `yes${u.shard ? ` (${esc(u.shard)})` : ''}` : 'no'}</dd>
      <dt>Access</dt><dd>${u.access}${u.admin ? ' (staff)' : ''}</dd>
      ${u.silencedSecs ? `<dt>Silenced</dt><dd>${mins(u.silencedSecs)} more</dd>` : ''}${u.chatBanSecs ? `<dt>Chat ban</dt><dd>${mins(u.chatBanSecs)} more (spam reports)</dd>` : ''}
      <dt>Channels</dt><dd>${u.channels}</dd>` : '<dt>Status</dt><dd>offline, or not looked up yet</dd>'}
      ${st ? `<dt>Status</dt><dd>${esc(st.slice(2).join(' '))}</dd>` : ''}
    </dl>
    <div class="acts"><button data-uact="status" ${on ? '' : 'disabled'} title="CsrStatus: their channels, silence and shard">Status</button>
      <button data-uact="unsilence" ${on ? '' : 'disabled'}>Unsilence</button></div>
    <div class="acts tp"><select id="chatSilenceMins"><option value="10">10 minutes</option><option value="60">1 hour</option><option value="1440">1 day</option><option value="10080">1 week</option></select>
      <button data-uact="silence" class="danger" ${on ? '' : 'disabled'} title="CsrSilence: they can't talk in global chat or send tells">Silence</button></div>
    <div class="acts tp"><input id="chatTell" maxlength="250" placeholder="A tell from ShardAdmin"><button data-uact="tell" ${on ? '' : 'disabled'}>Send</button></div>
    <div class="acts tp"><select id="chatInviteTo">${mine.map((n) => `<option>${esc(n)}</option>`).join('') || '<option value="">Join a channel first</option>'}</select>
      <button data-uact="invite" ${on && mine.length ? '' : 'disabled'}>Invite</button></div>
    <div class="acts tp"><input id="chatNewName" maxlength="32" placeholder="New @handle"><button data-uact="rename" class="danger" ${on ? '' : 'disabled'} title="CsrName">Rename</button></div>
    <div class="acts"><button data-uact="renameable" ${on ? '' : 'disabled'} title="CsrGrantRename: they may pick a new handle once">Let them rename</button></div>`;
}

$('#btnChatLogin').onclick = async () => { const r = await call('chatLogin'); if (r && r.ok) pollChat(); };
$('#btnChatLogout').onclick = async () => { await call('chatLogout'); pollChat(); };
$('#chatChanFilter').oninput = () => renderChat();
$('#chatUserFilter').oninput = () => renderChat();
$('#chatChannels').onclick = (e) => { const li = e.target.closest('[data-chan]'); if (li) { chatPick = li.dataset.chan; renderChat(); } };
$('#chatUsers').onclick = (e) => { const li = e.target.closest('[data-user]'); if (li) { chatUserPick = li.dataset.user; renderChat(); } };
$('#chatCreateForm').onsubmit = async (e) => {
  e.preventDefault();
  const name = e.target.name.value.trim();
  if (!name) return;
  const r = await chatRun('Create', [name, ''], `Channel ${name} made`);
  if (r && r.ok) { chatPick = name; e.target.name.value = ''; }
};
$('#chatAllForm').onsubmit = async (e) => {
  e.preventDefault();
  const t = e.target.text.value.trim();
  if (!t || !confirm(`Send to every player in chat?\n\n${t}`)) return;
  const r = await chatRun('CsrSendAll', [t], 'Sent to everyone');
  if (r && r.ok) e.target.text.value = '';
};
$('#btnChatSilenceAll').onclick = () => confirm('Silence everyone in global chat?') && chatRun('CsrSilenceAll', [], 'Everyone silenced');
$('#btnChatUnsilenceAll').onclick = () => chatRun('CsrUnsilenceAll', [], 'Everyone unsilenced');
$('#btnChatInvisible').onclick = () => chatRun('Invisible', [], 'ShardAdmin is invisible');
$('#btnChatVisible').onclick = () => chatRun('Visible', [], 'ShardAdmin is visible');
$('#chatFindForm').onsubmit = async (e) => {
  e.preventDefault();
  const n = e.target.name.value.trim().replace(/^@/, '');
  if (!n) return;
  chatUserPick = n;
  await chatRun('CsrStatus', [n]);
  renderChat();
};
$('#chatSendForm').onsubmit = async (e) => {
  e.preventDefault();
  const t = e.target.text.value.trim();
  if (!t || !chatPick) return;
  const r = await chatRun('Send', [chatPick, t]);
  if (r && r.ok) e.target.text.value = '';
};
$('#chatChannelHead').onclick = async (e) => {
  const b = e.target.closest('[data-chat]');
  if (!b) return;
  const c = chatPick;
  const a = b.dataset.chat;
  if (a === 'other') { const keep = chatPick; chatPick = ''; renderChatChannel(); chatPick = keep; return; }
  if (a === 'join') await chatRun('Join', [c, ''], `Joined ${c}`);
  else if (a === 'leave') await chatRun('Leave', [c], `Left ${c}`);
  else if (a === 'kill') { if (confirm(`Delete the channel ${c}? Everyone in it leaves.`)) { await chatRun('CsrChanKill', [c], `${c} deleted`); chatPick = ''; } }
  else if (a === 'mute') await chatRun('ChanMode', [c, '-send'], `${c}: only operators can talk`);
  else if (a === 'unmute') await chatRun('ChanMode', [c, '+send'], `${c}: everyone can talk`);
  else if (a === 'motd' || a === 'desc') {
    const t = prompt(a === 'motd' ? `Message of the day for ${c}` : `Description of ${c}`);
    if (t !== null) await chatRun(a === 'motd' ? 'ChanMotd' : 'ChanDesc', [c, t], 'Saved');
  }
};
$('#chatMembers').onclick = async (e) => {
  const pick = e.target.closest('[data-pickuser]');
  if (pick) { e.preventDefault(); chatUserPick = pick.dataset.pickuser; renderChat(); return; }
  const b = e.target.closest('[data-mode]');
  if (!b) return;
  const who = b.closest('[data-member]').dataset.member;
  if (b.dataset.mode === '-join' && !confirm(`Kick @${who} out of ${chatPick}?`)) return;
  await chatRun('UserMode', [chatPick, who, b.dataset.mode], `@${who}: ${b.dataset.mode}`);
};
$('#chatUserCard').onclick = async (e) => {
  const b = e.target.closest('[data-uact]');
  if (!b || !chatUserPick) return;
  const u = chatUserPick;
  const a = b.dataset.uact;
  if (a === 'status') await chatRun('CsrStatus', [u]);
  else if (a === 'silence') { const m = $('#chatSilenceMins').value; if (confirm(`Silence @${u} for ${$('#chatSilenceMins').selectedOptions[0].textContent}?`)) await chatRun('CsrSilence', [u, m], `@${u} silenced`); }
  else if (a === 'unsilence') await chatRun('CsrSilence', [u, '0'], `@${u} can talk again`);
  else if (a === 'tell') { const t = $('#chatTell').value.trim(); if (t) { const r = await chatRun('SendUser', [u, t]); if (r && r.ok) $('#chatTell').value = ''; } }
  else if (a === 'invite') { const ch = $('#chatInviteTo').value; if (ch) await chatRun('Invite', [ch, '0', u], `@${u} invited to ${ch}`); }
  else if (a === 'rename') { const n = $('#chatNewName').value.trim().replace(/^@/, ''); if (n && confirm(`Rename @${u} to @${n}?`)) { const r = await chatRun('CsrName', [u, n], `@${u} is now @${n}`); if (r && r.ok) chatUserPick = n; } }
  else if (a === 'renameable') await chatRun('CsrGrantRename', [u], `@${u} may rename once`);
};


// ---- The machine the shard runs on (Machines tab; backend hostStats) ----

function bar(pct, warnAt = 75, badAt = 90) {
  const p = Math.max(0, Math.min(100, pct || 0));
  const c = p >= badAt ? 'var(--bad)' : p >= warnAt ? 'var(--warn)' : 'var(--ok)';
  // Width and color set after (the window's content policy blocks style attributes)
  return `<div class="hbar"><div data-pct="${p}" data-color="${c}"></div></div>`;
}

function renderHost() {
  const box = $('#hostPanel');
  if (!box || !$('#pane-machines').classList.contains('on')) return;
  const h = status && status.host;
  if (!h) { box.innerHTML = '<p class="dim">No numbers from the machine yet.</p>'; return; }
  const t = status.totals || { cpu: 0, rssMB: 0 };
  const used = h.memTotalMB - h.memAvailMB;
  const memPct = h.memTotalMB ? (100 * used) / h.memTotalMB : 0;
  const shardMemPct = h.memTotalMB ? (100 * t.rssMB) / h.memTotalMB : 0;
  const shardCores = t.cpu / 100;
  const shardCpuPct = h.cores ? t.cpu / h.cores : 0;
  const swapPct = h.swapTotalMB ? (100 * h.swapUsedMB) / h.swapTotalMB : 0;
  const diskPct = h.diskTotalMB ? (100 * (h.diskTotalMB - h.diskFreeMB)) / h.diskTotalMB : 0;
  const loadPct = h.cores ? (100 * h.load[0]) / h.cores : 0;
  // The heaviest processes of the shard, by CPU then memory
  const procs = [...(status.servers || []).filter((x) => x.pid), ...(status.extras || [])]
    .sort((a, b) => (b.cpu || 0) - (a.cpu || 0) || (b.rssMB || 0) - (a.rssMB || 0)).slice(0, 8);
  const days = Math.floor(h.uptime / 86400), hrs = Math.floor((h.uptime % 86400) / 3600);
  box.innerHTML = `<h3>${esc(target && target.kind === 'remote' ? target.name : 'This computer')} <span class="dim">${esc(h.hostname)} · ${esc(h.cpuModel)} · up ${days ? `${days} d ` : ''}${hrs} h</span></h3>
    <div class="hostgrid">
      <div class="hstat"><b>CPU</b><span>${h.cpuPct === null ? '...' : `${h.cpuPct.toFixed(0)}%`} of ${h.cores} cores</span>${bar(h.cpuPct)}</div>
      <div class="hstat" title="How many cores the shard's processes keep busy: 100% is one core, 125% is one and a quarter"><b>Shard CPU</b><span>${t.cpu.toFixed(0)}% = ${shardCores.toFixed(2)} of ${h.cores} cores (${shardCpuPct.toFixed(0)}% of the machine)</span>${bar(shardCpuPct)}</div>
      <div class="hstat" title="Processes waiting for a core, averaged over 1, 5 and 15 minutes. Above the number of cores, something waits."><b>Load</b><span>${h.load.join(' · ')} (${h.cores} cores)</span>${bar(loadPct, 80, 100)}</div>
      <div class="hstat"><b>RAM</b><span>${mb(used)} of ${mb(h.memTotalMB)} (${memPct.toFixed(0)}%) · ${mb(h.memAvailMB)} free</span>${bar(memPct)}</div>
      <div class="hstat"><b>Shard RAM</b><span>${mb(t.rssMB)} (${shardMemPct.toFixed(0)}% of the machine), ${status.totals.maps || 0} map servers</span>${bar(shardMemPct)}</div>
      <div class="hstat" title="Memory moved to disk. Some is normal; growing while you play means RAM is short."><b>Swap</b><span>${h.swapTotalMB ? `${mb(h.swapUsedMB)} of ${mb(h.swapTotalMB)} (${swapPct.toFixed(0)}%)` : 'none'}</span>${bar(swapPct, 25, 60)}</div>
      ${h.diskTotalMB ? `<div class="hstat"><b>Disk</b><span>${mb(h.diskFreeMB)} free of ${mb(h.diskTotalMB)}</span>${bar(diskPct, 85, 95)}</div>` : ''}
      ${h.tempC !== null ? `<div class="hstat"><b>CPU temperature</b><span>${h.tempC.toFixed(0)} °C</span>${bar((h.tempC / 100) * 100, 80, 90)}</div>` : ''}
      ${h.pressure ? `<div class="hstat" title="Linux pressure (PSI): the share of the last 10 seconds some process waited for a core, for memory or for the disk. Lag shows up here first."><b>Waiting</b><span>CPU ${h.pressure.cpu ?? '?'}% · memory ${h.pressure.memory ?? '?'}% · disk ${h.pressure.io ?? '?'}%</span>${bar(Math.max(h.pressure.cpu || 0, h.pressure.memory || 0, h.pressure.io || 0), 10, 30)}</div>` : ''}
    </div>
    ${procs.length ? `<h4>Busiest shard processes</h4><table class="hostprocs"><tr><th>Process</th><th>CPU</th><th>Cores</th><th>RAM</th><th>% of RAM</th></tr>
      ${procs.map((x) => `<tr><td>${esc(x.name)}</td><td>${(x.cpu || 0).toFixed(0)}%</td><td>${((x.cpu || 0) / 100).toFixed(2)}</td><td>${mb(x.rssMB || 0)}</td><td>${h.memTotalMB ? ((100 * (x.rssMB || 0)) / h.memTotalMB).toFixed(1) : '?'}%</td></tr>`).join('')}</table>` : ''}`;
  for (const d of box.querySelectorAll('.hbar > div')) { d.style.width = `${d.dataset.pct}%`; d.style.background = d.dataset.color; }
}


// ---- The other shards on this machine (backend: extraShards, extraShardAction, extraShardLog) ----

// Shared by every shard on this machine; the rest each shard runs for itself
const GLOBAL_SERVERS = ['AuthServer'];
let xshards = null;   // the last list
let xsPick = '';      // the shard shown in its pane
let xsLogKey = '';    // which log the pane shows
let xsBusy = {};

async function loadXshards() {
  try {
    const r = await window.shard.extraShards();
    if (r && r.ok !== false) xshards = r;
  } catch { /* the machine is away */ }
  renderShardItem();
  renderShardCount();
  if ($('#pane-xshard').classList.contains('on')) renderXshard();
  if (xsLogKey && !xsLogKey.startsWith('crash:') && $('#xsLog').offsetParent && $('#xsLogLive').checked) xsShowLog(xsLogKey, true);
  if (sel.key && sel.key.startsWith('xs:') && $('#pane-logs').classList.contains('on') && $('#logFollow').checked) {
    const name = sel.key.slice(3);
    const r = await window.shard.extraShardLog({ name, server: 'all' });
    if (sel.key === `xs:${name}` && r && r.ok !== false) { logLines = (r.text || '').split('\n'); renderLog(false); }
  }
}
setInterval(loadXshards, 5000);
setTimeout(loadXshards, 1500);

// The top: how many shards are up (every one of their servers), out of the ones on this machine
function renderShardCount() {
  if (!status) return;
  const name = status.serverName || 'This shard';
  const own = status.servers.filter((x) => !GLOBAL_SERVERS.includes(x.name));
  const mainRunning = own.some((x) => x.name === 'DBServer' && x.state !== 'down');
  const list = [{ name, running: mainRunning, full: mainRunning && own.every((x) => x.state === 'up'), text: `${own.filter((x) => x.state === 'up').length}/${own.length} servers` }];
  for (const h of (xshards && xshards.shards) || []) {
    const st = xsState(h);
    list.push({ name: h.name, running: st.dot !== 'down', full: st.dot === 'up', text: st.text });
  }
  const full = list.filter((x) => x.full).length;
  const running = list.filter((x) => x.running).length;
  $('#upNum').textContent = full;
  $('#upTotal').textContent = list.length;
  $('#upLabel').textContent = `shard${list.length === 1 ? '' : 's'} up${running > full ? ` · ${running - full} starting` : ''}`;
  $('#upFill').style.width = `${list.length ? (100 * full) / list.length : 0}%`;
  $('#upFill').style.background = full === list.length ? 'var(--ok)' : 'var(--warn)';
  $('#upFill').parentElement.title = list.map((x) => `${x.name}: ${x.full ? 'up' : x.running ? 'starting' : 'stopped'} (${x.text})`).join('\n');
}

// A shard's state in a word and a dot: the container, then its servers
function xsState(h) {
  const c = h.container;
  if (xsBusy[h.name]) return { dot: 'starting', text: xsBusy[h.name] };
  if (!c) return { dot: 'down', text: 'stopped' };
  if (!/running/i.test(c.state)) return { dot: 'down', text: /exit/i.test(c.state) ? `container ${c.state}` : c.state };
  const s = h.status;
  if (!s || h.stale) return { dot: 'starting', text: 'starting' };
  if (s.phase !== 'running') return { dot: s.phase === 'failed' ? 'down' : 'starting', text: s.phase };
  const down = s.servers.filter((x) => x.state !== 'up').length;
  const maps = (s.totals && s.totals.maps) || 0;
  return down ? { dot: 'starting', text: `${s.up}/${s.total} up` } : { dot: 'up', text: `${maps ? `${maps} map${maps === 1 ? '' : 's'} · ` : 'up · '}${mb(Math.round((s.totals && s.totals.rssMB) || 0))}` };
}

async function xsStart(name) {
  const first = !(xshards && xshards.enabled);
  const atlas = $('#xsAtlas') && $('#xsAtlas').checked && xsPick === name;
  if (!confirm(`Start ${name} as another shard on this machine?${first ? '\n\nThe first one restarts this shard once (players go to the login screen) so the login server lists both.' : ''}\n\nIt takes a minute or two; each shard uses about 1.5 GB of RAM${atlas ? ', plus about 1.5 GB for Atlas Park' : ''}.`)) return;
  xsPick = name; showTab('xshard');
  await xsRun(name, 'start', { atlas });
}

async function xsRun(name, action, extra = {}) {
  xsBusy[name] = action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : 'restarting';
  renderShardItem(); renderXshard();
  const r = await call('extraShardAction', { name, action, ...extra }, action === 'restart-server' ? null : `${name}: ${action === 'stop' ? 'stopped' : 'starting'}`);
  delete xsBusy[name];
  loadXshards();
  return r;
}

const ago2 = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };

function renderXshard() {
  const h = xshards && xshards.shards.find((x) => x.name === xsPick);
  const busy = xsBusy[xsPick];
  $('#xsTitle').textContent = xsPick || 'Shard';
  if (!h) {
    $('#xsSub').textContent = xshards && !xshards.podman ? 'Other shards run on Linux: pick the Steam Machine at the top' : 'Not started yet';
    for (const id of ['#xsInfo', '#xsServers', '#xsMaps', '#xsEvents', '#xsCrashes', '#xsGlobal']) $(id).innerHTML = '';
    $('#btnXsStart').disabled = !(xshards && xshards.podman) || !!busy || !xsPick;
    $('#xsAtlasBox').classList.remove('hidden');
    $('#btnXsRestart').disabled = $('#btnXsStop').disabled = true;
    $('#btnXsCrashLogs').disabled = true;
    return;
  }
  const st = xsState(h);
  const c = h.container;
  const s = h.status;
  const running = !!(c && /running/i.test(c.state));
  $('#xsSub').textContent = `server ${h.id} · game clients on port ${h.port} · ${st.text}`;
  $('#btnXsStart').disabled = running || !!busy;
  $('#xsAtlasBox').classList.toggle('hidden', running);
  $('#btnXsRestart').disabled = !!busy || !c;
  $('#btnXsStop').disabled = !!busy || !running;
  $('#btnXsCrashLogs').disabled = !h.crashes.length;
  $('#btnXsCrashLogs').textContent = h.crashes.length ? `Crash Logs (${h.crashes.length})` : 'Crash Logs';
  const t = (s && s.totals) || { cpu: 0, rssMB: 0, maps: 0 };
  $('#xsInfo').innerHTML = `<div class="statrow">
      <div class="stat ${running ? '' : 'warnbox'}"><b>${esc(c ? c.state : 'none')}</b><span>container${c ? ` · ${esc(c.status || '')}` : ''}</span></div>
      <div class="stat ${c && c.restarts ? 'warnbox' : ''}"><b>${c ? c.restarts : 0}</b><span>container restarts</span></div>
      <div class="stat"><b>${s ? `${s.up}/${s.total}` : '0'}</b><span>servers up</span></div>
      <div class="stat"><b>${t.maps || 0}</b><span>map servers</span></div>
      <div class="stat"><b>${mb(Math.round(t.rssMB || 0))}</b><span>RAM</span></div>
      <div class="stat" title="100% is one core"><b>${(t.cpu || 0).toFixed(0)}%</b><span>CPU (${((t.cpu || 0) / 100).toFixed(2)} cores)</span></div>
      <div class="stat ${h.stale && running ? 'warnbox' : ''}"><b>${s ? ago2(s.time) : 'never'}</b><span>last report</span></div>
    </div>`;
  // A server that's down and has a crash report since the shard started: crashed
  const crashedAt = (name) => { const f = h.crashes.find((x) => x.file.startsWith(`${name}-`)); return f ? f.time : 0; };
  const row = (x, logName, isMap) => {
    const cr = crashedAt(x.name.replace(/ .*/, ''));
    const state = x.state || 'up';
    const label = state !== 'up' && cr && (!s || cr > Date.now() - 600000) ? `crashed ${ago2(cr)}` : state;
    return `<tr class="${state === 'up' ? '' : 'bad'}"><td><span class="dot ${state === 'up' ? 'up' : state === 'starting' ? 'starting' : 'down'}"></span> ${esc(isMap ? x.name : serverTitle(x.name))}</td>
      <td>${esc(label)}</td><td>${x.pid || ''}</td><td>${x.pid ? `${(x.cpu || 0).toFixed(0)}%` : ''}</td><td>${x.pid ? mb(Math.round(x.rssMB || 0)) : ''}</td><td>${x.uptime ? ago(x.uptime) : ''}</td>
      <td class="acts">${isMap ? '' : `<button class="mini" data-xsrestart="${esc(x.name)}" ${running ? '' : 'disabled'} title="${x.name === 'DBServer' ? 'The Database Server: restarts the whole shard' : x.name === 'Launcher' ? 'The Launcher and everything it started' : 'Stopped; the Database Server starts it again within a minute'}">Restart</button>`}
        <button class="mini" data-xslog="${esc(logName)}">Log</button></td></tr>`;
  };
  const head = '<tr><th>Server</th><th>State</th><th>Pid</th><th>CPU</th><th>RAM</th><th>Up</th><th></th></tr>';
  $('#xsServers').innerHTML = s && s.servers.length ? head + s.servers.map((x) => row(x, x.name, false)).join('') : `<tr><td class="dim">${running ? 'Starting...' : 'Not running'}</td></tr>`;
  const glob = ((status && status.servers) || []).filter((x) => GLOBAL_SERVERS.includes(x.name));
  $('#xsGlobal').innerHTML = `${head}${glob.map((x) => `<tr class="${x.state === 'up' ? '' : 'bad'}"><td><span class="dot ${x.state}"></span> ${esc(serverTitle(x.name))}</td><td>${esc(x.state)}</td><td>${x.pid || ''}</td><td>${x.pid ? `${(x.cpu || 0).toFixed(0)}%` : ''}</td><td>${x.pid ? mb(Math.round(x.rssMB || 0)) : ''}</td><td>${x.uptime ? ago(x.uptime) : ''}</td><td class="dim">in the sidebar</td></tr>`).join('')}
    <tr><td><span class="dot none"></span> SQL Server</td><td colspan="6" class="dim">one for every shard; this one's databases end in _${esc(h.slug)} (and cohdb_${esc(h.slug)})</td></tr>`;
  $('#xsMaps').innerHTML = s && s.maps.length ? head + s.maps.map((x) => row(x, x.logName || x.name, true)).join('') : '<tr><td class="dim">None running (they start when someone enters a zone)</td></tr>';
  $('#xsEvents').innerHTML = s && s.events.length ? [...s.events].reverse().map((e) => `<li><span class="dim">${clock(e.time)}</span> <span class="${e.level}">${esc(spaceNames(e.text))}</span></li>`).join('') : '<li class="dim">Nothing yet</li>';
  const recent = h.crashes.filter((f) => f.time > Date.now() - 24 * 3600 * 1000).length;
  $('#xsCrashBadge').textContent = recent;
  $('#xsCrashBadge').classList.toggle('hidden', !recent);
  $('#xsCrashes').innerHTML = h.crashes.length ? h.crashes.map((f) => `<li><span class="dim">${clock(f.time)}</span> <a href="#" data-xscrash="${esc(f.file)}">${esc(f.file)}</a></li>`).join('') : '<li class="dim">None</li>';
}

async function xsShowLog(key, refresh) {
  xsLogKey = key;
  const box = $('#xsLog');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const r = await window.shard.extraShardLog({ name: xsPick, server: key });
  if (xsLogKey !== key) return;
  $('#xsLogBox').classList.remove('hidden');
  $('#xsLogTitle').textContent = key === 'container' ? `${xsPick}: the container's log` : key === 'all' ? `${xsPick}: all its logs (the container, then every server's last lines)` : key.startsWith('crash:') ? `${xsPick}: ${key.slice(6)}` : `${xsPick}: ${serverTitle(key)}`;
  const text = r && r.ok !== false ? (r.text || '(empty)') : (r && r.error) || 'No log';
  if (refresh && box.textContent === text) return;
  box.textContent = text;
  if (!refresh) box.scrollTop = key.startsWith('crash:') ? 0 : box.scrollHeight;
  else if (atBottom) box.scrollTop = box.scrollHeight;
}
$('#btnXsCopyCrashes').onclick = async () => {
  const h = xshards && xshards.shards.find((x) => x.name === xsPick);
  const list = (h && h.crashes) || [];
  if (!list.length) { toast('No crash reports', '', 'warn'); return; }
  const parts = [];
  for (const f of list) {
    const r = await window.shard.extraShardLog({ name: xsPick, server: `crash:${f.file}` });
    parts.push(`==== ${xsPick}: ${f.file} (${new Date(f.time).toLocaleString()}) ====\n${r && r.ok !== false ? r.text : (r && r.error) || 'gone'}`);
  }
  await window.shard.copyText(`${parts.join('\n\n')}\n`);
  toast(`Copied ${list.length} crash report${list.length === 1 ? '' : 's'} of ${xsPick}`, '', 'ok');
};
$('#btnXsAllLogs').onclick = () => { showSub('xshard', 'services'); xsShowLog('all'); $('#xsLogBox').scrollIntoView({ block: 'nearest' }); };
$('#btnXsLogClose').onclick = () => { xsLogKey = ''; $('#xsLogBox').classList.add('hidden'); };
$('#btnXsLogCopy').onclick = async () => { try { await window.shard.copyText(`${$('#xsLogTitle').textContent}\n${$('#xsLog').textContent}\n`); toast('Copied', '', 'ok'); } catch (e) { toast('Copy failed', e.message, 'error'); } };

$('#btnXsStart').onclick = () => xsStart(xsPick);
$('#btnXsRestart').onclick = () => confirm(`Restart ${xsPick}? Its players go to the login screen; every server stops (saving) and starts again.`) && xsRun(xsPick, 'restart');
$('#btnXsStop').onclick = () => confirm(`Stop ${xsPick}? Its players go to the login screen. Its data stays; Start brings it back.`) && xsRun(xsPick, 'stop');
$('#btnXsCrashLogs').onclick = () => $('#btnXsCopyCrashes').click();
$('#pane-xshard').onclick = async (e) => {
  const rs = e.target.closest('[data-xsrestart]');
  if (rs) {
    const srv = rs.dataset.xsrestart;
    if (srv === 'DBServer' && !confirm(`Restarting ${xsPick}'s Database Server restarts the whole shard. Go on?`)) return;
    rs.disabled = true;
    await xsRun(xsPick, 'restart-server', { server: srv });
    toast(`${xsPick}: ${srv} restart sent`, 'Its container does it within 5 seconds', 'ok');
    return;
  }
  const lg = e.target.closest('[data-xslog]');
  if (lg) { xsShowLog(lg.dataset.xslog); return; }
  const cr = e.target.closest('[data-xscrash]');
  if (cr) { e.preventDefault(); xsShowLog(`crash:${cr.dataset.xscrash}`); }
};


// ---- This shard's Services tab: what's up, starting or down, and each one's controls ----

function svcNote(text, level, time) {
  svcEvents.push({ time: time || Date.now(), text, level: level || 'info' });
  if (svcEvents.length > 40) svcEvents.shift();
  if ($('#pane-shard').classList.contains('on') && subTab.shard === 'services') renderSvcEvents();
}
function renderSvcEvents() {
  $('#svcEvents').innerHTML = svcEvents.length ? [...svcEvents].reverse().map((e) => `<li><span class="dim">${clock(e.time)}</span> <span class="${e.level}">${esc(spaceNames(e.text))}</span></li>`).join('') : '<li class="dim">Nothing yet. Starts, stops, restarts and crashes show here.</li>';
}

function renderSvc() {
  if (!status) return;
  const name = status.serverName || status.shardName || 'This shard';
  const busy = status.busy;
  const own = status.servers.filter((x) => !GLOBAL_SERVERS.includes(x.name));
  const ownUp = own.filter((x) => x.state === 'up').length;
  const dbUp = own.some((x) => x.name === 'DBServer' && x.state !== 'down');
  const anything = own.some((x) => x.state !== 'down') || status.extras.length > 0;
  $('#btnSvcStart').disabled = !!busy || dbUp || !!status.offline;
  $('#btnSvcStart').textContent = busy === 'starting' ? 'Starting...' : `Start ${name}`;
  $('#btnSvcRestart').disabled = (!!busy && busy !== 'starting') || !anything;
  $('#btnSvcRestart').textContent = status.restarting ? 'Restarting...' : 'Restart Shard';
  $('#btnSvcStop').disabled = busy === 'stopping' || (!anything && busy !== 'starting');

  // What it's doing right now, with how far along it is
  const doing = status.restarting ? 'Restarting' : busy ? `${busy[0].toUpperCase()}${busy.slice(1)}` : status.warming ? 'Starting' : '';
  const box = $('#svcProgress');
  box.classList.toggle('hidden', !doing);
  if (doing) {
    box.classList.remove('done', 'failed');
    $('#svcDoing').textContent = `${doing} ${name}`;
    $('#svcCount').textContent = `${ownUp} of ${own.length} servers up`;
    $('#svcFill').style.width = `${own.length ? (100 * ownUp) / own.length : 0}%`;
    $('#svcFill').style.background = 'var(--warn)';
    $('#svcLast').textContent = busy || status.restarting ? (status.lastProgress || '...') : 'The Launcher starts the rest; give it a minute or two.';
  }
  const t = status.totals || { cpu: 0, rssMB: 0, maps: 0 };
  const down = own.filter((x) => x.state === 'down').length;
  $('#svcInfo').innerHTML = `<div class="statrow">
      <div class="stat ${dbUp ? '' : 'warnbox'}"><b>${dbUp ? (doing || 'running') : 'stopped'}</b><span>${esc(name)}</span></div>
      <div class="stat ${dbUp && down ? 'warnbox' : ''}"><b>${ownUp}/${own.length}</b><span>servers up</span></div>
      <div class="stat"><b>${t.maps || 0}</b><span>map servers</span></div>
      <div class="stat"><b>${mb(Math.round(t.rssMB || 0))}</b><span>RAM</span></div>
      <div class="stat" title="100% is one core"><b>${(t.cpu || 0).toFixed(0)}%</b><span>CPU (${((t.cpu || 0) / 100).toFixed(2)} cores)</span></div>
    </div>`;

  const head = '<tr><th>Server</th><th>State</th><th>Pid</th><th>CPU</th><th>RAM</th><th>Up</th><th></th></tr>';
  const stateOf = (x) => {
    const tr = svcTrouble[x.name];
    if (x.state !== 'up' && tr && tr.time > Date.now() - 600000) return /crash/i.test(tr.title) ? `crashed ${ago2(tr.time)}` : `stopped ${ago2(tr.time)}`;
    if (x.state === 'down' && x.built === false) return 'not built yet';
    return x.state;
  };
  const cells = (x) => `<td>${x.pid || ''}</td><td>${x.pid && x.cpu !== undefined ? `${x.cpu.toFixed(0)}%` : ''}</td><td>${x.pid ? mb(Math.round(x.rssMB || 0)) : ''}</td><td>${x.uptime ? ago(x.uptime) : ''}</td>`;
  const dot = (st) => `<span class="dot ${st === 'up' ? 'up' : st === 'starting' ? 'starting' : 'down'}"></span>`;
  const restartTip = (n) => (n === 'DBServer' ? 'The Database Server: every map saves and players go to the login screen' : n === 'Launcher' ? 'The Launcher and the map servers it started' : 'Stops it and starts it again');
  $('#svcServers').innerHTML = head + own.map((x) => `<tr class="${x.state === 'up' ? '' : 'bad'}" title="${esc(x.about || '')}"><td>${dot(x.state)} ${esc(serverTitle(x.name))}</td><td>${esc(stateOf(x))}</td>${cells(x)}
      <td class="acts"><button class="mini" data-svcrestart="${esc(x.name)}" ${busy && busy !== 'starting' ? 'disabled' : ''} title="${restartTip(x.name)}">${x.state === 'down' ? 'Start' : 'Restart'}</button>
      <button class="mini" data-svclog="${esc(x.name)}">Log</button></td></tr>`).join('');
  $('#svcMaps').innerHTML = status.extras.length ? head + status.extras.map((x) => `<tr><td>${dot('up')} ${esc(x.name)}</td><td>${x.restartNeeded ? 'up · newer build' : 'up'}</td>${cells(x)}
      <td class="acts"><button class="mini" data-svcstop="${x.pid}">Stop</button> <button class="mini" data-svclog="${esc(x.logName)}" data-svctitle="${esc(x.name)}">Log</button></td></tr>`).join('')
    : `<tr><td class="dim">${dbUp ? 'None running (they start when someone enters a zone)' : 'Not running'}</td></tr>`;
  const glob = status.servers.filter((x) => GLOBAL_SERVERS.includes(x.name));
  $('#svcGlobal').innerHTML = head + glob.map((x) => `<tr class="${x.state === 'up' ? '' : 'bad'}"><td>${dot(x.state)} ${esc(serverTitle(x.name))}</td><td>${esc(stateOf(x))}</td>${cells(x)}
      <td class="acts"><button class="mini" data-svcrestart="${esc(x.name)}" title="Every shard on this machine logs in through it">${x.state === 'down' ? 'Start' : 'Restart'}</button> <button class="mini" data-svclog="${esc(x.name)}">Log</button></td></tr>`).join('')
    + `<tr class="${status.sqlUp ? '' : 'bad'}"><td>${dot(status.sqlUp ? 'up' : 'down')} SQL Server</td><td>${status.sqlUp ? 'up' : 'down'}</td><td colspan="4" class="dim">every shard's databases</td><td class="acts"><button class="mini" data-svclog="sql" data-svctitle="SQL Server">Log</button></td></tr>`;
  renderSvcEvents();
}

$('#btnSvcStart').onclick = () => startMain();
$('#btnSvcRestart').onclick = () => $('#btnRestartAll').click();
$('#btnSvcStop').onclick = () => stopMain();
$('#pane-shard').addEventListener('click', async (e) => {
  const rs = e.target.closest('[data-svcrestart]');
  if (rs) {
    const n = rs.dataset.svcrestart;
    if (n === 'DBServer' && !mainUp()) { startMain(); return; }
    if (n === 'DBServer' && status && status.servers.some((x) => x.name === 'DBServer' && x.state === 'up') && !confirm('Restart the Database Server? Every map saves and players go to the login screen.')) return;
    if (n === 'AuthServer' && !confirm('Restart the AuthServer? Every shard on this machine logs in through it; players already in the game stay.')) return;
    rs.disabled = true;
    svcNote(`Shard Admin: restart ${serverTitle(n)}`, 'warn');
    await call('restart', n, `${serverTitle(n)}: restarting`);
    return;
  }
  const st = e.target.closest('[data-svcstop]');
  if (st) { st.disabled = true; await call('stopPid', +st.dataset.svcstop, 'Stopped'); return; }
  const lg = e.target.closest('[data-svclog]');
  if (lg) { const n = lg.dataset.svclog; const srv = status && status.servers.find((x) => x.name === n); selectLog(n, lg.dataset.svctitle || serverTitle(n), srv ? srv.about || '' : '', srv ? n : null); }
});

// ---- This app's updates (main.js, tools/app-update.js): newer commits of the repo ----

let swInfo = null;
let swLast = null;
const verText = (v) => `${v.version}${v.commit ? ` (${v.commit}${v.date ? `, ${v.date}` : ''})` : ''}`;

function renderSoftware() {
  if (!swInfo) return;
  $('#appVer').textContent = `v${swInfo.version}${swInfo.commit ? ` · ${swInfo.commit}` : ''}`;
  $('#appVer').title = `Shard Admin ${verText(swInfo)}`;
  $('#swVersion').textContent = `${verText(swInfo)}${swInfo.branch ? ` on ${swInfo.branch}` : ''}${swInfo.electron ? ` · Electron ${swInfo.electron}` : ''}`;
  $('#swAuto').checked = swInfo.auto;
  const r = swLast;
  const avail = !!(r && r.ok && r.available);
  $('#btnAppUpdate').classList.toggle('hidden', !avail);
  $('#btnSwUpdate').classList.toggle('hidden', !avail);
  $('#btnSwUpdate').disabled = !!(r && !r.canUpdate);
  $('#swStatus').textContent = !r ? (swInfo.checkedAt ? `Last checked ${clock(swInfo.checkedAt)}` : 'Not checked yet')
    : !r.ok ? `Couldn't check: ${r.error}`
    : avail ? [r.local ? `Newer code on disk than this window runs (${r.localFiles.length} file${r.localFiles.length === 1 ? '' : 's'}): Update Available restarts Shard Admin on it` : '',
      r.behind ? `${r.behind} new commit${r.behind === 1 ? '' : 's'} on ${r.upstream}${r.ahead ? `; this copy also has ${r.ahead} the remote doesn't, so it can't pull them (push first)` : ''}` : ''].filter(Boolean).join('. ')
    : `Up to date with ${r.upstream} (checked ${clock(r.checkedAt)})${r.ahead ? `; ${r.ahead} commit${r.ahead === 1 ? '' : 's'} here not pushed yet` : ''}`;
  $('#swNew').innerHTML = avail ? (r.localFiles || []).slice(0, 8).map((f) => `<li><span class="dim">changed</span> ${esc(f)}</li>`).join('')
    + (r.newest || []).map((c) => `<li><span class="dim">${esc(c.date)} ${esc(c.commit)}</span> ${esc(c.subject)}</li>`).join('') + (r.behind > (r.newest || []).length ? `<li class="dim">and ${r.behind - r.newest.length} more</li>` : '') : '';
}

async function loadSoftware() {
  try { swInfo = await window.shard.appVersion(); swLast = swInfo.last || swLast; } catch { return; }
  renderSoftware();
}

async function swUpdate() {
  if (!swLast || !swLast.available) return;
  if (swLast.behind && !confirm(`Update Shard Admin to the newest code (${swLast.behind} commit${swLast.behind === 1 ? '' : 's'}) and restart it? The shard keeps running. Servers changed by the update need Build changed afterwards.`)) return;
  $('#btnSwUpdate').disabled = true; $('#btnAppUpdate').disabled = true;
  $('#swStatus').textContent = 'Updating...';
  const r = await window.shard.appUpdate();
  if (!r || r.ok === false) { toast('Update failed', (r && r.error) || '', 'error'); $('#swStatus').textContent = `Update failed: ${(r && r.error) || ''}`; $('#btnSwUpdate').disabled = false; $('#btnAppUpdate').disabled = false; return; }
  if (r.nothing) { toast('Already up to date', '', 'ok'); loadSoftware(); return; }
  $('#swStatus').textContent = r.localOnly ? 'Restarting on the code on disk...' : r.relaunch ? `Updated ${r.from} to ${r.to}${r.npm ? ` (packages ${r.npm})` : ''}: restarting...` : `Updated ${r.from} to ${r.to}. ${r.note || ''}`;
  if (!r.relaunch) toast('Updated', r.note || '', 'warn');
}

$('#btnSwCheck').onclick = async () => {
  $('#btnSwCheck').disabled = true; $('#swStatus').textContent = 'Checking...';
  swLast = await window.shard.appCheckUpdate();
  $('#btnSwCheck').disabled = false;
  renderSoftware();
};
$('#btnSwUpdate').onclick = swUpdate;
$('#btnAppUpdate').onclick = () => { if (!(swLast && swLast.local && !swLast.behind)) showTab('settings'); swUpdate(); };
$('#swAuto').onchange = async (e) => { await window.shard.appSetAutoUpdate(e.target.checked); if (swInfo) swInfo.auto = e.target.checked; };
window.shard.onAppUpdate((r) => {
  const was = !!(swLast && swLast.available);
  swLast = r; renderSoftware();
  if (r && r.ok && r.available && !was) toast('Shard Admin: Update Available', r.local ? 'Newer code on disk: click Update Available (under the title) to restart on it' : `${r.behind} new commit${r.behind === 1 ? '' : 's'}: Settings, Software`, 'info');
});
loadSoftware();


// ---- Right-click menus and double-click in the sidebar ----

// Labels in Title Case: every word capitalized except the short joining ones (and, of, the...)
// in the middle; words with capitals of their own (SQL, Atlas Park) are left alone. Program names
// get their spaces (Auth Server)
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'at', 'as', 'per', 'from']);
function titleCase(text) {
  let first = true;
  return spaceNames(String(text)).split(/(\s+)/).map((tok) => {
    if (!tok.trim()) return tok;
    const m = tok.match(/^([(\["]*)([A-Za-z][\w'.-]*)(.*)$/);
    if (!m) { first = tok.endsWith(':'); return tok; }
    const [, pre, w, post] = m;
    let out = w;
    if (w === w.toLowerCase() && !(SMALL_WORDS.has(w) && !first && !pre)) out = w[0].toUpperCase() + w.slice(1);
    first = post.endsWith(':');
    return pre + out + post;
  }).join('');
}
// Program names in text as words: "AuthServer stopped" -> "Auth Server stopped" (not inside file
// names or paths: MapServer-123.txt stays)
function spaceNames(text) {
  return String(text).replace(/(?<![\w/.-])DBServer(?![\w.-])/g, 'Database Server')
    .replace(/(?<![\w/.-])(Auth|Account|Auction|Arena|Chat|Queue|Turnstile|Mission|Stat|Raid|Log|Map|Beacon)(Server|Client)(?![\w.-])/g, '$1 $2');
}

function menu(e, items) {
  e.preventDefault();
  const m = $('#ctxMenu');
  m.innerHTML = items.filter(Boolean).map((it, i) => (it === '-' ? '<div class="sep"></div>'
    : `<button data-i="${i}" ${it.disabled ? 'disabled' : ''} class="${it.danger ? 'danger' : ''}">${esc(titleCase(it.label))}</button>`)).join('');
  const list = items.filter(Boolean);
  m.onclick = (ev) => { const b = ev.target.closest('button[data-i]'); if (!b) return; hideMenu(); const it = list[+b.dataset.i]; if (it && it.run) it.run(); };
  m.classList.remove('hidden');
  const w = m.offsetWidth, h = m.offsetHeight;
  m.style.left = `${Math.min(e.clientX, window.innerWidth - w - 6)}px`;
  m.style.top = `${Math.min(e.clientY, window.innerHeight - h - 6)}px`;
}
function hideMenu() { $('#ctxMenu').classList.add('hidden'); }
document.addEventListener('click', (e) => { if (!e.target.closest('#ctxMenu')) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

const mainUp = () => !!(status && status.servers.some((x) => x.name === 'DBServer' && x.state !== 'down'));

function mainMenu(e) {
  const up = mainUp(); const name = (status && status.serverName) || 'This shard';
  menu(e, [
    { label: `Start ${name}`, disabled: up || (status && status.busy), run: startMain },
    { label: `Restart ${name}`, disabled: !up, run: () => $('#btnRestartAll').click() },
    { label: `Stop ${name}`, disabled: !up, danger: true, run: stopMain },
    '-',
    { label: 'Show Services', run: () => openShardPage('main', 'services') },
    { label: 'Zones and players', run: () => openShardPage('main', 'zones') },
    { label: 'All its logs, live', run: () => selectLog('*', 'All logs', '', null) },
    { label: 'Copy crashes and memory errors', run: () => { showTab('alerts'); $('#btnMemErrors').click(); } },
  ]);
}

function xshardMenu(e, h) {
  const running = !!(h.container && /running/i.test(h.container.state));
  menu(e, [
    { label: 'Show Services', run: () => openShardPage(h.name, 'services') },
    { label: 'Crash reports', run: () => openShardPage(h.name, 'crashes') },
    '-',
    { label: `Start ${h.name}`, disabled: running || !!xsBusy[h.name], run: () => { xsPick = h.name; xsStart(h.name); } },
    { label: `Start ${h.name} with Atlas Park`, disabled: running || !!xsBusy[h.name], run: () => { xsPick = h.name; showTab('xshard'); if ($('#xsAtlas')) $('#xsAtlas').checked = true; xsStart(h.name); } },
    { label: `Restart ${h.name}`, disabled: !h.container || !!xsBusy[h.name], run: () => confirm(`Restart ${h.name}? Its players go to the login screen.`) && xsRun(h.name, 'restart') },
    { label: `Stop ${h.name}`, disabled: !running || !!xsBusy[h.name], danger: true, run: () => confirm(`Stop ${h.name}? Its players go to the login screen. Its data stays.`) && xsRun(h.name, 'stop') },
    '-',
    { label: 'Container log', disabled: !h.container, run: () => { xsPick = h.name; showTab('xshard'); xsShowLog('container'); } },
    '-',
    { label: 'Crash test: its Database Server', disabled: !running, run: () => confirm(`Crash ${h.name}'s Database Server on purpose and watch it come back? Its players are disconnected.`) && xsRun(h.name, 'crash', { server: 'DBServer' }) },
    { label: 'Crash test: its whole container', disabled: !running, run: () => confirm(`Kill ${h.name}'s container on purpose and watch podman bring it back? Its players are disconnected.`) && xsRun(h.name, 'crash', { server: 'container' }) },
  ]);
}

function serverMenu(e, li) {
  const name = li.dataset.restart || li.dataset.log;
  const isMap = !li.dataset.restart && /^MapServer|^Beacon/.test(li.dataset.log || '');
  const stopBtn = li.querySelector('[data-stop]');
  menu(e, [
    { label: 'Its log', run: () => selectLog(li.dataset.log, li.dataset.title || li.dataset.log, li.title, li.dataset.restart) },
    li.dataset.restart ? { label: `Restart ${serverTitle(name)}`, run: () => call('restart', name, `${serverTitle(name)}: restarting`) } : null,
    isMap && stopBtn ? { label: 'Stop it', danger: true, run: () => call('stopPid', +stopBtn.dataset.stop, 'Stopped') } : null,
  ]);
}

function xsServerMenu(e, shardName, server) {
  const h = xshards && xshards.shards.find((x) => x.name === shardName);
  const isMap = /^MapServer/.test(server);
  menu(e, [
    { label: 'Its log', run: () => { xsPick = shardName; showTab('xshard'); xsShowLog(server); } },
    isMap ? null : { label: `Restart ${serverTitle(server)}`, disabled: !(h && h.container && /running/i.test(h.container.state)), run: () => xsRun(shardName, 'restart-server', { server }) },
  ]);
}

$('#shardList').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (li.id === 'shardItem') return mainMenu(e);
  if (li.dataset.xsserver) return xsServerMenu(e, li.dataset.xshard, li.dataset.xsserver);
  if (li.dataset.xshard) { const h = xshards && xshards.shards.find((x) => x.name === li.dataset.xshard); if (h) xshardMenu(e, h); return; }
  if (li.dataset.xstart) return menu(e, [
    { label: `Start ${li.dataset.xstart}`, run: () => xsStart(li.dataset.xstart) },
    { label: `Start ${li.dataset.xstart} with Atlas Park`, run: () => { xsPick = li.dataset.xstart; showTab('xshard'); if ($('#xsAtlas')) $('#xsAtlas').checked = true; xsStart(li.dataset.xstart); } },
  ]);
  if (li.classList.contains('nest') && li.dataset.log) return serverMenu(e, li);
});
$('#serverList').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  if (li.dataset.ctx === 'sql') return menu(e, [
    { label: 'Its log', run: () => selectLog('sql', 'SQL Server', '', null) },
    { label: 'Start Global (SQL Server and the AuthServer)', disabled: !!(status && status.sqlUp), run: () => call('startGlobal') },
  ]);
  if (li.dataset.log) return serverMenu(e, li);
});
// Double-click a shard: start it when it's stopped, else open it
$('#shardList').addEventListener('dblclick', (e) => {
  const li = e.target.closest('li');
  if (!li || e.target.closest('.caret')) return;
  if (li.id === 'shardItem') { if (!mainUp()) startMain(); return; }
  if (li.dataset.xshard && !li.dataset.xsserver) {
    const h = xshards && xshards.shards.find((x) => x.name === li.dataset.xshard);
    if (h && !(h.container && /running/i.test(h.container.state)) && !xsBusy[h.name]) xsStart(h.name);
    return;
  }
  if (li.dataset.xstart) xsStart(li.dataset.xstart);
});
