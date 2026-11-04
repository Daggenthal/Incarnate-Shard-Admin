// Shard Admin: the window, desktop notifications, and the timers that keep it current.
// The work itself is in backend.js (this computer's shard) and remote.js (a shard on another
// machine, driven through ssh). The window talks to whichever one is picked at the top.
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { app, BrowserWindow, ipcMain, Notification, shell, nativeTheme, dialog, clipboard } = require('electron');
const appUpdate = require('./app-update.js'); // this app's own updates: newer commits of its repo
const { Shard, shardCalls, repo } = require('./backend');
const { RemoteShard, checkProfile, profileEnv, outFile, script } = require('./remote');

const local = new Shard();
const localCalls = shardCalls(local);
let remote = null; // the RemoteShard while a machine is picked, else null (this computer)
let win = null;
const send = (channel, data) => { if (win && !win.isDestroyed()) win.webContents.send(channel, data); };
const prefs = () => local.settings; // app choices (theme, notifications, machines) live here

function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 980, minHeight: 600,
    title: 'Incarnate Shard Admin',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f5f6f8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Links open in the browser, never inside the admin window
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('page-title-updated', (e) => e.preventDefault());
  setTitle();
}

function setTitle() {
  if (win && !win.isDestroyed()) win.setTitle(remote ? `Incarnate Shard Admin: ${remote.profile.name}` : 'Incarnate Shard Admin');
}

// ---- Events from the shard to the window ----

function onAlert(a, where) {
  const shown = where ? { ...a, title: `${where}: ${a.title}` } : a;
  send('alert', shown);
  if (prefs().notify && Notification.isSupported()) {
    const n = new Notification({ title: shown.title, body: a.body || '', silent: a.level === 'info' });
    n.on('click', () => { if (win) { win.show(); win.focus(); send('focus-log', a.source); } });
    n.show();
  }
}
local.on('log', (d) => { if (!remote) send('log', d); });
local.on('progress', (d) => { if (!remote) send('progress', d); });
local.on('alert', (a) => { if (!remote) onAlert(a); });

function wireRemote(r) {
  r.on('log', (d) => { if (remote === r) send('log', d); });
  r.on('progress', (d) => { if (remote === r) send('progress', d); });
  r.on('alert', (a) => { if (remote === r) onAlert(a, r.profile.name); });
  r.on('state', (d) => {
    if (remote !== r) return;
    send('target', d);
    if (d.state === 'connected') pushStatus();
    else if (d.state === 'down') send('progress', { text: `${r.profile.name}: ${d.error}`, level: 'warn', time: Date.now() });
  });
}

// ---- Which shard ----

const LOCAL_TARGET = { kind: 'local', id: 'local', name: 'This computer', state: 'connected', error: '' };
const describeTarget = () => (remote ? remote.describe() : LOCAL_TARGET);

function machines() { return Array.isArray(prefs().remotes) ? prefs().remotes : []; }

function useTarget(id) {
  if (remote) { remote.close(); remote = null; }
  if (id && id !== 'local') {
    const p = machines().find((m) => m.id === id);
    if (!p) throw new Error('No such machine');
    remote = new RemoteShard(p);
    wireRemote(remote);
    remote.connect();
  } else {
    // Back on this computer: its logs from now on, not everything written meanwhile
    local.tails = new Map();
    local.firstPoll = true;
    local.lastStates = {};
  }
  local.setSettings({ target: remote ? id : 'local' });
  setTitle();
  send('target', describeTarget());
  pushStatus();
  return describeTarget();
}

// The first time: the machine tools/remote-shard.sh already knows (.local/remote.env)
function seedMachines() {
  if (Array.isArray(prefs().remotes)) return;
  const list = [];
  if (fs.existsSync(path.join(repo, '.local', 'remote.env'))) {
    try {
      const out = execFileSync(script, ['config'], { cwd: repo, env: { ...process.env, INCARNATE_COLOR: '0' }, encoding: 'utf8', timeout: 5000 });
      const v = Object.fromEntries(out.split('\n').map((l) => l.split(/=(.*)/s)).filter((x) => x[0]));
      list.push(checkProfile({ id: 'm1', name: v.INCARNATE_REMOTE, ssh: v.INCARNATE_REMOTE, port: v.INCARNATE_REMOTE_PORT, ip: v.INCARNATE_REMOTE_IP,
        dir: v.INCARNATE_REMOTE_DIR, box: v.INCARNATE_REMOTE_BOX, staffFrom: v.INCARNATE_REMOTE_STAFF_FROM }));
    } catch { /* remote.env with values we can't use: start with none */ }
  }
  local.setSettings({ remotes: list });
}

// ---- Timers ----

const offlineStatus = () => ({ servers: [], extras: [], up: 0, total: 0, busy: null, totals: { cpu: 0, rssMB: 0, maps: 0 },
  clientRunning: false, outdatedCount: 0, toggles: {}, applied: null, offline: true });

let statusRunning = false;
async function pushStatus() {
  if (statusRunning) return;
  statusRunning = true;
  try { send('status', await currentStatus()); } catch (e) { send('progress', { text: `status: ${e.message}`, level: 'error' }); }
  statusRunning = false;
}
let lastRemoteStatus = null;
async function currentStatus() {
  if (!remote) return { ...(await local.status()), target: LOCAL_TARGET };
  const r = remote;
  let s = r.state === 'connected' ? await r.call('status') : null;
  if (!s || s.ok === false) s = offlineStatus(); else lastRemoteStatus = s;
  s.clientRunning = (await local.clientPids()).length > 0; // the game runs here, not there
  s.target = r.describe();
  return s;
}
setInterval(pushStatus, 2000);
local.startScheduler(); // this computer's messages and planned restarts (a machine runs its own)
setInterval(() => { if (!remote) { try { local.pollLogs(); } catch { /* a log rotated mid-read */ } } }, 700);

// Source changes: ask ninja which servers would rebuild (a few seconds after the last save).
// With a machine picked, the change goes over first and its ninja answers.
let outdatedTimer = null;
function scheduleOutdated(delay = 4000) {
  clearTimeout(outdatedTimer);
  outdatedTimer = setTimeout(async () => {
    if (remote) {
      const r = remote;
      if (r.state !== 'connected' || r.busyLocal) return;
      const st = await r.call('status');
      if (st && st.busy) return;
      await r.sync();
      await r.call('checkOutdated');
    } else if (!local.busy) {
      await local.checkOutdated();
    }
    pushStatus();
  }, delay);
}
setInterval(() => scheduleOutdated(0), 5 * 60 * 1000);
for (const dir of ['src', 'compat', 'engine', 'cmake']) {
  try {
    fs.watch(path.join(repo, dir), { recursive: true }, (_, file) => {
      if (file && /\.(c|cpp|h|hpp|cmake|txt)$/i.test(file) && !/AutoGen|autogen/.test(file)) scheduleOutdated();
    });
  } catch { /* recursive watching isn't available everywhere (older Linux): the 5 minute check covers it */ }
}

// ---- Calls from the window ----

// With a machine picked, these copy the source (and servers.cfg) over first, so the machine
// builds and runs what is here
const SYNC_FIRST = new Set(['start', 'restartAll', 'restart', 'restartUpdated', 'build', 'buildChanged', 'checkOutdated']);
// The config files are source: edited here, then copied over (an edit there would be undone by
// the next copy)
const EDIT_HERE = new Set(['writeGrants', 'setStaff']);
const APP_PREFS = ['notify', 'theme'];

function machineCfg(c) {
  if (!remote || !c || c.ok === false) return c;
  c.values.AdvertisedIp = remote.ip || remote.profile.ip || '';
  c.values.StaffFakeAuthFrom = remote.profile.staffFrom;
  c.remote = { name: remote.profile.name, ssh: remote.profile.ssh };
  return c;
}

async function viaTarget(name, arg) {
  if (!remote) return localCalls[name](arg);
  const r = remote;
  if (name === 'readCfg') return machineCfg(local.readServersCfg());
  if (name === 'writeCfg') {
    // The address players use and who gets staff access belong to the machine (Machines tab)
    const { AdvertisedIp, StaffFakeAuthFrom, ...rest } = arg || {};
    local.writeServersCfg(rest);
    const s = await r.sync();
    if (!s.ok) throw new Error(`Saved here, but copying it to ${r.profile.name} failed: ${s.error}`);
    return machineCfg(local.readServersCfg());
  }
  if (EDIT_HERE.has(name)) {
    const out = localCalls[name](arg);
    const s = await r.sync();
    if (!s.ok) throw new Error(`Saved here, but copying it to ${r.profile.name} failed: ${s.error}`);
    return machineCfg(out);
  }
  if (name === 'readLog' && arg === 'machine') return readMachineLog();
  if (name === 'logKeys') { const k = await r.call('logKeys'); return Array.isArray(k) ? [...k, 'machine'] : ['machine']; }
  if (name === 'setSettings') {
    const mine = Object.fromEntries(Object.entries(arg || {}).filter(([k]) => APP_PREFS.includes(k)));
    const theirs = Object.fromEntries(Object.entries(arg || {}).filter(([k]) => !APP_PREFS.includes(k)));
    if (Object.keys(mine).length) local.setSettings(mine);
    const there = Object.keys(theirs).length ? await r.call('setSettings', theirs) : (await r.call('info')).settings;
    return { ...there, ...Object.fromEntries(APP_PREFS.map((k) => [k, prefs()[k]])) };
  }
  if (name === 'info') {
    const i = await r.call('info');
    if (!i || i.ok === false) return { ...local.info(), offline: true, target: r.describe() };
    return { ...i, settings: { ...i.settings, ...Object.fromEntries(APP_PREFS.map((k) => [k, prefs()[k]])) }, target: r.describe() };
  }
  if (name === 'writeManifest') {
    const s = await r.step('manifest');
    if (s.ok) shell.showItemInFolder(path.join(repo, '.local', 'incarnate-remote.xml'));
    return s.ok ? { ok: true, file: path.join(repo, '.local', 'incarnate-remote.xml') } : s;
  }
  if (name === 'importDatabases' || name === 'importRollback') {
    // The backups are here: remote-shard.sh copies them over, then imports there
    const a = arg || {};
    const args = name === 'importRollback' ? ['import-rollback', String(arg || '')]
      : ['import', String(a.dir || ''), ...(a.dryRun ? ['--dry-run'] : []), ...(a.quick ? ['--quick'] : []), ...(a.force ? ['--force'] : []), ...(a.stopShard ? ['--stop-shard'] : []),
        ...Object.entries(a.map || {}).flatMap(([k, v]) => ['--map', `${k}=${v}`])];
    send('progress', { text: `${name === 'importRollback' ? 'Undoing the import' : 'Importing'} on ${r.profile.name} (Machine log)`, level: 'info', time: Date.now() });
    const s = await r.script(args);
    send('progress', { text: s.ok ? `${r.profile.name}: ${name === 'importRollback' ? 'import undone' : a.dryRun ? 'dry run: everything checks out' : 'import done'}` : `${r.profile.name}: ${s.error}`,
      level: s.ok ? 'ok' : 'error', time: Date.now() });
    return s;
  }
  if (SYNC_FIRST.has(name)) {
    const s = await r.sync();
    if (!s.ok) {
      send('progress', { text: `Copying the source to ${r.profile.name} failed: ${s.error}`, level: 'error', time: Date.now() });
      return { ok: false, error: s.error };
    }
  }
  return r.call(name, arg);
}

function readMachineLog() {
  try {
    const text = fs.readFileSync(outFile, 'utf8');
    return { key: 'machine', file: outFile, text: text.slice(-256 * 1024), size: text.length };
  } catch {
    return { key: 'machine', file: outFile, text: '', size: 0 };
  }
}

// Steps that need a terminal (a password): on macOS a Terminal window runs them, elsewhere
// the window shows the command to paste
function inTerminal(cmd) {
  if (!['key', 'shell', 'crash', 'setup'].includes(cmd)) throw new Error(`not a terminal step: ${cmd}`);
  const p = remote ? remote.profile : null;
  if (!p) throw new Error('Pick a machine first');
  const env = profileEnv(p);
  const vars = ['INCARNATE_REMOTE', 'INCARNATE_REMOTE_PORT', 'INCARNATE_REMOTE_IP', 'INCARNATE_REMOTE_DIR', 'INCARNATE_REMOTE_BOX',
    'INCARNATE_REMOTE_STAFF_FROM'].filter((k) => env[k]).map((k) => `${k}=${env[k]}`).join(' ');
  const line = `cd '${repo.replace(/'/g, "'\\''")}' && ${vars} tools/remote-shard.sh ${cmd}`;
  if (process.platform === 'darwin') {
    const file = path.join(repo, '.local', 'remote', `${cmd}.command`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/bash\n${line}\necho\nread -n 1 -s -r -p "Done. Press a key to close."\n`, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
    shell.openPath(file);
    return { ok: true, opened: true, command: line };
  }
  return { ok: true, opened: false, command: line };
}

// ---- Spectate Player, with the game closed: start the game here, signed in as the staff character
// picked in the Shards view, then send it to the player invisibly once it's in the game.
// The password from Login for Controls is kept in this process only, for this run of the app
// (cleared on Log out); it reaches the game the way the launcher's does: a one-time 0600 file
// in the client folder, named in INCARNATE_LOGIN_FILE (docs/LAUNCHER.md).
let staffLogin = null; // { account, password }
let ghostJob = null;

function clientDir() {
  const d = process.env.INCARNATE_CLIENT_DIR || path.join(repo, 'build-mingw', 'dist');
  return path.isAbsolute(d) ? d : path.join(repo, d);
}

function writeClientLogin(lines) {
  const dir = clientDir();
  if (!fs.existsSync(path.join(dir, 'Ouroboros.exe'))) throw new Error(`No game in ${dir} yet: Build client first`);
  const name = `.launcher-login-${require('crypto').randomBytes(8).toString('hex')}`;
  const full = path.join(dir, name);
  fs.writeFileSync(full, `${lines.join('\n')}\n`, { mode: 0o600 });
  // The game blanks and deletes it once read; this is in case it never gets that far
  setTimeout(() => { try { fs.writeFileSync(full, ''); fs.rmSync(full, { force: true }); } catch { /* gone */ } }, 3 * 60 * 1000).unref();
  return name;
}

async function launchClient(loginFile) {
  if (!remote) return local.startClient(undefined, loginFile);
  // How the game logs in there (-auth or -db) from a fresh status: the last one can be from a
  // moment the machine wasn't answering (a restart), and a -db login is refused with fake
  // auth off ("the client skipped the AuthServer")
  let st = null;
  try { st = await remote.call('status'); } catch { /* not answering */ }
  if (st && st.ok !== false) lastRemoteStatus = st;
  const realAuth = !!(lastRemoteStatus && lastRemoteStatus.realAuth);
  const env = { ...profileEnv(remote.profile), INCARNATE_CLIENT_AUTH: realAuth ? '1' : '0' };
  delete env.INCARNATE_LOGIN_FILE;
  if (loginFile) env.INCARNATE_LOGIN_FILE = loginFile;
  const child = spawn(script, ['client'], { cwd: repo, env, stdio: 'ignore', detached: true });
  child.unref();
  send('progress', { text: `Starting the client for ${remote.profile.name}`, level: 'ok', time: Date.now() });
  return { ok: true };
}

async function ghostTo(arg) {
  const say = (text, level = 'info') => send('progress', { text, level, time: Date.now() });
  const first = await viaTarget('playerAction', { ...arg, action: 'watch' });
  if (first && first.ok) return first;
  if (!first || !first.offline) return first;
  if (ghostJob) return { ok: false, error: `Already starting the game for ${ghostJob}` };
  // Games already open (other accounts) stay open: this starts one more, as the staff character
  const before = new Set(await local.clientPids());
  const realAuth = remote ? !!(lastRemoteStatus && lastRemoteStatus.realAuth) : local.realAuth();
  if (!staffLogin || staffLogin.account !== first.account || (realAuth && !staffLogin.password)) {
    return { ok: false, error: 'Log in again (Login for Controls): the game needs the password to start as you' };
  }
  // Fake auth takes any password; the game wants one all the same
  const loginFile = writeClientLogin([staffLogin.account, staffLogin.password || 'fakeauth', '', first.charName]);
  const started = await launchClient(loginFile);
  if (started && started.ok === false) return started;
  ghostJob = first.charName;
  say(`Starting the game as ${first.charName}; it goes to the player invisibly once it's in`, 'ok');
  (async () => {
    try {
      const until = Date.now() + 5 * 60 * 1000;
      let seen = false; // the new game's process has shown up
      while (Date.now() < until) {
        await new Promise((res) => setTimeout(res, 4000));
        const mine = (await local.clientPids()).filter((pid) => !before.has(pid));
        if (mine.length) seen = true;
        else if (seen) { say('The game closed before it got in: Spectate Player stopped', 'warn'); return; }
        const r = await viaTarget('playerAction', { ...arg, action: 'watch' });
        if (r && r.ok) return;
        if (!r || !r.offline) { say(`Spectate Player: ${(r && r.error) || 'failed'}`, 'error'); return; }
      }
      say(`${first.charName} wasn't in the game after 5 minutes: Spectate Player stopped`, 'warn');
    } finally { ghostJob = null; }
  })();
  return { ok: true, starting: true };
}

// ---- This app's own updates (tools/app-update.js): Settings, Software; checked at launch ----
let lastUpdateCheck = null;
const codeWatch = appUpdate.watchCode(__dirname); // this app's files as it started
// Both kinds: newer commits on the remote (git, at launch and on Check for Updates) and newer
// code on disk than the running app (a sync, an edit; looked at every 15 s)
function withLocal(r) {
  const files = codeWatch.changed();
  const out = { ...(r || { ok: true, behind: 0, ahead: 0, newest: [] }), localFiles: files, local: files.length > 0 };
  out.available = !!(out.ok && out.behind) || out.local;
  out.canUpdate = out.local || !!out.canUpdate;
  return out;
}
async function checkAppUpdate() {
  const r = withLocal(await appUpdate.check());
  lastUpdateCheck = r;
  if (r.ok) local.setSettings({ appUpdateCheckedAt: Date.now() });
  send('app-update', r);
  return r;
}
let lastLocalCount = 0;
setInterval(() => {
  if (prefs().appUpdateAuto === false) return;
  const n = codeWatch.changed().length;
  if (n !== lastLocalCount) { lastLocalCount = n; lastUpdateCheck = withLocal(lastUpdateCheck); send('app-update', lastUpdateCheck); }
}, 15000);

const handlers = {
  appVersion: () => ({ ...appUpdate.version(__dirname), auto: prefs().appUpdateAuto !== false, last: lastUpdateCheck, checkedAt: prefs().appUpdateCheckedAt || 0 }),
  appCheckUpdate: () => checkAppUpdate(),
  appSetAutoUpdate: (on) => { local.setSettings({ appUpdateAuto: !!on }); return { ok: true }; },
  // Update, then start again on the new code (the shards keep running meanwhile)
  appUpdate: async () => {
    let r = { ok: true, nothing: true };
    if (lastUpdateCheck && lastUpdateCheck.behind) r = await appUpdate.update(__dirname);
    if (!r.ok) return r;
    // Nothing to pull but newer code on disk: a restart is the update
    if (r.nothing && !codeWatch.changed().length) return r;
    if (r.nothing) r = { ok: true, from: 'running', to: 'on disk', localOnly: true };
    if (r.electronChanged) return { ...r, relaunch: false, note: 'Electron changed: run tools/install-apps.sh, then open Shard Admin again' };
    setTimeout(() => { app.relaunch(); app.exit(0); }, 600);
    return { ...r, relaunch: true };
  },
  ...Object.fromEntries(Object.keys(localCalls).map((name) => [name, (arg) => viaTarget(name, arg)])),
  staffSignIn: async (arg) => {
    const r = await viaTarget('staffSignIn', arg);
    staffLogin = r && r.ok ? { account: r.staffAs.account, password: String((arg && arg.password) || '') } : staffLogin;
    return r;
  },
  staffSignOut: async () => { staffLogin = null; return viaTarget('staffSignOut'); },
  ghostTo: (arg) => ghostTo(arg || {}),
  // This computer's things, whichever shard is picked
  writeServerList: ({ name, ip }) => local.writeServerList(name, ip),
  buildClient: () => local.buildClient(),
  stopClient: () => local.stopClient(),
  readTracker: () => local.readTracker(),
  setTestDone: ({ line, done }) => local.setTestDone(line, done),
  openRepoPath: (rel) => shell.openPath(path.join(repo, rel)),
  setTheme: (t) => { nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system'; return true; },
  // The game here, connected to the picked shard (through its AuthServer when fake auth is
  // off there, from the last status)
  startClient: () => launchClient(''),
  reveal: async (key) => {
    if (!remote) { shell.showItemInFolder(local.logFor(key)); return true; }
    if (key === 'machine') { shell.showItemInFolder(outFile); return true; }
    // The logs are there: copy them here, then show them
    await remote.step('logs');
    shell.openPath(path.join(repo, '.local', 'remote', 'servers'));
    return true;
  },
  // Machines
  target: () => describeTarget(),
  machines: () => ({ list: machines(), target: describeTarget() }),
  useTarget: (id) => useTarget(id),
  saveMachine: (p) => {
    const m = checkProfile(p);
    const list = machines().filter((x) => x.id !== m.id);
    const at = machines().findIndex((x) => x.id === m.id);
    list.splice(at < 0 ? list.length : at, 0, m);
    local.setSettings({ remotes: list });
    if (remote && remote.profile.id === m.id) useTarget(m.id); // reconnect with the new settings
    return { list, saved: m };
  },
  deleteMachine: (id) => {
    if (remote && remote.profile.id === id) useTarget('local');
    local.setSettings({ remotes: machines().filter((x) => x.id !== id) });
    return { list: machines() };
  },
  machineStep: async (cmd) => {
    if (!remote) throw new Error('Pick a machine first');
    if (cmd === 'test') return remote.test();
    if (cmd === 'connect') { await remote.connect(); return { ok: remote.state === 'connected', error: remote.error }; }
    const r = await remote.step(cmd);
    if (r.ok && ['setup', 'data', 'copy-db'].includes(cmd)) remote.connect();
    return r;
  },
  machineTerminal: (cmd) => inTerminal(cmd),
  copyText: (text) => { clipboard.writeText(String(text || '').slice(0, 4 * 1024 * 1024)); return true; },
  pickFolder: async (title) => {
    const r = await dialog.showOpenDialog(win, { title: String(title || 'Choose a folder'), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
};
for (const [name, fn] of Object.entries(handlers)) {
  ipcMain.handle(name, async (_e, arg) => {
    try { return await fn(arg); } catch (e) { return { ok: false, error: e.message }; }
  });
}

app.whenReady().then(() => {
  // The Incarnate checkout: ask once when it isn't found (incarnate-repo.js), then start over
  const incRepo = require('./incarnate-repo');
  if (!incRepo.isRepo(repo)) {
    const pick = dialog.showOpenDialogSync({
      title: 'Where is your Incarnate checkout?',
      message: 'Pick the Incarnate folder (the one with tools/run-server.sh and src/).',
      properties: ['openDirectory'],
    });
    if (pick && incRepo.isRepo(pick[0])) { incRepo.save(pick[0]); app.relaunch(); app.exit(0); return; }
    dialog.showErrorBox('Incarnate Not Found', `No Incarnate checkout was picked. Clone https://github.com/Daggenthal/Incarnate next to this app, or set INCARNATE_REPO, then open Shard Admin again.\n\nLooked in:\n${incRepo.candidates().join('\n')}`);
    app.exit(1); return;
  }
  const t = prefs().theme;
  nativeTheme.themeSource = ['light', 'dark'].includes(t) ? t : 'system';
  seedMachines();
  createWindow();
  const last = prefs().target;
  if (last && last !== 'local' && machines().some((m) => m.id === last)) {
    try { useTarget(last); } catch { useTarget('local'); }
  }
  pushStatus();
  scheduleOutdated(1000);
  // Automatically check for updates (Settings, Software): once at launch
  if (prefs().appUpdateAuto !== false) setTimeout(() => checkAppUpdate().catch(() => {}), 8000);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
// Closing the window quits the app (on macOS too, so `npm start` returns to the prompt).
// The shard keeps running, here or on the machine; open the app again and it picks it back up.
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { if (remote) remote.close(); });
