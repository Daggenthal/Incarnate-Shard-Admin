// Shard Admin backend: everything that touches the shard (processes, logs, builds,
// configs, the database). Plain Node, no Electron, so it can be tested on its own:
//   node backend.js status
// main.js wires it to the window (IPC) and to desktop notifications.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { EventEmitter } = require('events');

const repo = require('./incarnate-repo').find() || path.resolve(__dirname, '..', 'Incarnate'); // the Incarnate checkout this app runs
const binRoot = path.join(repo, 'src', 'bin');          // the servers' working folder
const local = path.join(repo, '.local');                 // logs and secrets (git ignores it)
const serverLogDir = path.join(local, 'servers');        // one log per Launcher child
const readyDir = path.join(binRoot, 'logs', 'servers');  // <Name>.ready (incServerReady)
const crashDir = path.join(binRoot, 'logs', 'crashes');  // full crash reports (compat/posix process.c)
const cfgDir = path.join(binRoot, 'data', 'server', 'db');
const settingsFile = path.join(local, 'shard-admin.json');

// Started from the Dock or Finder, an app gets a bare PATH; the tools live in Homebrew
const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const PATH = [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), ...extraPath])].join(':');

// The container program for SQL Server: docker (the Mac, colima), else podman (SteamOS), else the
// host's podman from inside a distrobox. INCARNATE_DOCKER overrides (same rule as tools/db-up.sh).
function containerCmd() {
  if (process.env.INCARNATE_DOCKER) return process.env.INCARNATE_DOCKER.split(/\s+/);
  const has = (c) => PATH.split(':').some((d) => { try { fs.accessSync(path.join(d, c), fs.constants.X_OK); return true; } catch { return false; } });
  if (has('docker')) return ['docker'];
  if (has('podman')) return ['podman'];
  if (has('distrobox-host-exec')) return ['distrobox-host-exec', 'podman'];
  return ['docker'];
}
const dockerRun = (args, opts) => { const [c, ...pre] = containerCmd(); return run(c, [...pre, ...args], opts); };

// ---------------------------------------------------------------------------
// Settings: toggles and choices, kept in .local/shard-admin.json
// ---------------------------------------------------------------------------

// Server-side switches, passed to the DBServer and Launcher (and everything they
// start) as environment variables. "applied" is what the running shard started with.
const TOGGLES = [
  { key: 'optimizations', env: 'INCARNATE_OPTIMIZATIONS', on: null, off: '0', def: true,
    title: 'Optimizations', where: 'Server',
    about: 'Master switch for every Incarnate speed-up on the servers. Off is the original behavior, for comparing.' },
  { key: 'sharedMemoryExperimental', env: 'INCARNATE_SHARED_MEMORY', on: '1', off: '0', def: false,
    title: 'Shared memory for map servers (experimental)', where: 'Server',
    about: 'Map servers share their static game data instead of each loading a copy (about 1 GB each). Experimental on 64-bit: map servers crash moving the powers data into it. Also turns address randomization off for map servers.' },
  { key: 'mallocArenas', env: 'INCARNATE_MALLOC_ARENAS', on: null, off: '0', def: true,
    title: 'Cap malloc arenas (Linux)', where: 'Server',
    about: 'Linux only: MALLOC_ARENA_MAX=2 for every server. glibc otherwise keeps up to 8 memory pools per core, mostly empty. Usually 10 to 30% less RAM. No effect on macOS.' },
  { key: 'mimalloc', env: 'INCARNATE_ALLOCATOR', on: 'mimalloc', off: null, def: false,
    title: 'mimalloc allocator', where: 'Server',
    about: 'Loads mimalloc in place of the system allocator: less fragmentation over long uptimes, faster small allocations. Needs it installed (brew install mimalloc, or apt install libmimalloc2.0). Skipped in debug builds.' },
  { key: 'forkProbe', env: 'INCARNATE_FORK_PROBE', on: '1', off: null, def: false,
    title: 'Fork probe (diagnostic)', where: 'Server',
    about: 'Each map server lists its threads at the point a preloaded template would fork ("Fork probe:" in its log). For planning fork-based map servers; changes nothing else.' },
  { key: 'fakeAuth', env: 'INCARNATE_FAKE_AUTH', on: '1', off: '0', def: true,
    title: 'Fake auth (local testing)', where: 'Server',
    about: 'Any account name logs in without a password. Staff levels only apply from this machine and the addresses in Staff logins from (Settings). Off: real accounts and passwords through the AuthServer (Staff tab, Accounts), and the client logs in on port 2106. Turn off before anyone else can reach the shard.' },
  // Default on where the shard runs for another computer (tools/remote-shard.sh sets it), so its
  // launcher health dot works; off on this computer
  { key: 'shareStatus', env: 'INCARNATE_STATUS_HOST', on: '0.0.0.0', off: '127.0.0.1', def: process.env.INCARNATE_STATUS_HOST === '0.0.0.0',
    title: 'Share the status page', where: 'Server',
    about: 'The status page (port 7099: up or down, servers up) answers other computers too, so launchers on them show the shard\'s health. It shows nothing private. Off: this computer only.' },
  { key: 'noQueue', env: 'INCARNATE_NO_QUEUE', on: '1', off: '0', def: true,
    title: 'Skip the QueueServer', where: 'Server',
    about: 'Game clients connect to the DBServer directly. Off routes logins through the QueueServer (the original setup).' },
  { key: 'startMaps', env: 'INCARNATE_START_MAPS', on: '1', off: '', def: false,
    title: 'Start Atlas Park with the shard', where: 'Server',
    about: 'Map 1 is running before the first login, so the first login is quicker (about 4 s). Off: every zone starts when a player needs it and stops after 30 minutes empty (MapserverIdleExit in servers.cfg), which saves about 2 GB while nobody plays.' },
  { key: 'debug', env: 'INCARNATE_DEBUG', on: '1', off: '0', def: false,
    title: 'Debug build (AddressSanitizer)', where: 'Server',
    about: 'Runs build-debug: every bad memory read or write is reported with a stack, and the servers keep going. Slower.' },
];

// Client-side optimizations: toggled in the game (chat commands); listed here so
// everything Incarnate changed is in one place.
const CLIENT_OPTIMIZATIONS = [
  { title: 'All client optimizations', command: '/optimizations 0|1', about: 'Master switch on the client.' },
  { title: 'Map preload', command: '/map_preload 0|1', about: 'Parses the predicted map\'s files at the login screen. Remembered in logs/map_preload.cfg.' },
  { title: 'Mini tracker memo', command: '/minitracker_memo 0|1', about: 'Objects with the same model and swaps share one answer during the map build.' },
  { title: 'Load Screen Cache', command: '/loadscreen_cache_build', about: 'Pre-renders TexWords so loads skip drawing them.' },
  { title: 'Benchmark', command: '/benchmark', about: 'Low, Medium, High sweep; results in logs/benchmarks.csv.' },
];

function defaultSettings() {
  const toggles = {};
  for (const t of TOGGLES) toggles[t.key] = t.def;
  return { buildDir: 'build-native', startSql: true, toggles, notify: true, autoRestart: true,
    // Messages to players (docs/BROADCAST.md)
    restartMessage: DEFAULT_RESTART_MESSAGE, schedules: [], plannedRestart: null, messageHistory: [] };
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const d = defaultSettings();
    return { ...d, ...s, toggles: { ...d.toggles, ...(s.toggles || {}) } };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(s) {
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
}

function envForToggles(toggles) {
  const env = {};
  for (const t of TOGGLES) {
    const v = toggles[t.key] ? t.on : t.off;
    env[t.env] = v; // null: leave unset (the default)
  }
  return env;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: repo, env: { ...process.env, PATH }, maxBuffer: 64 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr), err }));
  });
}

// Like run, but each line is passed on as it comes (and the output saved to a file as it goes),
// for steps that take minutes: the first SQL Server start downloads its image
function runLive(cmd, args, { env, file, onLine } = {}) {
  return new Promise((resolve) => {
    const out = file ? fs.createWriteStream(file, { flags: 'w' }) : null;
    const child = spawn(cmd, args, { cwd: repo, env: env || { ...process.env, PATH } });
    let all = '';
    let partial = '';
    const onData = (d) => {
      const t = String(d);
      all += t;
      if (out) out.write(t);
      partial += t;
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const l of lines) if (l.trim() && onLine) onLine(l.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => onData(`${cmd}: ${e.message}\n`));
    child.on('close', (code) => {
      if (partial.trim() && onLine) onLine(partial.trim());
      if (out) out.end();
      resolve({ code: code ?? 1, stdout: all, stderr: '' });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// "[[dd-]hh:]mm:ss" from ps, in seconds
// Linux: a process's share of memory (PSS): its own pages, plus each shared page divided by
// how many processes map it. RSS counts shared memory in full in every map server, so with
// shared memory on, adding RSS up counts the shared game data once per map server. PSS adds
// up to what the shard really takes. null where it can't be read (macOS: RSS then)
function pssMB(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+) kB/m);
    return m ? Math.round(+m[1] / 1024) : null;
  } catch { return null; }
}

// Linux: a process in another PID namespace (another shard's podman container). Unreadable
// (macOS, another user's process): not other
let ownPidNs = null;
function otherPidNs(pid) {
  if (process.platform !== 'linux') return false;
  try {
    if (ownPidNs === null) ownPidNs = fs.readlinkSync('/proc/self/ns/pid');
    return fs.readlinkSync(`/proc/${pid}/ns/pid`) !== ownPidNs;
  } catch { return false; }
}

function parseEtime(s) {
  let days = 0;
  if (s.includes('-')) { const [d, rest] = s.split('-'); days = +d; s = rest; }
  const parts = s.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  return days * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2];
}

const PROGRAMS = ['DBServer', 'Launcher', 'LogServer', 'MapServer', 'BeaconServer', 'BeaconClient', 'ChatServer',
  'QueueServer', 'TurnstileServer', 'MissionServer', 'StatServer', 'RaidServer', 'ArenaServer', 'AuctionServer', 'AccountServer', 'AuthServer'];
const PROGRAM_BY_LOWER = Object.fromEntries(PROGRAMS.map((p) => [p.toLowerCase(), p]));
// "/x/build-native/bin/MapServer", ".\\mapserver.exe", "TurnstileServe" (Linux cuts names at 15) -> "MapServer" ...
function canonicalName(s) {
  const base = String(s).split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
  if (!base) return null;
  if (PROGRAM_BY_LOWER[base]) return PROGRAM_BY_LOWER[base];
  if (base.length === 15) { const hit = PROGRAMS.find((p) => p.toLowerCase().startsWith(base)); if (hit) return hit; }
  return null;
}

// ---------------------------------------------------------------------------
// Which servers the shard has
// ---------------------------------------------------------------------------

// The DBServer, the Launcher, then every AppName in loadBalanceShardSpecific.cfg
// except the map servers (those are listed by map as they run)
// realAuth: fake auth off, so the AuthServer is part of the shard (docs/AUTH.md)
function shardServers(realAuth = false) {
  const list = [
    ...(realAuth ? [{ name: 'AuthServer', kind: 'core', about: 'Accounts and passwords: the game logs in here (port 2106), the DBServer checks play keys' }] : []),
    { name: 'DBServer', kind: 'core', about: 'Owns the database, logs players in, starts everything else' },
    { name: 'Launcher', kind: 'core', about: 'Starts the processes the DBServer asks for' },
  ];
  const text = readText(path.join(cfgDir, 'loadBalanceShardSpecific.cfg')) || '';
  const seen = new Set(list.map((s) => s.name));
  for (const m of text.matchAll(/^\s*AppName\s+"?([^"\s]+)"?/gim)) {
    const name = m[1];
    if (/^MapServer/i.test(name) || seen.has(name)) continue;
    seen.add(name);
    list.push({ name, kind: 'service', about: SERVICE_ABOUT[name] || '' });
  }
  return list;
}

const SERVICE_ABOUT = {
  LogServer: 'Collects the other servers\' logs (the DBServer program under another name)',
  ChatServer: 'Global chat channels, friends, global names',
  QueueServer: 'Login queue in front of the DBServer',
  TurnstileServer: 'Matchmaking for Incarnate trials and other queued events',
  MissionServer: 'Mission Architect: player-made story arcs',
  StatServer: 'Supergroup stats, leaderboards, leagues',
  RaidServer: 'Supergroup base raids and Items of Power',
  ArenaServer: 'Arena matches across maps',
  AuctionServer: 'The consignment house (Wentworth\'s / Black Market)',
  AccountServer: 'Account items, store purchases, the Paragon Market',
};

// The ninja target that builds a server's program
function targetFor(name) {
  if (name === 'LogServer') return 'dbserver';
  return name.toLowerCase();
}
const ALL_TARGETS = ['dbserver', 'launcher', 'mapserver', 'chatserver', 'queueserver', 'turnstileserver',
  'missionserver', 'statserver', 'raidserver', 'arenaserver', 'auctionserver', 'accountserver', 'authserver'];

// ---------------------------------------------------------------------------
// The shard
// ---------------------------------------------------------------------------

class Shard extends EventEmitter {
  // What this backend is doing ('starting', 'stopping', 'restarting', ...). Starting, stopping and
  // restarting are also written to .local/shard-busy.json, so another backend on the same shard
  // (Shard Admin's control service while tools/shards.sh or a terminal runs backend.js restart)
  // doesn't take the servers that one stops for crashes and start them a second time
  get busy() { return this._busy || null; }
  set busy(v) {
    this._busy = v;
    const f = path.join(local, 'shard-busy.json');
    try {
      if (v && /^(starting|stopping|restarting)$/.test(v)) fs.writeFileSync(f, JSON.stringify({ pid: process.pid, what: v, at: Date.now() }));
      else if (!v) { const b = JSON.parse(fs.readFileSync(f, 'utf8')); if (b.pid === process.pid) fs.unlinkSync(f); }
    } catch { /* no file */ }
  }

  // Another backend is starting, stopping or restarting this shard right now
  otherBusy() {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(local, 'shard-busy.json'), 'utf8'));
      return b.pid !== process.pid && alive(b.pid) && Date.now() - b.at < 15 * 60 * 1000 ? b : null;
    } catch { return null; }
  }

  constructor() {
    super();
    this.settings = loadSettings();
    this.applied = null;        // toggles the running shard was started with
    this.wrappers = {};         // run-server.sh children we started: name -> ChildProcess
    this.busy = null;           // 'starting' | 'stopping' | 'building' | null
    this.outdated = {};         // program name -> true when ninja would relink it
    this.outdatedChecked = 0;
    this.lastStates = {};
    this.alertTimes = {};
    this.restartTimes = {};     // server name -> times it was restarted after a crash (autoRestart)
    // Processes we stopped on purpose (stop, restart, restart updated, a map's stop link): pid -> when.
    // Their "stopped" alert and the log lines they print while shutting down aren't news.
    this.ourStops = new Map();
    this.quietLogs = {};        // log key -> time until which its log alerts are skipped
    this.pidNames = new Map();  // pid -> log key, from the last status
    this.lastPids = {};         // server name -> pid while it was up
    this.tails = new Map();     // log key -> { file, pos }
    this.firstPoll = true;      // logs that exist when the app opens: only new lines alert
    this.procs = [];
    try { this.applied = JSON.parse(readText(path.join(local, 'shard-admin-applied.json'))); } catch { this.applied = null; }
  }

  // Fake auth off: the AuthServer runs with the shard, and logins need real accounts
  realAuth() {
    const t = (this.applied && this.servingApplied()) ? this.applied : this.settings.toggles;
    return !t.fakeAuth;
  }

  // The running shard's switches count while it runs (a change waits for Restart all)
  servingApplied() {
    return (this.procs || []).some((p) => p.name === 'DBServer');
  }

  buildDir() {
    return path.join(repo, this.settings.toggles.debug ? 'build-debug' : this.settings.buildDir);
  }

  // ---- Processes ----

  async listProcesses() {
    // comm is the program's own name (not argv[0], which is ".\mapserver.exe" for map servers)
    const r = await run('ps', ['-axo', 'pid=,ppid=,etime=,%cpu=,rss=,comm=,args=']);
    const out = [];
    for (const line of r.stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      const exe = m[6];
      // The name from the program (comm), or from argv[0] (".\\mapserver.exe" for map servers)
      const inArgs = (m[7].match(/\/build-[^/\s]+\/bin\/(\w+)/) || [])[1]; // ".../build-native/bin/DBServer" anywhere
      const name = canonicalName(exe) || canonicalName((m[7].split(/\s+/)[0] || '')) || (inArgs && canonicalName(inArgs));
      if (!name) continue;
      // Only this repo's builds. macOS's comm is the path cut to 16 characters
      // ("/Users/you/src/I"), so judge by argv[0] when it is a full path, and by comm only
      // when comm isn't cut. (The cut comm hid the DBServer and Launcher from the app.)
      const arg0 = m[7].split(/\s+/)[0] || '';
      const full = arg0.startsWith('/') ? arg0 : (exe.startsWith('/') && exe.length < 16 ? exe : null);
      if (full && !full.startsWith(repo) && !full.includes('/build-')) continue;
      // Another shard's container (tools/shards.sh) runs the same programs from the same repo,
      // and its processes show in ps here: not ours. Restarting or stopping them from here
      // would hit that shard, and its map servers counted as this shard's
      if (otherPidNs(+m[1])) continue;
      out.push({ pid: +m[1], ppid: +m[2], uptime: parseEtime(m[3]), cpu: +m[4], rssMB: pssMB(+m[1]) ?? Math.round(+m[5] / 1024),
        name, exe, args: m[7] });
    }
    this.procs = out;
    return out;
  }

  readyPid(name) {
    const t = readText(path.join(readyDir, `${name}.ready`));
    const pid = t ? parseInt(t, 10) : 0;
    return alive(pid) ? pid : 0;
  }

  logFor(name) {
    // run-server.sh's own log for the servers this app starts itself; the Launcher's children
    // log to .local/servers
    if (name === 'DBServer' || name === 'Launcher' || name === 'AuthServer') return path.join(local, `${name}.out`);
    // The run before (run-server.sh keeps it when a new one starts): where a crash restart's crash is
    if (/^(DBServer|Launcher|AuthServer)\.prev$/.test(name)) return path.join(local, `${name}.out`);
    if (name === 'sql') return path.join(local, 'sql.out');
    if (name === 'build') return path.join(local, 'build.out');
    return path.join(serverLogDir, `${name}.out`);
  }

  async status() {
    const procs = await this.listProcesses();
    const bin = path.join(this.buildDir(), 'bin');
    const now = Date.now();
    const servers = shardServers(this.realAuth()).map((s) => {
      const mine = procs.filter((p) => p.name === s.name);
      const readyPid = this.readyPid(s.name);
      let state = 'down';
      if (readyPid) state = 'up';
      else if (mine.length) state = 'starting';
      const proc = mine.find((p) => p.pid === readyPid) || mine[0];
      const binary = path.join(bin, s.name);
      const binTime = mtime(binary);
      const startedAt = proc ? now - proc.uptime * 1000 : 0;
      return {
        ...s,
        state,
        pid: proc ? proc.pid : 0,
        uptime: proc ? proc.uptime : 0,
        cpu: mine.reduce((a, p) => a + p.cpu, 0),
        rssMB: mine.reduce((a, p) => a + p.rssMB, 0),
        log: this.logFor(s.name),
        built: !!binTime,
        outdated: !!this.outdated[s.name],
        // a build finished after this process started: restart to run it
        restartNeeded: !!(proc && binTime && binTime > startedAt + 2000),
      };
    });
    // Map servers and beacon processes, one row each, as they run
    const extras = procs
      .filter((p) => /^(MapServer|BeaconServer|BeaconClient)$/.test(p.name))
      .map((p) => {
        const id = (p.args.match(/-map_id\s+(\d+)/i) || [])[1];
        let label = p.name;
        let logName = p.name;
        if (p.name === 'MapServer') {
          if (id) { label = `Map Server (Map ${id})`; logName = `MapServer-${id}`; }
          else if (/-tsr2?\b/i.test(p.args)) { label = 'Map Server (Standby)'; logName = 'MapServer-standby'; }
          else if (/-chatservernames/i.test(p.args)) { label = 'Map Server (Chat Names)'; logName = 'MapServer-names'; }
        } else if (p.name === 'BeaconServer') {
          logName = /-beaconmasterserver/i.test(p.args) ? 'BeaconServer-master' : 'BeaconServer-request';
          label = /master/.test(logName) ? 'Beacon Server (Master)' : 'Beacon Server (Request)';
        } else if (p.name === 'BeaconClient') {
          label = 'Beacon Client';
        }
        // A map is a zone or a mission someone is in (it has a map id); the standby and the
        // one that tells the ChatServer the reserved names are helpers, not maps
        return { name: label, logName, kind: p.name !== 'MapServer' ? 'beacon' : id ? 'map' : 'helper', mapId: id ? +id : null, state: 'up', pid: p.pid,
          uptime: p.uptime, cpu: p.cpu, rssMB: p.rssMB, log: path.join(serverLogDir, `${logName}.out`),
          restartNeeded: (() => { const t = mtime(path.join(bin, p.name)); return !!(t && t > now - p.uptime * 1000 + 2000); })() };
      });
    const up = servers.filter((s) => s.state === 'up').length;
    const all = [...servers, ...extras];
    this.pidNames = new Map();
    for (const s of servers) if (s.pid) this.pidNames.set(s.pid, s.name);
    for (const e of extras) this.pidNames.set(e.pid, e.logName);
    const totals = { cpu: all.reduce((a, s) => a + (s.cpu || 0), 0), rssMB: all.reduce((a, s) => a + (s.rssMB || 0), 0),
      maps: extras.filter((e) => e.kind === 'map').length };
    const clientRunning = (await this.clientPids()).length > 0;
    const result = {
      servers, extras, up, total: servers.length, busy: this.busy, totals, clientRunning,
      lastProgress: this.lastProgress || '', restarting: !!this.restarting,
      // After the DBServer is ready the Launcher still starts the rest, for a minute or two
      warming: !!(this.startedAt && Date.now() - this.startedAt < 4 * 60 * 1000 && up < servers.length &&
        servers.some((s) => s.name === 'DBServer' && s.state !== 'down')),
      outdatedCount: Object.keys(this.outdated).filter((k) => this.outdated[k]).length,
      outdatedChecked: this.outdatedChecked,
      buildConfigured: fs.existsSync(path.join(this.buildDir(), 'build.ninja')),
      toggles: this.settings.toggles, applied: this.applied, realAuth: this.realAuth(),
      pendingRestart: !!(this.applied && up > 0 && JSON.stringify(this.applied) !== JSON.stringify(this.settings.toggles)),
      plannedRestart: this.settings.plannedRestart || null,
      shardName: this.readServersCfg().values.ShardName || 'Incarnate',
      // The name players pick in the game's server list (the client names server ids itself)
      serverId: AUTH_SERVER_ID, serverName: SERVER_NAMES[AUTH_SERVER_ID - 1],
      serverNames: SERVER_NAMES.map((name, i) => ({ id: i + 1, name, ours: i + 1 === AUTH_SERVER_ID })),
      staffAs: this.staffAs(),
      sqlUp: await this.sqlUp(),
      host: await hostStats(this.buildDir()),
    };
    this.watchStates(servers);
    return result;
  }

  // A core server that stopped on its own (a crash) is started again, like a container with a
  // restart policy: at most AUTO_RESTART_MAX times in AUTO_RESTART_WINDOW_MS, then it stays down
  // and says so (a crash loop needs a look, not more restarts). The DBServer brings the
  // shard's other services back itself, and map servers start when a player needs them.
  autoRestart(name) {
    const now = Date.now();
    const times = (this.restartTimes[name] || []).filter((t) => now - t < AUTO_RESTART_WINDOW_MS);
    if (times.length >= AUTO_RESTART_MAX) {
      this.restartTimes[name] = times;
      this.alert(name, `${name} keeps crashing: not restarting it`,
        `It stopped ${times.length + 1} times in ${AUTO_RESTART_WINDOW_MS / 60000} minutes. Its log shows why; Start shard or Restart once it's fixed.`);
      return;
    }
    times.push(now);
    this.restartTimes[name] = times;
    this.alert(name, `${name} stopped: restarting it (${times.length} of ${AUTO_RESTART_MAX})`, 'It was up and stopped on its own. Its log shows why.', 'warn');
    setTimeout(async () => {
      if (this.busy) return; // a start, stop or build is already doing something about it
      try {
        if (name === 'DBServer') await this.restartAll({ notify: false }); // it's gone: nobody to tell
        else if (name === 'AuthServer') await this.startAuthServer(this.shardEnv(this.applied || this.settings.toggles), () => false);
        else if (name === 'Launcher') await this.restart('Launcher');
      } catch (e) {
        this.alert(name, `${name}: restarting it failed`, e.message);
      }
    }, 2000);
  }

  // Alerts when a server that was up goes down
  watchStates(servers) {
    for (const s of servers) {
      const prev = this.lastStates[s.name];
      const stoppedByUs = this.ourStops.has(this.lastPids[s.name]);
      if (prev === 'up' && s.state !== 'up' && this.busy !== 'stopping' && !this.restarting && !stoppedByUs && !this.otherBusy()) {
        if (AUTO_RESTART.includes(s.name) && this.settings.autoRestart) this.autoRestart(s.name);
        else this.alert(s.name, `${s.name} stopped`, 'It was up and is not anymore. Its log shows why.');
      }
      this.lastStates[s.name] = s.state;
      if (s.state === 'up' && s.pid) this.lastPids[s.name] = s.pid;
    }
  }

  alert(source, title, body, level = 'error') {
    const key = `${source}:${title}`;
    const now = Date.now();
    if (this.alertTimes[key] && now - this.alertTimes[key] < 30000) return; // once per 30 s
    this.alertTimes[key] = now;
    this.emit('alert', { source, title, body, level, time: now });
  }

  // ---- Logs: tail every log, stream the ones the window shows, alert on errors ----

  logKeys() {
    const keys = new Set(['DBServer', 'Launcher', 'sql', 'build']);
    for (const s of shardServers(this.realAuth())) keys.add(s.name);
    for (const n of ['DBServer', 'Launcher', 'AuthServer']) if (fs.existsSync(path.join(local, `${n}.prev.out`))) keys.add(`${n}.prev`);
    try {
      for (const f of fs.readdirSync(serverLogDir)) if (f.endsWith('.out')) keys.add(f.slice(0, -4));
    } catch { /* no logs yet */ }
    return [...keys];
  }

  readLogTail(key, bytes = 256 * 1024) {
    const file = this.logFor(key);
    try {
      const st = fs.statSync(file);
      const start = Math.max(0, st.size - bytes);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      let text = buf.toString('utf8');
      if (start > 0) text = text.slice(text.indexOf('\n') + 1);
      return { key, file, text, size: st.size };
    } catch {
      return { key, file, text: '', size: 0 };
    }
  }

  pollLogs() {
    for (const key of this.logKeys()) {
      if (key.endsWith('.prev')) continue; // finished logs: nothing new, and their alerts were seen
      const file = this.logFor(key);
      let size;
      try { size = fs.statSync(file).size; } catch { continue; }
      let t = this.tails.get(key);
      if (!t) {
        // Already there when the app opened: only its new lines count. Made since: all of it.
        t = { file, pos: this.firstPoll ? size : 0 };
        this.tails.set(key, t);
        if (this.firstPoll) continue;
      }
      if (size < t.pos) t.pos = 0; // the log was started over
      if (size === t.pos) continue;
      const fd = fs.openSync(file, 'r');
      const len = Math.min(size - t.pos, 4 * 1024 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, t.pos);
      fs.closeSync(fd);
      t.pos += len;
      const text = buf.toString('utf8');
      this.emit('log', { key, text });
      this.scanForAlerts(key, text);
    }
    this.firstPoll = false;
  }

  // A log that was just started over: read it from the top
  resetTail(key) { this.tails.set(key, { file: this.logFor(key), pos: 0 }); }

  scanForAlerts(key, text) {
    if (key === 'build') return; // the build reports through its own result
    if (this.quietLogs[key] > Date.now() || this.quietAll > Date.now()) return; // shutting down because we asked it to
    for (const line of text.split('\n')) {
      if (ALERT_IGNORE.test(line)) continue;
      const hit = ALERT_RULES.find((r) => r.re.test(line));
      if (hit) this.alert(key, `${key}: ${hit.title}`, line.trim().slice(0, 300), hit.level);
    }
  }

  // ---- Start, stop, restart ----

  shardEnv(toggles) {
    const env = { ...process.env, PATH, INCARNATE_SERVER_LOG_DIR: serverLogDir, INCARNATE_COLOR: '0' };
    for (const [k, v] of Object.entries(envForToggles(toggles))) {
      if (v === null) delete env[k]; else env[k] = v;
    }
    if (!toggles.debug) env.INCARNATE_BUILD_DIR = this.buildDir();
    // A list of map ids to start with the shard, in place of the Atlas Park switch (test shards:
    // tools/bench-server.sh writes it to their settings)
    const list = this.settings.startMapList;
    if (typeof list === 'string' && /^[0-9]+(,[0-9]+)*$/.test(list)) env.INCARNATE_START_MAPS = list;
    return env;
  }

  startWrapper(name, env) {
    const child = spawn(path.join(repo, 'tools', 'run-server.sh'), [name], {
      cwd: repo, env, stdio: 'ignore', detached: true, // its own group, so it outlives a window reload
    });
    child.unref();
    this.wrappers[name] = child;
    return child;
  }

  async waitForText(file, re, timeoutMs, stopIf) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const t = readText(file) || '';
      if (re.test(t)) return true;
      if (stopIf && stopIf()) return false;
      await sleep(500);
    }
    return false;
  }

  progress(text, level = 'info') {
    this.lastProgress = text;
    this.emit('progress', { text, level, time: Date.now() });
  }

  async start() {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    this.busy = 'starting';
    this.cancelStart = false;  // Stop shard during a start sets it
    const token = {};
    this.startToken = token;
    const cancelled = () => this.cancelStart || this.startToken !== token;
    try {
      const procs = await this.listProcesses();
      if (procs.some((p) => p.name === 'DBServer')) {
        this.progress('The Database Server is already running. Stop the shard first, or use Restart all.', 'warn');
        return { ok: false, error: 'already running' };
      }
      // Servers left from an earlier run (started by a Launcher that is gone) hold their
      // single-instance locks and their ports, and the DBServer sees them as running, so
      // they would never be started fresh. Stop them first.
      const leftovers = procs.filter((p) => p.name !== 'DBServer');
      if (leftovers.length) {
        this.progress(`Stopping ${leftovers.length} servers left from an earlier run (${[...new Set(leftovers.map((p) => p.name))].join(', ')})`, 'warn');
        await this.killPids(leftovers.map((p) => p.pid));
      }
      const toggles = { ...this.settings.toggles };
      const env = this.shardEnv(toggles);
      fs.mkdirSync(serverLogDir, { recursive: true });
      // Ready files from processes that are gone would count servers as up before they are
      try {
        for (const f of fs.readdirSync(readyDir)) {
          const pid = parseInt(readText(path.join(readyDir, f)) || '', 10);
          if (!alive(pid)) fs.unlinkSync(path.join(readyDir, f));
        }
      } catch { /* none */ }

      // One of the extra shards (tools/shards.sh, its own container): SQL Server and the
      // AuthServer belong to the main shard
      const extra = !!process.env.INCARNATE_EXTRA_SHARD;
      if (this.settings.startSql && !extra) {
        this.progress('Starting SQL Server (tools/db-up.sh)');
        const r = await runLive(path.join(repo, 'tools', 'db-up.sh'), [], {
          env, file: path.join(local, 'sql.out'), onLine: (l) => this.progress(`SQL Server: ${l.replace(/^\.+/, '')}`) });
        if (r.code !== 0) {
          this.progress('SQL Server did not start. See the sql log.', 'error');
          this.alert('sql', 'SQL Server did not start', (r.stderr || r.stdout).trim().split('\n').pop() || '');
          return { ok: false, error: 'sql' };
        }
        this.progress('SQL Server is up', 'ok');
      }

      if (!toggles.fakeAuth && !extra) {
        const a = await this.startAuthServer(env, cancelled);
        if (!a.ok) return a;
      }

      this.progress('Starting the Database Server');
      const dbLog = this.logFor('DBServer');
      rotateLog(dbLog); // run-server.sh does too; here so the window's tail starts fresh
      this.resetTail('DBServer');
      const db = this.startWrapper('DBServer', env);
      const dbExited = () => db.exitCode !== null;
      // The DBServer waits only about 15 seconds for launchers, so the Launcher starts right then
      const waiting = await this.waitForText(dbLog, /Waiting for launchers to link up/, 30 * 60 * 1000, () => dbExited() || cancelled());
      if (cancelled()) return { ok: false, error: 'stopped' };
      // Another DBServer still holds the ports: the Launcher would join that one, and this
      // one would run with no launcher (no map servers, no logins)
      if (/Error binding to port|Can't bind port/.test(readText(dbLog) || '')) {
        const others = (await this.listProcesses()).filter((p) => p.name === 'DBServer' && p.pid !== db.pid);
        this.progress(`Another Database Server is still running${others.length ? ` (pid ${others.map((p) => p.pid).join(', ')})` : ''} and holds its ports. Stopping both: start again after.`, 'error');
        this.alert('DBServer', 'Another DBServer holds the ports', 'Stop shard, then Start shard. If it keeps happening: pgrep -fl DBServer');
        await this.killPids([...others.map((p) => p.pid), ...(await this.listProcesses()).filter((p) => p.name === 'DBServer').map((p) => p.pid)]);
        return { ok: false, error: 'ports' };
      }
      if (!waiting) {
        this.progress('The Database Server stopped before it was ready. See its log.', 'error');
        return { ok: false, error: 'dbserver' };
      }
      this.progress('Starting the Launcher');
      rotateLog(this.logFor('Launcher'));
      this.resetTail('Launcher');
      this.startWrapper('Launcher', env);
      this.applied = toggles;
      this.startedAt = Date.now(); // the window shows "starting: k/N up" until all are up
      fs.writeFileSync(path.join(local, 'shard-admin-applied.json'), JSON.stringify(toggles));
      const ready = await this.waitForText(dbLog, /DbServer Ready/, 5 * 60 * 1000, () => dbExited() || cancelled());
      if (cancelled()) return { ok: false, error: 'stopped' };
      if (ready) this.progress('Database Server ready; the Launcher is starting the other servers', 'ok');
      else this.progress('The Database Server did not report ready. See its log.', 'error');
      return { ok: ready };
    } finally {
      // A Stop (or a newer start) during this one owns the state now
      if (this.busy === 'starting' && this.startToken === token) this.busy = null;
    }
  }

  async killPids(pids, graceMs = 5000) {
    const now = Date.now();
    for (const pid of pids) {
      this.ourStops.set(pid, now);
      const key = this.pidNames.get(pid);
      if (key) this.quietLogs[key] = now + 15000;
    }
    for (const [pid, t] of this.ourStops) if (now - t > 5 * 60 * 1000) this.ourStops.delete(pid);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    const until = Date.now() + graceMs;
    while (Date.now() < until && pids.some(alive)) await sleep(250);
    for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }

  // Stops everything, whatever state it is in: during a start, after a crash, with servers
  // left from an earlier run or from a terminal (tools/run-all.sh, tools/run-server.sh)
  // ---- Global: what every shard here shares, SQL Server and the AuthServer ----

  // SQL Server answers on its port (cached 5 s)
  async sqlUp() {
    if (this._sql && Date.now() - this._sql.at < 5000) return this._sql.up;
    const port = Number(process.env.INCARNATE_DB_PORT || 1433);
    const up = await new Promise((resolve) => {
      const sock = require('net').connect({ host: process.env.INCARNATE_DB_HOST || '127.0.0.1', port, timeout: 800 });
      const done = (v) => { sock.destroy(); resolve(v); };
      sock.on('connect', () => done(true)); sock.on('error', () => done(false)); sock.on('timeout', () => done(false));
    });
    this._sql = { at: Date.now(), up };
    return up;
  }

  // Start Global (the top bar): SQL Server, then the AuthServer; the shards start from the sidebar
  async startGlobal() {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    this.busy = 'starting';
    try {
      const toggles = { ...this.settings.toggles };
      const env = this.shardEnv(toggles);
      if (!(await this.sqlUp())) {
        this.progress('Starting SQL Server (tools/db-up.sh)');
        const r = await runLive(path.join(repo, 'tools', 'db-up.sh'), [], {
          env, file: path.join(local, 'sql.out'), onLine: (l) => this.progress(`SQL Server: ${l.replace(/^\.+/, '')}`) });
        this._sql = null;
        if (r.code !== 0) { this.progress('SQL Server did not start. See the sql log.', 'error'); return { ok: false, error: 'sql' }; }
        this.progress('SQL Server is up', 'ok');
      } else this.progress('SQL Server is already up', 'ok');
      if (toggles.fakeAuth) {
        this.progress('Fake auth is on, so no AuthServer: the game logs in to the Database Server directly', 'warn');
        return { ok: true };
      }
      if (this.readyPid('AuthServer')) { this.progress('The AuthServer is already up', 'ok'); return { ok: true }; }
      fs.mkdirSync(serverLogDir, { recursive: true });
      return await this.startAuthServer(env, () => false);
    } finally {
      this.busy = null;
    }
  }

  // Stop All (the top bar): every other shard, this one, the AuthServer, and SQL Server when
  // Shard Admin starts it (Settings, Start SQL Server)
  async stopAll() {
    if (this.podmanCmd() && fs.existsSync(path.join(local, 'shards'))) {
      this.progress('Stopping the other shards');
      await runLive(path.join(repo, 'tools', 'shards.sh'), ['down', 'all'], {
        env: { ...process.env, PATH, NO_COLOR: '1' }, onLine: (l) => this.progress(l) });
      this._podCache = null;
    }
    const r = await this.stop();
    if (this.settings.startSql) {
      this.progress('Stopping SQL Server');
      await runLive(path.join(repo, 'tools', 'db-up.sh'), ['down'], { onLine: (l) => this.progress(`SQL Server: ${l}`) });
      this._sql = null;
    }
    this.progress('Everything stopped', 'ok');
    return r;
  }

  // Freedom (this shard): its servers. keepGlobal leaves the AuthServer up for the other shards
  // (Stop in the sidebar); plain stop() takes everything this shard's backend started
  async stop({ keepGlobal = false } = {}) {
    if (this.busy === 'stopping') return { ok: false };
    if (this.busy === 'starting') this.cancelStart = true;
    this.busy = 'stopping';
    this.startedAt = 0;
    try {
      this.progress('Stopping the shard');
      // The Launcher first (so nothing is started again), then what it started, the DBServer last
      const keep = (p) => keepGlobal && p.name === 'AuthServer';
      let procs = (await this.listProcesses()).filter((p) => !keep(p));
      const wrappers = Object.entries(this.wrappers).filter(([n]) => !(keepGlobal && n === 'AuthServer')).map(([, c]) => c.pid).filter(alive);
      await this.killPids(procs.filter((p) => p.name === 'Launcher').map((p) => p.pid));
      procs = (await this.listProcesses()).filter((p) => !keep(p));
      await this.killPids(procs.filter((p) => p.name !== 'DBServer').map((p) => p.pid));
      procs = (await this.listProcesses()).filter((p) => !keep(p));
      await this.killPids(procs.map((p) => p.pid), 10000);
      // Anything that said it was ready, even if ps named it in a way we didn't recognize
      const readyPids = [];
      try {
        for (const f of fs.readdirSync(readyDir)) {
          if (keepGlobal && f === 'AuthServer.ready') continue;
          const pid = parseInt(readText(path.join(readyDir, f)) || '', 10);
          if (alive(pid)) readyPids.push(pid);
        }
      } catch { /* none */ }
      if (readyPids.length) await this.killPids(readyPids, 5000);
      // run-server.sh wrappers from any session (they'd restart nothing, but they hold the logs open)
      const ps = await run('ps', ['-axo', 'pid=,args=']);
      const scripts = ps.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
        .filter((m) => /tools\/run-server\.sh\s/.test(m[2]) && m[2].includes(repo) && !(keepGlobal && /run-server\.sh AuthServer/.test(m[2]))).map((m) => +m[1]);
      await this.killPids([...new Set([...wrappers, ...scripts])], 2000);
      this.wrappers = keepGlobal && this.wrappers.AuthServer ? { AuthServer: this.wrappers.AuthServer } : {};
      try { for (const f of fs.readdirSync(readyDir)) if (!(keepGlobal && f === 'AuthServer.ready')) fs.unlinkSync(path.join(readyDir, f)); } catch { /* none */ }
      this.progress(keepGlobal ? 'Shard stopped (the AuthServer stays up for the others)' : 'Shard stopped', 'ok');
      return { ok: true };
    } finally {
      this.busy = null;
    }
  }

  // opts.warnMinutes: tell the players and restart that many minutes from now (a countdown in
  // chat, cancelRestart stops it). Otherwise now: the players get opts.message (or the one in
  // Settings) in chat, then the DBServer's own shutdown saves every map and sends them to the
  // login screen with it, then the rest stops and everything starts again. opts.notify false:
  // no message (a crash restart, where the DBServer is already gone).
  async restartAll(opts = {}) {
    const warn = Math.max(0, Math.min(24 * 60, Math.round(+opts.warnMinutes || 0)));
    if (warn > 0) return this.planRestart(Date.now() + warn * 60000, opts.message, null);
    if (this.settings.plannedRestart) this.setSettings({ plannedRestart: null }); // this is it
    this.restarting = true; // the window says "Restarting" through both halves
    try {
      if (this.readyPid('DBServer')) await this.gracefulShutdown(opts.notify === false ? null : this.restartText(opts.message));
      this.progress('Restarting the whole shard: stopping first');
      await this.stop();
      return await this.start();
    } finally {
      this.restarting = false;
    }
  }

  // ---- Messages to players, planned restarts, schedules (docs/BROADCAST.md) ----

  restartText(message) {
    return cleanMessage(message) || cleanMessage(this.settings.restartMessage) || DEFAULT_RESTART_MESSAGE;
  }

  // One command to the DBServer through its inbox (svrmoncomm.c, incControlPoll): a file only
  // this user can write, renamed into place whole. It deletes the file once read.
  async dbCommand(cmd, text) {
    if (!this.readyPid('DBServer')) return { ok: false, error: 'The shard isn\'t running: no players to tell' };
    fs.mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(inboxDir, 0o700);
    this.cmdSeq = (this.cmdSeq || 0) + 1;
    const base = `${Date.now()}-${String(this.cmdSeq).padStart(6, '0')}-${process.pid}`;
    const tmp = path.join(inboxDir, `${base}.tmp`);
    const file = path.join(inboxDir, `${base}.cmd`);
    fs.writeFileSync(tmp, `${cmd} ${text || ''}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      if (!fs.existsSync(file)) return { ok: true };
    }
    try { fs.unlinkSync(file); } catch { /* read just now */ }
    return { ok: false, error: 'The Database Server didn\'t pick it up. It needs this build: Build all, then Restart all.' };
  }

  async broadcast(message) {
    const text = cleanMessage(message);
    if (!text) return { ok: false, error: 'Write a message first' };
    const r = await this.dbCommand('chat', text);
    const hist = [{ time: Date.now(), text, ok: r.ok, error: r.error || '' }, ...(this.settings.messageHistory || [])].slice(0, 30);
    this.setSettings({ messageHistory: hist });
    if (r.ok) this.progress(`Sent to every player: ${text}`, 'ok');
    else this.progress(`Message not sent: ${r.error}`, 'warn');
    return r;
  }

  // The DBServer's shutdown: maps save their players and send them to the login screen with
  // the message, then it exits (about 5 to 60 seconds). An older DBServer build without the
  // inbox: the stop after this does it the old way.
  async gracefulShutdown(text) {
    if (text) {
      const r = await this.broadcast(text);
      if (r.ok) await sleep(5000); // time to read it
    }
    const pid = this.readyPid('DBServer');
    this.quietAll = Date.now() + 120000; // maps and services stopping print what crashes print
    const r = await this.dbCommand('shutdown', text || 'The server is restarting');
    if (!r.ok) return false;
    this.progress('Saving every map and sending players to the login screen (up to a minute)');
    this.ourStops.set(pid, Date.now());
    const until = Date.now() + 90000;
    while (Date.now() < until && alive(pid)) await sleep(500);
    if (!alive(pid)) this.progress('Every map saved; the Database Server stopped', 'ok');
    else this.progress('The Database Server is still saving after 90 seconds: stopping it', 'warn');
    return !alive(pid);
  }

  // A restart at a time, with warnings in chat on the way (RESTART_WARNINGS)
  planRestart(at, message, scheduleId) {
    if (this.settings.plannedRestart && this.settings.plannedRestart.at <= at && !scheduleId)
      return { ok: false, error: 'A restart is already planned sooner: cancel it first' };
    const planned = { at, message: cleanMessage(message), scheduleId: scheduleId || null, warned: [] };
    this.setSettings({ plannedRestart: planned });
    const min = Math.round((at - Date.now()) / 60000);
    this.progress(`Restart planned for ${new Date(at).toLocaleString()} (in ${min} min); players are warned in chat`, 'ok');
    this.schedulerTick();
    return { ok: true, plannedRestart: planned };
  }

  async cancelRestart() {
    const p = this.settings.plannedRestart;
    if (!p) return { ok: true };
    this.setSettings({ plannedRestart: null });
    if (p.warned.length && this.readyPid('DBServer')) await this.broadcast('The server restart is cancelled.');
    this.progress('Planned restart cancelled', 'ok');
    return { ok: true };
  }

  // ---- Memory errors (the debug build): every AddressSanitizer report in the logs, the same
  // bug counted once (its kind and top frames), into .local/memory-errors.txt ----

  memoryErrors() {
    const seen = new Map();
    for (const key of this.logKeys()) {
      const file = this.logFor(key);
      let text;
      try {
        const st = fs.statSync(file);
        const start = Math.max(0, st.size - 32 * 1024 * 1024); // the last 32 MB of each log
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        text = buf.toString('utf8');
      } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // A crash (the crash handler's stack, all builds but the AddressSanitizer one)
        const c = lines[i].match(/^\*\*\* crashed: signal \d+ \((\w+)\)/);
        if (c) {
          const raw = [];
          let j = i + 1;
          for (; j < lines.length && j < i + 80 && !/^\*\*\* end of stack/.test(lines[j]); j++) raw.push(lines[j]);
          const named = nameFrames(raw);
          const ours = named.filter((l) => /^    #\d+ /.test(l) && !/inc_crash_handler/.test(l));
          const frames = ours.slice(0, 4).map((l) => l.replace(/^    #\d+ /, '').trim());
          const sig = `crash ${c[1]} | ${frames.join(' < ') || raw.slice(2, 5).join(' < ')}`;
          const e = seen.get(sig) || { kind: `crash (${c[1]})`, frames, count: 0, servers: new Set(), report: [lines[i], ...named].join('\n') };
          e.count++;
          e.servers.add(key);
          seen.set(sig, e);
          i = j;
          continue;
        }
        const m = lines[i].match(/==\d+==ERROR: AddressSanitizer: ([\w-]+)/);
        if (!m) continue;
        const block = [lines[i]];
        let j = i + 1;
        for (; j < lines.length && j < i + 200; j++) {
          block.push(lines[j]);
          if (/^SUMMARY: AddressSanitizer/.test(lines[j]) || /==\d+==ERROR: AddressSanitizer/.test(lines[j + 1] || '')) break;
        }
        i = j;
        const frames = block.filter((l) => /^\s+#\d+ 0x/.test(l)).slice(0, 4)
          .map((l) => l.replace(/^\s+#\d+ 0x[0-9a-f]+ in /, '').replace(/\s+\(.*\)$/, '').trim());
        const sig = `${m[1]} | ${frames.join(' < ')}`;
        const e = seen.get(sig) || { kind: m[1], frames, count: 0, servers: new Set(), report: block.join('\n') };
        e.count++;
        e.servers.add(key);
        seen.set(sig, e);
      }
    }
    const list = [...seen.values()].sort((a, b) => b.count - a.count);
    // The debugger's full reports (compat/posix process.c): every thread with its variables,
    // logs/crashes/<program>-<pid>-<time>.txt, the newest 5
    let reports = [];
    try {
      reports = fs.readdirSync(crashDir).filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs })).sort((a, b) => b.t - a.t).slice(0, 5);
    } catch { /* none yet */ }
    const full = reports.map(({ f }) => {
      let body = '';
      try { body = fs.readFileSync(path.join(crashDir, f), 'utf8').slice(0, 200 * 1024); } catch { /* gone */ }
      return `Full report ${f}:\n${body}`;
    });
    const text = (list.length
      ? list.map((e, n) => `#${n + 1} ${e.kind}: ${e.count} time${e.count === 1 ? '' : 's'} (${[...e.servers].join(', ')})\n${e.report}`).join('\n\n' + '-'.repeat(70) + '\n\n')
      : 'No crashes or memory errors in the logs.')
      + (full.length ? `\n\n${'='.repeat(70)}\n\n${full.join('\n\n' + '-'.repeat(70) + '\n\n')}` : '');
    const out = path.join(local, 'memory-errors.txt');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(out, `${new Date().toISOString()}: ${list.length} different crashes and memory errors\n\n${text}\n`);
    return { ok: true, unique: list.length, total: list.reduce((a, e) => a + e.count, 0),
      summary: list.map((e) => ({ kind: e.kind, count: e.count, servers: [...e.servers], where: e.frames[0] || '' })), text, file: out,
      debug: !!(this.applied || this.settings.toggles).debug };
  }

  // ---- Shards view: maps, instances and players, from the DBServer (svrmoncomm.c, overview) ----

  async overview() {
    if (!this.readyPid('DBServer')) return { ok: false, error: 'The shard isn\'t running' };
    const reply = `ov-${process.pid}-${Date.now().toString(36)}`;
    const file = path.join(outboxDir, `${reply}.json`);
    const r = await this.dbCommand('overview', reply);
    if (!r.ok) return r;
    let data = null;
    for (let i = 0; i < 20 && !data; i++) {
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { await sleep(100); }
    }
    try { fs.unlinkSync(file); } catch { /* not written */ }
    if (!data) return { ok: false, error: 'The Database Server didn\'t answer. It needs this build: Build all, then Restart all.' };
    const cfg = this.readServersCfg().values;
    for (const m of data.maps) {
      const file2 = m.file.split('/').pop().replace(/\.txt$/i, '');
      m.fileName = file2;
      m.zone = m.static ? zoneName(m.id) : '';
    }
    for (const p of data.players) {
      p.zone = zoneName(p.staticMap);
      p.archetype = (p.archetype || '').replace(/^Class_/i, '').replace(/_/g, ' ');
    }
    this.lastOverview = data;
    return { ok: true, shard: cfg.ShardName || 'Incarnate', serverName: SERVER_NAMES[AUTH_SERVER_ID - 1], staffAs: this.staffAs(), ...data };
  }

  // ---- The other shards on this machine (tools/shards.sh, docs/SHARDS.md) ----
  // Each runs in its own container and writes .local/shards/<name>/local/shard-status.json
  // every 5 seconds (tools/shard-container.js); podman says whether the container runs.

  podmanCmd() {
    if (this._podman !== undefined) return this._podman;
    const has = (t) => { try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'pipe' }); return true; } catch { return false; } };
    this._podman = process.platform !== 'linux' ? null : has('podman') ? ['podman'] : has('distrobox-host-exec') ? ['distrobox-host-exec', 'podman'] : null;
    return this._podman;
  }

  async extraShards() {
    const dir = path.join(local, 'shards');
    const pod = this.podmanCmd();
    let containers = {};
    if (pod && (!this._podCache || Date.now() - this._podCache.at > 4000)) {
      const r = await new Promise((resolve) => execFile(pod[0], [...pod.slice(1), 'ps', '-a', '--filter', 'name=^incarnate-shard-', '--format', 'json'],
        { timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : out)));
      const list = (() => { try { return JSON.parse(r || '[]'); } catch { return []; } })();
      const byName = {};
      for (const c of list) {
        const n = (Array.isArray(c.Names) ? c.Names[0] : c.Names || '').replace(/^incarnate-shard-/, '');
        byName[n] = { state: c.State, status: c.Status, restarts: c.Restarts ?? c.RestartCount ?? 0, startedAt: c.StartedAt ? c.StartedAt * 1000 : 0, exitCode: c.ExitCode };
      }
      this._podCache = { at: Date.now(), byName };
    }
    if (this._podCache) containers = this._podCache.byName;
    const shards = SERVER_NAMES.slice(1).map((name, i) => {
      const slug = name.toLowerCase();
      const sdir = path.join(dir, slug);
      const prepared = fs.existsSync(path.join(sdir, 'db', 'servers.cfg'));
      let st = null;
      try { st = JSON.parse(fs.readFileSync(path.join(sdir, 'local', 'shard-status.json'), 'utf8')); } catch { /* not started */ }
      let crashes = [];
      try {
        const cd = path.join(sdir, 'logs', 'crashes');
        crashes = fs.readdirSync(cd).filter((f) => f.endsWith('.txt'))
          .map((f) => ({ file: f, time: fs.statSync(path.join(cd, f)).mtimeMs })).sort((a, b) => b.time - a.time).slice(0, 5);
      } catch { /* none */ }
      const c = containers[slug] || null;
      return { name, slug, id: i + 2, port: 7000 + 200 * (i + 1), prepared, container: c,
        status: st, stale: !st || Date.now() - st.time > 20000, crashes };
    }).filter((x) => x.prepared || x.container);
    return { ok: true, podman: !!pod, enabled: fs.existsSync(path.join(dir, 'enabled')), shards,
      available: SERVER_NAMES.slice(1).filter((n) => !shards.some((x) => x.name === n)) };
  }

  // Start, restart or stop a whole shard (tools/shards.sh, minutes), or restart one of its
  // servers (a command file its container reads within 5 seconds)
  async extraShardAction({ name, action, server, atlas } = {}) {
    const i = SERVER_NAMES.indexOf(name);
    if (i < 1) return { ok: false, error: `Not one of the other shards: ${name}` };
    const slug = name.toLowerCase();
    if (action === 'restart-server') {
      if (!/^[A-Za-z]{2,24}$/.test(String(server || ''))) return { ok: false, error: 'Which server?' };
      const cd = path.join(local, 'shards', slug, 'local', 'shard-cmd');
      fs.mkdirSync(cd, { recursive: true, mode: 0o700 });
      const f = path.join(cd, `${Date.now()}-${process.pid}`);
      fs.writeFileSync(`${f}.tmp`, `restart ${server}\n`, { mode: 0o600 });
      fs.renameSync(`${f}.tmp`, `${f}.cmd`);
      this.progress(`${name}: restarting its ${server}`, 'warn');
      return { ok: true };
    }
    const sub = { start: 'start', restart: 'restart', stop: 'down', crash: 'crash' }[action];
    if (action === 'crash' && !/^(DBServer|Launcher|MapServer|ChatServer|AuctionServer|MissionServer|container)$/.test(String(server || ''))) return { ok: false, error: 'Crash which?' };
    if (!sub) return { ok: false, error: `Unknown action: ${action}` };
    if (!this.podmanCmd()) return { ok: false, error: 'No podman here: the other shards run on Linux (the Steam Machine)' };
    if (this.shardJobs && this.shardJobs[slug]) return { ok: false, error: `${name} is busy: ${this.shardJobs[slug]}` };
    this.shardJobs = { ...(this.shardJobs || {}), [slug]: action };
    this.progress(`${name}: ${action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : action === 'crash' ? `crash test: ${server}` : 'restarting'} (tools/shards.sh ${sub} ${name})`);
    try {
      const args = [sub, name, ...(action === 'start' && atlas ? ['--atlas'] : []), ...(action === 'crash' ? [server] : [])];
      const r = await runLive(path.join(repo, 'tools', 'shards.sh'), args, {
        env: { ...process.env, PATH, NO_COLOR: '1' }, file: path.join(local, `shards-${slug}.out`),
        onLine: (l) => l.trim() && this.progress(l.trim(), /fail|couldn|No |isn't/i.test(l) ? 'warn' : 'info') });
      this._podCache = null;
      if (r.code !== 0) return { ok: false, error: ((r.stderr || r.stdout || '').trim().split('\n').pop()) || `tools/shards.sh ${sub} failed` };
      this.progress(`${name}: ${action === 'stop' ? 'stopped' : action === 'crash' ? `crash test done (${server} came back)` : 'starting; its servers come up over a minute or two'}`, 'ok');
      return { ok: true };
    } finally {
      delete this.shardJobs[slug];
    }
  }

  // One of their logs: a server's (DBServer, Launcher, or a map server), or the container's own
  async extraShardLog({ name, server } = {}) {
    const i = SERVER_NAMES.indexOf(name);
    if (i < 1) return { ok: false, error: 'Which shard?' };
    const slug = name.toLowerCase();
    const sl = path.join(local, 'shards', slug, 'local');
    if (!server || server === 'container') {
      const pod = this.podmanCmd();
      if (!pod) return { ok: false, error: 'No podman here' };
      const text = await new Promise((resolve) => execFile(pod[0], [...pod.slice(1), 'logs', '--tail', '300', `incarnate-shard-${slug}`],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => resolve(`${out || ''}${errOut || ''}` || (err ? err.message : ''))));
      return { ok: true, text };
    }
    // Every log it has, the way the Logs tab's "All logs" does for this shard: the container's
    // own output, then the last lines of each server's (the Database Server and Launcher first,
    // then the rest by name), each line marked with whose it is
    if (server === 'all') {
      const tail = (file, lines) => {
        try {
          const st = fs.statSync(file);
          const start = Math.max(0, st.size - 64 * 1024);
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(st.size - start);
          fs.readSync(fd, buf, 0, buf.length, start);
          fs.closeSync(fd);
          return { text: buf.toString('utf8').split('\n').filter((l) => l.trim()).slice(-lines), mtime: st.mtimeMs };
        } catch { return null; }
      };
      const out = [];
      const c = await this.extraShardLog({ name, server: 'container' });
      out.push('==== the container ====', ...String(c.text || c.error || '').split('\n').filter((l) => l.trim()).slice(-120).map((l) => `container | ${l}`));
      let names = [];
      try { names = fs.readdirSync(path.join(sl, 'servers')).filter((f) => f.endsWith('.out')).map((f) => f.slice(0, -4)); } catch { /* none yet */ }
      const order = ['DBServer', 'Launcher', ...names.filter((n) => n !== 'DBServer' && n !== 'Launcher').sort()];
      for (const n of order) {
        const t = tail(/^(DBServer|Launcher)$/.test(n) ? path.join(sl, `${n}.out`) : path.join(sl, 'servers', `${n}.out`), 60);
        out.push('', `==== ${n}${t ? ` (last written ${new Date(t.mtime).toLocaleTimeString()})` : ': no log yet'} ====`);
        if (t) out.push(...t.text.map((l) => `${n} | ${l}`));
      }
      // The ones that ran before and aren't in the list: nothing to add. Crash reports are on their tab.
      return { ok: true, text: out.join('\n') };
    }
    // A full crash report (its logs/crashes)
    const cr = String(server).match(/^crash:([\w.-]{3,120}\.txt)$/);
    if (cr) {
      try { return { ok: true, text: fs.readFileSync(path.join(local, 'shards', slug, 'logs', 'crashes', cr[1]), 'utf8').slice(0, 512 * 1024) }; } catch { return { ok: false, error: 'That report is gone' }; }
    }
    if (!/^[A-Za-z0-9-]{2,40}$/.test(server)) return { ok: false, error: 'Which server?' };
    const file = /^(DBServer|Launcher)$/.test(server) ? path.join(sl, `${server}.out`) : path.join(sl, 'servers', `${server}.out`);
    try {
      const st = fs.statSync(file);
      const start = Math.max(0, st.size - 256 * 1024);
      const fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return { ok: true, text: buf.toString('utf8'), file };
    } catch {
      return { ok: false, error: `No log yet: ${path.relative(repo, file)}` };
    }
  }

  // ServerMonitor's shard buttons, through the DBServer's inbox (svrmoncomm.c): delink a map
  // server, Overload Protection on or back to automatic, reset the MissionServer link
  async serverAction({ action, arg } = {}) {
    if (action === 'delink') {
      const id = Math.round(+arg);
      if (!(id > 0)) return { ok: false, error: 'Which map?' };
      const r = await this.dbCommand('delink', String(id));
      if (r.ok) this.progress(`Map ${id}: the Database Server let go of its map server (Delink)`, 'warn');
      return r;
    }
    if (action === 'overload') {
      const on = !!arg;
      const r = await this.dbCommand('overload', on ? '1' : '0');
      if (r.ok) this.progress(on ? 'Overload Protection on: new logins wait in the queue, no new maps start' : 'Overload Protection back to automatic', on ? 'warn' : 'ok');
      return r;
    }
    if (action === 'mslinkreset') {
      const r = await this.dbCommand('mslinkreset', '');
      if (r.ok) this.progress('MissionServer link reset: the Database Server reconnects to it', 'ok');
      return r;
    }
    return { ok: false, error: `Unknown action: ${action}` };
  }

  // ---- Chat: ChatAdmin, through the ChatServer's inbox (shardnet.c, docs/CHAT_ADMIN.md) ----

  // One command to the ChatServer: a 0600 file renamed into a 0700 folder, its answer as JSON
  // in ChatServer.outbox. Shard Admin is the chat user ShardAdmin there.
  async chatCommand(cmd, rest = '') {
    if (!this.readyPid('ChatServer')) return { ok: false, error: 'The ChatServer isn\'t running' };
    fs.mkdirSync(chatInboxDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(chatInboxDir, 0o700);
    this.cmdSeq = (this.cmdSeq || 0) + 1;
    const base = `${Date.now()}-${String(this.cmdSeq).padStart(6, '0')}-${process.pid}`;
    const reply = `c${process.pid}-${this.cmdSeq}-${Date.now().toString(36)}`;
    const tmp = path.join(chatInboxDir, `${base}.tmp`);
    const file = path.join(chatInboxDir, `${base}.cmd`);
    const out = path.join(chatOutboxDir, `${reply}.json`);
    fs.writeFileSync(tmp, `${cmd} ${reply} ${rest}`.slice(0, 1090) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    for (let i = 0; i < 40; i++) {
      await sleep(i < 10 ? 100 : 250);
      let data = null;
      try { data = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* not yet */ }
      if (data) { try { fs.unlinkSync(out); } catch { /* gone */ } return { ...data, ok: !!data.ok }; }
    }
    try { fs.unlinkSync(file); } catch { /* it was read */ }
    return { ok: false, error: 'The ChatServer didn\'t answer. It needs this build: Build all, then Restart all.' };
  }

  async chatLogin() {
    const r = await this.chatCommand('login');
    if (r.ok) this.progress(`Chat: logged in as ${r.me}`, 'ok');
    return r;
  }

  chatLogout() { return this.chatCommand('logout'); }

  chatPoll(since) { return this.chatCommand('poll', String(Math.max(0, Math.round(+since || 0)))); }

  // One ChatAdmin command as ShardAdmin; the ChatServer only runs the ones on its list.
  // Each argument goes over quoted and escaped, the way the game sends them.
  async chatRun({ cmd, args } = {}) {
    if (!/^[A-Za-z]{2,24}$/.test(String(cmd || ''))) return { ok: false, error: 'Which command?' };
    const list = (Array.isArray(args) ? args : []).map((a) => `"${chatEscape(a)}"`);
    const line = [cmd, ...list].join(' ');
    if (line.length > 1000) return { ok: false, error: 'Too long' };
    const r = await this.chatCommand('run', line);
    if (r.ok === false && !r.error) r.error = (r.lines && r.lines.map(chatLineText).find(Boolean)) || `${cmd} failed`;
    return r;
  }

  // Staff sign-in (Shards view): the account and character the window acts as for Watch and
  // Bring. Kept where the shard runs, for this run of the app or service; the password is only
  // checked, never kept.
  staffAs() {
    const a = this.staffSession;
    return a ? { account: a.account, charId: a.charId || 0, charName: a.charName || '' } : null;
  }

  async staffSignIn({ account, password } = {}) {
    account = String(account || '').trim().toLowerCase();
    if (!/^[a-z0-9]{2,14}$/.test(account)) return { ok: false, error: 'Account names: 2 to 14 letters and numbers' };
    if (this.realAuth()) {
      password = String(password || '');
      if (!password) return { ok: false, error: 'The password, please' };
      const hash = authPasswordHash(account, password);
      const r = await this.sql(`SELECT COUNT(*) FROM user_auth WHERE account = '${account}' AND password = CONVERT(binary(128), '${hash}')`, 'cohauth');
      if (!r.ok) return r;
      if (!r.rows[0] || r.rows[0][0] !== '1') return { ok: false, error: 'Wrong account or password' };
    }
    const chars = await this.staffCharacters(account);
    if (!chars.ok) return chars;
    if (!chars.rows.length) return { ok: false, error: `@${account} has no characters yet: make one in the game first` };
    const staff = chars.rows.filter((c) => c.staff);
    if (!staff.length) return { ok: false, error: `None of @${account}'s characters has staff access (level 2 at least). Staff tab: give the account a level.` };
    const keep = this.staffSession && this.staffSession.account === account ? staff.find((c) => c.id === this.staffSession.charId) : null;
    const pick = keep || staff[0];
    this.staffSession = { account, charId: pick.id, charName: pick.name, at: Date.now() };
    this.progress(`Logged in as @${account}, acting as ${pick.name}`, 'ok');
    return { ok: true, staffAs: this.staffAs(), characters: chars.rows };
  }

  staffSignOut() { this.staffSession = null; return { ok: true }; }

  async staffCharacters(account) {
    account = String(account || (this.staffSession && this.staffSession.account) || '').toLowerCase();
    if (!/^[a-z0-9]{2,14}$/.test(account)) return { ok: false, error: 'Log in first (Login for Controls)' };
    const r = await this.sql(`SELECT ContainerId, Name, ISNULL(AccessLevel,0), ISNULL(AccountAccessLevel,0), ISNULL(Level,0)+1 FROM dbo.Ents WHERE LOWER(AuthName) = '${account}' ORDER BY Name`);
    if (!r.ok) return r;
    const online = new Set(((this.lastOverview && this.lastOverview.players) || []).map((p) => p.id));
    return { ok: true, rows: r.rows.map(([id, name, access, accountAccess, level]) => ({ id: +id, name, access: +access,
      accountAccess: +accountAccess, level: +level, staff: Math.max(+access, +accountAccess) >= 2, online: online.has(+id) })) };
  }

  async staffPick({ id } = {}) {
    if (!this.staffSession) return { ok: false, error: 'Log in first (Login for Controls)' };
    const chars = await this.staffCharacters();
    if (!chars.ok) return chars;
    const c = chars.rows.find((x) => x.id === Math.round(+id));
    if (!c) return { ok: false, error: 'Not one of this account\'s characters' };
    if (!c.staff) return { ok: false, error: `${c.name} isn't staff (access level 2 at least)` };
    Object.assign(this.staffSession, { charId: c.id, charName: c.name });
    return { ok: true, staffAs: this.staffAs() };
  }

  // Zones to send a player to (the game's mapmove list)
  zones() {
    zoneName(0);
    const seen = new Set();
    const list = [];
    for (const [id, name] of Object.entries(zoneNames)) if (!seen.has(name)) { seen.add(name); list.push({ id: +id, name }); }
    return { ok: true, zones: list.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  async playerAction({ id, action, arg } = {}) {
    const ov = await this.overview().then(() => this.lastOverview);
    if (!ov) return { ok: false, error: 'The shard isn\'t running' };
    const p = ov.players.find((x) => x.id === Math.round(+id));
    if (!p) return { ok: false, error: 'That player isn\'t online anymore' };
    if (/["\n\r]/.test(p.name)) return { ok: false, error: 'That name can\'t be sent safely' };
    const say = (t) => this.progress(t, 'ok');
    const run = (who, cmd) => this.dbCommand('player', `${who} ${cmd}`);
    // Done by the DBServer or here, so they work while the player is still loading
    if (action === 'logout') {
      const r = await this.dbCommand('logout', String(p.id));
      if (r.ok) say(`Logging ${p.name} out. Logging back in puts them in ${p.zone || 'their zone'} when the map they were going to is gone.`);
      return r;
    }
    if (action === 'stopMap') {
      const procs = await this.listProcesses();
      const map = procs.find((x) => x.name === 'MapServer' && (x.args.match(/-map_id\s+(\d+)/i) || [])[1] === String(p.map));
      if (!map) return { ok: false, error: `No map server for map ${p.map} running here` };
      await this.killPids([map.pid]);
      say(`Stopped map ${p.map} (the map ${p.name} was loading into)`);
      return { ok: true };
    }
    if (p.loading) return { ok: false, error: `${p.name} is still loading into map ${p.map}: Log out, or Stop the map` };
    if (action === 'watch' || action === 'bring') {
      // As the signed-in staff character: invisible, then to them (goto follows them into
      // missions too), or them to it
      const s = this.staffSession;
      if (!s || !s.charId) return { ok: false, error: 'Log in with a staff account first (Shards view, Login for Controls)' };
      const me = ov.players.find((x) => x.id === s.charId && !x.loading);
      if (!me) return { ok: false, offline: true, charName: s.charName, account: s.account,
        error: `${s.charName} isn't in the game. Log in with it (Start client), then try again.` };
      if (Math.max(me.access, me.accountAccess) < 2) return { ok: false, error: `${me.name} isn't staff (access level 2 at least)` };
      if (me.id === p.id) return { ok: false, error: 'That\'s your own character' };
      if (action === 'bring') {
        const r = await run(me.id, `teleport ${p.name}`);
        if (r.ok) say(`Bringing ${p.name} to ${me.name}`);
        return r;
      }
      for (const c of ['invisible 1', 'untargetable 1', 'invincible 1']) {
        const r = await run(me.id, c);
        if (!r.ok) return r;
      }
      const r = await run(me.id, `goto ${p.name}`);
      if (r.ok) say(`${me.name} is invisible and on the way to ${p.name}. Ghost Mode in the Staff Panel to fly; Invisible off there when done.`);
      return r;
    }
    if (action === 'toPlayer') {
      const other = ov.players.find((x) => x.id === Math.round(+arg) && !x.loading);
      if (!other || other.id === p.id) return { ok: false, error: 'Pick another player who is online' };
      if (/["\n\r]/.test(other.name)) return { ok: false, error: 'That name can\'t be sent safely' };
      const r = await run(p.id, `goto ${other.name}`);
      if (r.ok) say(`Sending ${p.name} to ${other.name}`);
      return r;
    }
    if (action === 'toMap') {
      const mapId = Math.round(+arg);
      if (!(mapId > 0) || !zoneName(mapId)) return { ok: false, error: 'Pick a zone from the list' };
      const r = await run(p.id, `mapmove ${mapId}`);
      if (r.ok) say(`Sending ${p.name} to ${zoneName(mapId)}`);
      return r;
    }
    const a = PLAYER_ACTIONS[action];
    if (!a) return { ok: false, error: `No such action: ${action}` };
    const cmd = a.cmd(p, arg);
    if (!cmd) return { ok: false, error: `${p.name} has no zone to go back to` };
    const r = await run(p.id, cmd);
    if (r.ok) say(`${a.label}: ${p.name}`);
    if (r.ok && action === 'kick') {
      // svrkick runs on their map. A map that doesn't (hung, busy loading) gets the DBServer's
      // own logout a few seconds later.
      setTimeout(async () => {
        await this.overview();
        const still = this.lastOverview && this.lastOverview.players.some((x) => x.id === p.id);
        if (still) { await this.dbCommand('logout', String(p.id)); this.progress(`${p.name} was still on: logged out by the Database Server`, 'warn'); }
      }, 6000);
    }
    return r;
  }

  schedules() {
    return { schedules: this.settings.schedules || [], plannedRestart: this.settings.plannedRestart || null,
      history: this.settings.messageHistory || [], restartMessage: this.settings.restartMessage || DEFAULT_RESTART_MESSAGE,
      now: Date.now() };
  }

  // { id?, kind: 'message' | 'restart', text, at (ms), every (minutes, 0: once), warn (minutes
  // before a restart), enabled }
  saveSchedule(item) {
    const kind = item.kind === 'restart' ? 'restart' : 'message';
    const text = cleanMessage(item.text);
    if (kind === 'message' && !text) return { ok: false, error: 'Write the message first' };
    const at = Math.round(+item.at);
    if (!Number.isFinite(at) || at < Date.now() - 60000) return { ok: false, error: 'Pick a time that hasn\'t passed' };
    const every = Math.max(0, Math.min(60 * 24 * 31, Math.round(+item.every || 0)));
    if (every && every < 5) return { ok: false, error: 'Repeat every 5 minutes at the least' };
    const warn = kind === 'restart' ? Math.max(0, Math.min(60, Math.round(+item.warn || 0))) : 0;
    if (kind === 'restart' && every && every < warn + 5) return { ok: false, error: 'Restarts repeat less often than their warning' };
    const list = [...(this.settings.schedules || [])];
    const id = item.id || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const entry = { id, kind, text, at, every, warn, enabled: item.enabled !== false };
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) list[i] = entry; else list.push(entry);
    this.setSettings({ schedules: list });
    return { ok: true, schedule: entry };
  }

  deleteSchedule(id) {
    this.setSettings({ schedules: (this.settings.schedules || []).filter((x) => x.id !== id) });
    const p = this.settings.plannedRestart;
    if (p && p.scheduleId === id) return this.cancelRestart();
    return { ok: true };
  }

  // Runs every few seconds where the shard is (this app, or backend.js serve on the machine,
  // which keeps running with the window closed)
  startScheduler() {
    if (this.schedulerTimer) return;
    this.schedulerTimer = setInterval(() => { this.schedulerTick().catch((e) => this.progress(`Schedule: ${e.message}`, 'error')); }, 5000);
    if (this.schedulerTimer.unref) this.schedulerTimer.unref();
  }

  async schedulerTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      let list = this.settings.schedules || [];
      let changed = false;
      for (const s of list) {
        if (!s.enabled) continue;
        const startAt = s.kind === 'restart' ? s.at - s.warn * 60000 : s.at;
        if (now < startAt) continue;
        const late = now - s.at > SCHEDULE_LATE_MS || (s.kind === 'restart' && now > s.at);
        if (late) {
          this.progress(`Skipped "${s.text || 'restart'}": it was due at ${new Date(s.at).toLocaleString()}, while this wasn't running`, 'warn');
        } else if (s.kind === 'message') {
          if (this.readyPid('DBServer')) await this.broadcast(s.text);
        } else if (!this.settings.plannedRestart) {
          this.planRestart(s.at, s.text, s.id);
        }
        Object.assign(s, nextRun(s, now));
        changed = true;
      }
      if (changed) { list = list.filter((s) => s.enabled || s.every); this.setSettings({ schedules: list }); }

      let p = this.settings.plannedRestart;
      if (p && now - p.at > SCHEDULE_LATE_MS) {
        // Due long ago, while this wasn't running: restarting a shard out of the blue is worse
        this.setSettings({ plannedRestart: null });
        this.progress(`Dropped the restart planned for ${new Date(p.at).toLocaleString()}: it came due while this wasn't running`, 'warn');
        p = null;
      }
      if (p) {
        const left = p.at - now;
        // The warnings that are due and not sent (one message for any that came due together)
        const due = RESTART_WARNINGS.filter((m) => left <= m * 60000 + 2500 && !p.warned.includes(m));
        if (due.length && left > 30000 && this.readyPid('DBServer')) {
          const m = Math.max(1, Math.round(left / 60000));
          await this.broadcast(`Server restart in ${m} minute${m === 1 ? '' : 's'}.${p.message ? ` ${p.message}` : ''}`);
          this.setSettings({ plannedRestart: { ...p, warned: [...p.warned, ...due] } });
        }
        if (left <= 0 && !this.busy && !this.restarting) {
          this.setSettings({ plannedRestart: null });
          this.progress('Planned restart: now');
          this.restartAll({ message: p.message ? `The server is restarting now. ${p.message}` : null })
            .catch((e) => this.alert('DBServer', 'Planned restart failed', e.message));
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // One server. The DBServer and the Launcher restart the whole shard (everything depends
  // on them); the Launcher alone restarts with its children. Any other server is stopped and
  // the DBServer starts it again on its own (it checks every 30 to 60 seconds).
  // Restart only what runs an older build than the one on disk, without touching the rest
  // of the shard. Other servers and the map servers are stopped and the DBServer starts
  // them again (maps when a player needs one; players on them go back to the login
  // screen). The DBServer and the Launcher need Restart all, so they are only reported.
  async restartUpdated() {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    const st = await this.status();
    const core = st.servers.filter((s) => s.restartNeeded && (s.name === 'DBServer' || s.name === 'Launcher'));
    const services = st.servers.filter((s) => s.restartNeeded && s.kind === 'service');
    const extras = st.extras.filter((e) => e.restartNeeded);
    if (!services.length && !extras.length) {
      this.progress(core.length ? `Only ${core.map((s) => s.name).join(' and ')} run an older build: that needs Restart all`
        : 'Every running server is on its latest build', core.length ? 'warn' : 'ok');
      return { ok: true };
    }
    this.busy = 'restarting';
    try {
      const names = [...services.map((s) => s.name), ...extras.map((e) => e.name)];
      this.progress(`Restarting on the new build: ${names.join(', ')}`);
      await this.killPids([...services.map((s) => s.pid), ...extras.map((e) => e.pid)].filter(Boolean));
      for (const s of services) { try { fs.unlinkSync(path.join(readyDir, `${s.name}.ready`)); } catch { /* gone */ } }
      this.progress(`Stopped ${names.length}; the Database Server starts them again within a minute`, 'ok');
      if (core.length) this.progress(`${core.map((s) => s.name).join(' and ')} also changed: Restart all to run the new build`, 'warn');
      return { ok: true, restarted: names };
    } finally {
      this.busy = null;
    }
  }

  async restart(name) {
    if (name === 'DBServer') return this.restartAll();
    const procs = await this.listProcesses();
    if (name === 'Launcher') {
      this.progress('Restarting the Launcher and everything it started');
      const kids = procs.filter((p) => p.name !== 'DBServer' && p.name !== 'AuthServer'); // not the Launcher's
      await this.killPids(kids.map((p) => p.pid));
      await sleep(1000);
      rotateLog(this.logFor('Launcher'));
      this.startWrapper('Launcher', this.shardEnv(this.applied || this.settings.toggles));
      this.progress('Launcher started again', 'ok');
      return { ok: true };
    }
    if (name === 'AuthServer') {
      // Not one the DBServer starts: stop it and start it here. Players already in stay in;
      // new logins wait for it (a few seconds)
      this.progress('Restarting the AuthServer');
      await this.killPids(procs.filter((p) => p.name === 'AuthServer').map((p) => p.pid));
      try { fs.unlinkSync(path.join(readyDir, 'AuthServer.ready')); } catch { /* gone */ }
      return this.startAuthServer(this.shardEnv(this.applied || this.settings.toggles), () => false);
    }
    const pids = procs.filter((p) => p.name === name).map((p) => p.pid);
    if (!pids.length) {
      this.progress(`${name} isn't running; the Database Server starts it within a minute`, 'warn');
      return { ok: true };
    }
    this.progress(`Restarting ${name}: stopped, the Database Server starts it again within a minute`);
    await this.killPids(pids);
    try { fs.unlinkSync(path.join(readyDir, `${name}.ready`)); } catch { /* gone */ }
    return { ok: true };
  }

  // A map server or beacon process by pid: the DBServer starts maps again when a player needs one
  async stopPid(pid) {
    await this.killPids([pid]);
    return { ok: true };
  }

  // ---- Builds ----

  async configure() {
    const dir = this.buildDir();
    // The code needs clang (-fms-extensions, its flags): the same compilers as tools/remote-shard.sh
    // and BUILD.md use. A folder set up with another compiler (cmake's default is gcc on
    // Linux) can't switch in place, so its cache goes first.
    const cache = readText(path.join(dir, 'CMakeCache.txt')) || '';
    const cc = (cache.match(/^CMAKE_C_COMPILER:\w+=(.*)$/m) || [])[1] || '';
    if (cache && !/clang/i.test(cc)) {
      this.progress(`${path.relative(repo, dir)} was set up with ${cc || 'another compiler'}, not clang: setting it up again`, 'warn');
      try { fs.rmSync(path.join(dir, 'CMakeCache.txt'), { force: true }); fs.rmSync(path.join(dir, 'CMakeFiles'), { recursive: true, force: true }); } catch { /* fine */ }
    }
    // Where ODBC is, from the regular build (tools/run-server.sh does the same)
    const odbc = [];
    const native = readText(path.join(repo, this.settings.buildDir || 'build-native', 'CMakeCache.txt')) || '';
    for (const v of ['ODBC_INCLUDE_DIR', 'ODBC_LIBRARY']) {
      const m = native.match(new RegExp(`^${v}:\\w+=(.+)$`, 'm'));
      if (m && dir !== path.join(repo, this.settings.buildDir || 'build-native')) odbc.push(`-D${v}=${m[1]}`);
    }
    this.progress(`Configuring ${path.relative(repo, dir)}`);
    return this.streamCommand('cmake', ['-S', repo, '-B', dir, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=RelWithDebInfo',
      '-DCMAKE_C_COMPILER=clang', '-DCMAKE_CXX_COMPILER=clang++', ...odbc,
      ...(this.settings.toggles.debug ? ['-DINCARNATE_BUILD_SERVERS=ON', '-DINCARNATE_SANITIZE=ON'] : [])]);
  }

  // A build folder set up with a compiler other than clang: set up again before building
  compilerWrong() {
    const cache = readText(path.join(this.buildDir(), 'CMakeCache.txt')) || '';
    const cc = (cache.match(/^CMAKE_C_COMPILER:\w+=(.*)$/m) || [])[1] || '';
    return !!cache && !/clang/i.test(cc);
  }

  async build(targets) {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    this.busy = 'building';
    try {
      if (!fs.existsSync(path.join(this.buildDir(), 'build.ninja')) || this.compilerWrong()) {
        const c = await this.configure();
        if (!c.ok) return c;
      }
      const list = targets && targets.length ? targets : ALL_TARGETS;
      this.progress(`Building ${targets && targets.length ? list.join(', ') : 'every server'}`);
      const r = await this.streamCommand('cmake', ['--build', this.buildDir(), '--target', ...list]);
      if (r.ok) this.progress('Build finished', 'ok');
      else {
        this.progress('Build failed. See the build log.', 'error');
        const first = (r.output.match(/^.*error:.*$/m) || [''])[0];
        this.alert('build', 'Build failed', first.slice(0, 300));
      }
      await this.checkOutdated();
      return r;
    } finally {
      this.busy = null;
    }
  }

  // The game client: the Windows build (build-mingw, cross-compiled with llvm-mingw), then
  // staged into build-mingw/dist (tools/stage-client.sh), where Start client and the launcher
  // run it. Build all is the servers only (build-native), so it never picked up client changes.
  async buildClient() {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    const dir = path.join(repo, 'build-mingw');
    if (!fs.existsSync(path.join(dir, 'build.ninja'))) {
      this.progress('No client build yet: configure build-mingw first (docs/BUILD.md)', 'error');
      return { ok: false, error: 'build-mingw is not configured' };
    }
    this.busy = 'building';
    try {
      // Only the client target (game, which writes Ouroboros.exe): build-mingw has the server
      // targets too, and their StructParser steps run on every build even with nothing to do
      this.progress('Building the client (build-mingw, target game)');
      const r = await this.streamCommand('cmake', ['--build', dir, '--target', 'game']);
      if (!r.ok) {
        this.progress('Client build failed. See the build log.', 'error');
        this.alert('build', 'Client build failed', ((r.output.match(/^.*error:.*$/m) || [''])[0]).slice(0, 300));
        return r;
      }
      this.progress('Staging the client into build-mingw/dist');
      const st = await this.streamCommand('bash', [path.join(repo, 'tools', 'stage-client.sh')], true);
      if (st.ok) this.progress('Client built and staged: restart the game to use it', 'ok');
      else this.progress('Staging the client failed. See the build log.', 'error');
      return st;
    } finally {
      this.busy = null;
    }
  }

  // Build only what has changes: the programs ninja would relink
  async buildChanged() {
    await this.checkOutdated();
    const names = Object.keys(this.outdated).filter((k) => this.outdated[k]);
    if (!names.length) { this.progress('Nothing to build: every server is up to date', 'ok'); return { ok: true }; }
    return this.build([...new Set(names.map(targetFor))]);
  }

  streamCommand(cmd, args, append = false) {
    return new Promise((resolve) => {
      const logFile = this.logFor('build');
      fs.mkdirSync(local, { recursive: true });
      const out = fs.createWriteStream(logFile, { flags: append ? 'a' : 'w' });
      let output = '';
      const child = spawn(cmd, args, { cwd: repo, env: { ...process.env, PATH } });
      const onData = (d) => { const s = String(d); output += s; out.write(s); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (e) => { onData(`\n${cmd}: ${e.message}\n`); });
      child.on('close', (code) => { out.end(); resolve({ ok: code === 0, code, output: output.slice(-200000) }); });
    });
  }

  // Which servers have changes to build. A dry run (ninja -n) can't tell: steps that
  // always run (the build revision, StructParser) make every program look out of date.
  // ninja's explain output names the objects whose own source or header really changed;
  // each object belongs to a target, and a library's change reaches what links it.
  async checkOutdated() {
    const dir = this.buildDir();
    if (!fs.existsSync(path.join(dir, 'build.ninja'))) { this.outdated = {}; return this.outdated; }
    const r = await run('ninja', ['-C', dir, '-d', 'explain', '-n', ...ALL_TARGETS]);
    const text = r.stdout + r.stderr;
    const changed = new Set();
    for (const m of text.matchAll(/output CMakeFiles\/([\w.-]+)\.dir\/\S+ older than most recent input (\S+)/g)) {
      const input = m[2];
      if (input.startsWith(dir) || /[\\/]AutoGen[\\/]|[\\/]autogen[\\/]/.test(input)) continue; // generated
      changed.add(m[1]);
    }
    const outdated = {};
    const programs = { dbserver: ['DBServer', 'LogServer'], launcher: ['Launcher'], mapserver: ['MapServer'],
      chatserver: ['ChatServer'], queueserver: ['QueueServer'], turnstileserver: ['TurnstileServer'],
      missionserver: ['MissionServer'], statserver: ['StatServer'], raidserver: ['RaidServer'],
      arenaserver: ['ArenaServer'], auctionserver: ['AuctionServer'], accountserver: ['AccountServer'] };
    const libUsers = { serverlib: ['queueserver', 'turnstileserver', 'missionserver'], ailib: ['mapserver'],
      lua: ['mapserver'], yajl: ['accountserver'] };
    for (const t of changed) {
      const targets = programs[t] ? [t] : (libUsers[t] || Object.keys(programs)); // utilitieslib, the POSIX layer, zlib...
      for (const x of targets) for (const name of programs[x]) outdated[name] = true;
    }
    // Never built: needs a build too
    for (const [t, names] of Object.entries(programs))
      for (const name of names) if (!fs.existsSync(path.join(dir, 'bin', name))) outdated[name] = true;
    const before = JSON.stringify(this.outdated);
    this.outdated = outdated;
    this.outdatedChecked = Date.now();
    const names = Object.keys(outdated);
    if (names.length && JSON.stringify(outdated) !== before)
      this.alert('build', 'Updates to build', `${names.join(', ')} changed since the last build.`, 'info');
    return outdated;
  }

  // ---- Config files ----

  readServersCfg() {
    const file = path.join(cfgDir, 'servers.cfg');
    const text = readText(file) || '';
    const values = {};
    for (const f of CFG_FIELDS) {
      const m = text.match(new RegExp(`^\\s*${f.key}\\s+(.*?)\\s*$`, 'mi'));
      values[f.key] = m ? m[1].replace(/^"(.*)"$/, '$1') : '';
    }
    const staff = [...text.matchAll(/^\s*StaffAccount\s+"?([^"\s]+)"?\s+(\d+)/gim)].map((m) => ({ account: m[1], level: +m[2] }));
    values.StaffFakeAuthFrom = [...text.matchAll(/^\s*StaffFakeAuthFrom\s+(\S+)/gim)].map((m) => m[1]).join(', ');
    const list = readText(path.join(binRoot, 'ServerListConfig.txt')) || '';
    const lm = list.match(/Shard\s+"([^"]*)"\s*\{\s*IP\s+(\S+)/);
    const fields = CFG_FIELDS.map((f) => ({ ...f, check: f.check ? f.check.source : null }));
    return { fields, values, staff, serverList: lm ? { name: lm[1], ip: lm[2] } : null, grants: this.readGrants(),
      network: networkInfo() };
  }

  writeServersCfg(values) {
    const file = path.join(cfgDir, 'servers.cfg');
    let text = readText(file) || '';
    for (const f of CFG_FIELDS) {
      if (!(f.key in values)) continue;
      const v = String(values[f.key]).trim();
      if (f.check && v && !f.check.test(v)) throw new Error(`${f.title}: "${v}" doesn't look right (${f.hint})`);
      const re = new RegExp(`^(\\s*)${f.key}\\s+.*$`, 'mi');
      const line = `${f.key} ${f.quote ? `"${v}"` : v}`;
      if (re.test(text)) text = text.replace(re, (_, sp) => sp + line);
      else if (v) text = text.replace(/\s*$/, `\n${line}\n`);
    }
    // Staff logins under fake auth from other computers: one StaffFakeAuthFrom line each
    if ('StaffFakeAuthFrom' in values) {
      const nets = String(values.StaffFakeAuthFrom).split(/[\s,]+/).filter(Boolean);
      for (const n of nets) if (!CIDR_RE.test(n)) throw new Error(`Staff logins from: "${n}" isn't an address or address/8 to /32`);
      if (nets.length > 8) throw new Error('Staff logins from: 8 at most');
      const lines = nets.map((n) => `StaffFakeAuthFrom ${n}`).join('\n');
      const all = /^[ \t]*StaffFakeAuthFrom[ \t]+.*$\n?/gim;
      const first = text.search(/^[ \t]*StaffFakeAuthFrom[ \t]/im);
      if (first >= 0) text = text.slice(0, first) + (lines ? `${lines}\n` : '') + text.slice(first).replace(all, '');
      else if (lines) {
        // under the StaffAccount lines when there are some
        const last = [...text.matchAll(/^\s*\/?\/?\s*Staff(Account|AllowRemoteFakeAuth|FakeAuthFrom)\b.*$/gim)].pop();
        if (last) { const at = last.index + last[0].length; text = `${text.slice(0, at)}\n${lines}${text.slice(at)}`; }
        else text = text.replace(/\s*$/, `\n${lines}\n`);
      }
    }
    fs.writeFileSync(file, text);
    return this.readServersCfg();
  }

  // AccountServer: which store items every account gets (account_server.cfg)
  //   list: the SKUs in default_sku.cfg (the shipped setting)
  //   all:  the list, then one of every other item in the store catalog (every archetype and
  //         power set)
  readGrants() {
    const text = readText(path.join(cfgDir, 'account_server.cfg')) || '';
    const on = (k) => new RegExp(`^\\s*${k}\\s*$`, 'mi').test(text);
    return on('GrantAllSKU') ? 'all' : on('GrantSKUFromList') ? 'list' : 'none';
  }

  writeGrants(mode) {
    const file = path.join(cfgDir, 'account_server.cfg');
    let text = readText(file) || '';
    const set = (k, enabled) => {
      const re = new RegExp(`^\\s*(//)?\\s*${k}\\s*$`, 'mi');
      const line = `${enabled ? '' : '//'}${k}`;
      text = re.test(text) ? text.replace(re, line) : text.replace(/\s*$/, `\n${line}\n`);
    };
    set('GrantSKUFromList', mode === 'list' || mode === 'all'); // all: the list's amounts too (character slots)
    set('GrantAllSKU', mode === 'all');
    fs.writeFileSync(file, text);
    return this.readGrants();
  }

  writeServerList(name, ip) {
    const file = path.join(binRoot, 'ServerListConfig.txt');
    if (!/^[\w .-]{1,64}$/.test(name)) throw new Error('Server list name: letters, numbers, spaces, . _ -');
    if (!IP_RE.test(ip) && !HOST_RE.test(ip)) throw new Error('Server list IP: an IPv4 address or host name');
    fs.writeFileSync(file, `Shard "${name}"\n{\n\tIP ${ip}\n}\n`);
    return this.readServersCfg();
  }

  setStaff(account, level) {
    if (!/^[\w.-]{1,32}$/.test(account)) throw new Error('Account names: letters, numbers, _ . -');
    level = Math.max(0, Math.min(11, parseInt(level, 10) || 0));
    const file = path.join(cfgDir, 'servers.cfg');
    let text = readText(file) || '';
    const re = new RegExp(`^\\s*StaffAccount\\s+"?${account.replace(/[.]/g, '\\.')}"?\\s+\\d+\\s*$\\n?`, 'mi');
    if (level === 0) text = text.replace(re, '');
    else if (re.test(text)) text = text.replace(re, `StaffAccount ${account} ${level}\n`);
    else {
      // next to the other StaffAccount lines when there are some
      const last = [...text.matchAll(/^\s*StaffAccount\s+.*$/gim)].pop();
      if (last) { const at = last.index + last[0].length; text = `${text.slice(0, at)}\nStaffAccount ${account} ${level}${text.slice(at)}`; }
      else text = text.replace(/\s*$/, `\nStaffAccount ${account} ${level}\n`);
    }
    fs.writeFileSync(file, text);
    return this.readServersCfg();
  }

  // ---- The database: characters and their access levels ----

  async sql(query, database = 'cohdb', { header = false } = {}) {
    const pw = ((readText(path.join(local, 'db.env')) || '').match(/MSSQL_SA_PASSWORD=(\S+)/) || [])[1];
    if (!pw) return { ok: false, error: 'No .local/db.env yet (tools/db-up.sh makes it)' };
    for (const tool of ['/opt/mssql-tools18/bin/sqlcmd', '/opt/mssql-tools/bin/sqlcmd']) {
      const r = await dockerRun(['exec', '-e', `SQLCMDPASSWORD=${pw}`, 'incarnate-mssql', tool, '-C', '-S', 'localhost',
        '-U', 'sa', '-d', database, '-b', '-W', '-s', '\t', ...(header ? [] : ['-h', '-1']), '-Q', `SET NOCOUNT ON; ${query}`]);
      if (/no such file|executable file not found/i.test(r.stderr + r.stdout)) continue;
      if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || 'sqlcmd failed' };
      const rows = r.stdout.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim()).map((l) => l.split('\t'));
      return { ok: true, rows };
    }
    return { ok: false, error: 'sqlcmd not found in the SQL Server container' };
  }

  async characters({ search = '', minLevel = 1 } = {}) {
    const lvl = Math.max(0, Math.min(11, parseInt(minLevel, 10) || 0));
    const s = String(search).replace(/[^\w .'-]/g, '').replace(/'/g, "''").slice(0, 64);
    const like = s ? `AND (Name LIKE '%${s}%' OR AuthName LIKE '%${s}%')` : '';
    const r = await this.sql(`SELECT TOP 500 ContainerId, AuthName, Name, ISNULL(AccessLevel,0), ISNULL(AccountAccessLevel,0), ISNULL(Level,0)+1, CONVERT(varchar(19), LastActive, 120) FROM dbo.Ents WHERE (ISNULL(AccessLevel,0) >= ${lvl} OR ISNULL(AccountAccessLevel,0) >= ${lvl}) ${like} ORDER BY AccessLevel DESC, LastActive DESC`);
    if (!r.ok) return r;
    return { ok: true, rows: r.rows.map(([id, account, name, access, accountAccess, level, last]) => ({
      id: +id, account, name, access: +access, accountAccess: +accountAccess, level: +level, last })) };
  }

  // The DBServer keeps characters in memory and writes them back, so a change made in SQL
  // while it runs would be overwritten. Only while it is stopped.
  async setCharacterAccess(id, level) {
    const procs = await this.listProcesses();
    if (procs.some((p) => p.name === 'DBServer'))
      return { ok: false, error: 'Stop the shard first: the Database Server would write its own copy back over the change.' };
    const lvl = Math.max(0, Math.min(11, parseInt(level, 10) || 0));
    const r = await this.sql(`UPDATE dbo.Ents SET AccessLevel = ${lvl} WHERE ContainerId = ${parseInt(id, 10) || 0}`);
    return r.ok ? { ok: true } : r;
  }

  // A full backup of every game database, copied out of the container to .local/backups
  async backup() {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    this.busy = 'backing up';
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const dir = path.join(local, 'backups', stamp);
      fs.mkdirSync(dir, { recursive: true });
      const r0 = await this.sql("SELECT name FROM sys.databases WHERE name LIKE 'coh%'");
      if (!r0.ok) return r0;
      const dbs = r0.rows.map((r) => r[0]).filter((n) => /^coh\w*$/.test(n));
      for (const db of dbs) {
        this.progress(`Backing up ${db}`);
        const file = `/var/opt/mssql/backup-${db}.bak`;
        const r = await this.sql(`BACKUP DATABASE [${db}] TO DISK = N'${file}' WITH INIT, COPY_ONLY`);
        if (!r.ok) { this.progress(`Backup of ${db} failed: ${r.error}`, 'error'); return r; }
        const c = await dockerRun(['cp', `incarnate-mssql:${file}`, path.join(dir, `${db}.bak`)]);
        if (c.code !== 0) { this.progress(`Copying ${db} out failed: ${c.stderr.trim()}`, 'error'); return { ok: false, error: c.stderr }; }
      }
      this.progress(`Backed up ${dbs.join(', ')} to ${path.relative(repo, dir)}`, 'ok');
      return { ok: true, dir, dbs };
    } finally {
      this.busy = null;
    }
  }

  // Restore a backup (a folder of <db>.bak from backup(), here or from another machine) over
  // the databases here. The shard must be stopped: the DBServer would write its own state back.
  async restore(dir) {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    if ((await this.listProcesses()).some((p) => p.name === 'DBServer')) {
      this.progress('Stop the shard first: the Database Server would write its own copy back over the restore', 'error');
      return { ok: false, error: 'shard running' };
    }
    const full = path.resolve(repo, dir || '');
    let files = [];
    try { files = fs.readdirSync(full).filter((f) => /^coh\w*\.bak$/.test(f)); } catch { /* none */ }
    if (!files.length) { this.progress(`No coh*.bak files in ${full}`, 'error'); return { ok: false, error: 'no backups' }; }
    this.busy = 'restoring';
    try {
      const [c, ...pre] = containerCmd();
      for (const f of files) {
        const db = f.replace(/\.bak$/, '');
        const inside = `/var/opt/mssql/restore-${db}.bak`;
        this.progress(`Restoring ${db}`);
        // Through stdin, so the copy belongs to SQL Server's own user in the container (docker cp
        // keeps the owner and mode, which SQL Server then can't read)
        const copied = await new Promise((resolve) => {
          const ch = spawn(c, [...pre, 'exec', '-i', 'incarnate-mssql', 'sh', '-c', `cat > ${inside}`], { env: { ...process.env, PATH } });
          fs.createReadStream(path.join(full, f)).pipe(ch.stdin);
          ch.on('close', (code) => resolve(code === 0));
          ch.on('error', () => resolve(false));
        });
        if (!copied) { this.progress(`Copying ${f} into the container failed`, 'error'); return { ok: false, error: 'copy' }; }
        const r = await this.sql(`IF DB_ID('${db}') IS NOT NULL ALTER DATABASE [${db}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
          RESTORE DATABASE [${db}] FROM DISK = N'${inside}' WITH REPLACE; ALTER DATABASE [${db}] SET MULTI_USER;`, 'master');
        if (!r.ok) { this.progress(`Restoring ${db} failed: ${r.error}`, 'error'); return r; }
      }
      this.progress(`Restored ${files.map((f) => f.replace(/\.bak$/, '')).join(', ')} from ${path.relative(repo, full)}`, 'ok');
      return { ok: true };
    } finally {
      this.busy = null;
    }
  }

  // ---- Real auth: the AuthServer and its accounts (docs/AUTH.md) ----

  // The AuthServer's database rows for this shard: the server list entry players pick (its
  // name and the address they connect to) and its status row. The DBServer connects from
  // this machine, so inner_ip is 127.0.0.1.
  async ensureAuthDb() {
    const cfg = this.readServersCfg().values;
    const name = (cfg.ShardName || 'Incarnate').replace(/[^\w .-]/g, '').slice(0, 25) || 'Incarnate';
    const ip = IP_RE.test(cfg.AdvertisedIp || '') ? cfg.AdvertisedIp : '127.0.0.1';
    const q = (v) => String(v).replace(/'/g, "''");
    return this.sql(`IF NOT EXISTS (SELECT 1 FROM server WHERE id = 1)
        INSERT INTO server (id, name, ip, inner_ip, ageLimit, pk_flag, server_group_id, client_port) VALUES (1, '${q(name)}', '${ip}', '127.0.0.1', 0, 0, 0, 7000)
      ELSE UPDATE server SET name = '${q(name)}', ip = '${ip}', inner_ip = '127.0.0.1', client_port = 7000 WHERE id = 1;
      IF NOT EXISTS (SELECT 1 FROM worldstatus WHERE idx = 1) INSERT INTO worldstatus (idx, status) VALUES (1, 0);`, 'cohauth');
  }

  async startAuthServer(env, cancelled) {
    const db = await this.ensureAuthDb();
    if (!db.ok) {
      this.progress(`The AuthServer's database isn't ready: ${db.error}. tools/db-up.sh makes cohauth.`, 'error');
      this.alert('AuthServer', 'No AuthServer database', db.error);
      return { ok: false, error: 'cohauth' };
    }
    if (!fs.existsSync(path.join(this.buildDir(), 'bin', 'AuthServer'))) {
      this.progress('No AuthServer build yet: Build all, then start again (or turn fake auth on)', 'error');
      return { ok: false, error: 'not built' };
    }
    this.progress('Starting the AuthServer');
    const log = this.logFor('AuthServer');
    try { fs.writeFileSync(log, ''); } catch { /* made by run-server.sh */ }
    this.resetTail('AuthServer');
    const child = this.startWrapper('AuthServer', env);
    const ok = await this.waitForText(log, /AuthServer ready/, 60 * 1000, () => child.exitCode !== null || cancelled());
    if (!ok) {
      const why = ((readText(log) || '').match(/^.*(Fatal Error|couldn't|invalid|failed).*$/im) || [''])[0];
      this.progress(`The AuthServer didn't start${why ? `: ${why.replace(/^[\d. :]+/, '')}` : ''}. See its log.`, 'error');
      return { ok: false, error: 'authserver' };
    }
    this.progress('AuthServer ready (logins on port 2106)', 'ok');
    return { ok: true };
  }

  // Accounts in the AuthServer's database. Passwords are stored the way the game client sends
  // them: SHA-512 of the password and an Adler-32 of the lowercased account name (hash_type 1,
  // what this AuthServer checks). The client limits passwords to 16 characters.
  async accounts() {
    const r = await this.sql(`SELECT a.account, a.uid, a.pay_stat, a.block_flag, CONVERT(varchar(19), a.last_login, 120),
      CASE WHEN u.account IS NULL THEN 0 ELSE 1 END FROM user_account a LEFT JOIN user_auth u ON u.account = a.account ORDER BY a.account`, 'cohauth');
    if (!r.ok) return r;
    // linked: its uid is the id fake auth gave that name, so its characters from fake auth show
    return { ok: true, rows: r.rows.map(([account, uid, payStat, block, last, hasPw]) => ({ account, uid: +uid, payStat: +payStat,
      blocked: +block !== 0, last: last === 'NULL' ? '' : last, hasPassword: hasPw === '1', linked: +uid === fakeAuthId(account) })) };
  }

  // relink: give an existing account the uid fake auth used for its name (its characters from
  // fake auth come with it). New accounts get that uid from the start when it's free.
  async setAccount({ account, password, create = false, blocked, relink = false } = {}) {
    account = String(account || '').trim();
    if (!/^[A-Za-z0-9]{2,14}$/.test(account)) throw new Error('Account names: 2 to 14 letters and numbers (what the game allows)');
    const lower = account.toLowerCase();
    if (password !== undefined) {
      password = String(password);
      if (password.length < 6 || password.length > 16) throw new Error('Passwords: 6 to 16 characters (the game sends at most 16)');
      if (/[^\x20-\x7e]/.test(password)) throw new Error('Passwords: plain letters, numbers and symbols (the game client is ASCII)');
    }
    const exists = await this.sql(`SELECT uid FROM user_account WHERE account = '${lower}'`, 'cohauth');
    if (!exists.ok) return exists;
    let uid = exists.rows[0] ? +exists.rows[0][0] : 0;
    if (!uid) {
      if (!create) throw new Error(`No account ${account}`);
      if (password === undefined) throw new Error('A new account needs a password');
      // pay_stat 1004: an active (VIP) plan with no time billing; queue_level 0. The uid is the
      // one fake auth gave this name (so its characters are this account's), else the next free.
      const fid = fakeAuthId(lower);
      const ins = await this.sql(`DECLARE @uid int = ${fid};
        IF EXISTS (SELECT 1 FROM user_account WHERE uid = @uid) OR EXISTS (SELECT 1 FROM user_data WHERE uid = @uid)
          SET @uid = (SELECT ISNULL(MAX(uid), 0) + 1 FROM user_account WHERE uid < 1000000000);
        INSERT INTO user_account (account, uid, pay_stat, login_flag, warn_flag, block_flag, block_flag2, subscription_flag, queue_level)
          VALUES ('${lower}', @uid, 1004, 0, 0, 0, 0, 0, 0);
        INSERT INTO user_info (account, ssn) VALUES ('${lower}', NULL);
        INSERT INTO user_data (uid, user_data, user_data_new, user_game_data, user_game_data_new) VALUES (@uid, 0x00, 0x00, 0x00, 0x00);
        SELECT @uid;`, 'cohauth');
      if (!ins.ok) return ins;
      uid = +(ins.rows.pop() || [0])[0];
      this.progress(`Account ${lower} made (uid ${uid})`, 'ok');
    }
    if (password !== undefined) {
      const hash = authPasswordHash(lower, password);
      const salt = authSalt(lower) | 0; // what the AuthServer itself stores when it upgrades a hash
      const r = await this.sql(`IF EXISTS (SELECT 1 FROM user_auth WHERE account = '${lower}')
          UPDATE user_auth SET password = CONVERT(binary(128), '${hash}'), salt = ${salt}, hash_type = 1 WHERE account = '${lower}'
        ELSE INSERT INTO user_auth (account, password, salt, hash_type) VALUES ('${lower}', CONVERT(binary(128), '${hash}'), ${salt}, 1);`, 'cohauth');
      if (!r.ok) return r;
      if (!create) this.progress(`Password changed for ${lower}`, 'ok');
    }
    if (relink) {
      const fid = fakeAuthId(lower);
      if (uid !== fid) {
        const r = await this.sql(`IF EXISTS (SELECT 1 FROM user_account WHERE uid = ${fid}) OR EXISTS (SELECT 1 FROM user_data WHERE uid = ${fid})
            THROW 50001, 'another account already has that uid', 1;
          BEGIN TRANSACTION;
          UPDATE user_account SET uid = ${fid} WHERE uid = ${uid};
          UPDATE user_data SET uid = ${fid} WHERE uid = ${uid};
          UPDATE user_server_group SET uid = ${fid} WHERE uid = ${uid};
          COMMIT;`, 'cohauth');
        if (!r.ok) return r;
        this.progress(`${lower}: uid ${uid} -> ${fid}, so its characters from fake auth are its own now (log in again)`, 'ok');
        uid = fid;
      }
    }
    if (blocked !== undefined) {
      const r = await this.sql(`UPDATE user_account SET block_flag = ${blocked ? 1 : 0} WHERE account = '${lower}'`, 'cohauth');
      if (!r.ok) return r;
      this.progress(`${lower} ${blocked ? 'blocked: it can\'t log in' : 'unblocked'}`, 'ok');
    }
    return this.accounts();
  }

  // Another server's backups into this shard's SQL Server (dbimport.js; tools/db-import.sh)
  async importDatabases(dir, opts = {}) {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    const { DbImport } = require('./dbimport');
    // The import needs the DBServer stopped (it would write its own copy back). stopShard: stop
    // it here, and start it again after, on the imported databases or, if the import stopped
    // early, on the untouched ones.
    let stopped = false;
    if (!opts.dryRun && opts.stopShard && (await this.listProcesses()).some((p) => p.name === 'DBServer')) {
      this.progress('Stopping the shard for the import');
      const s = await this.stop();
      if (s && s.ok === false) return s;
      stopped = true;
    }
    this.busy = 'importing';
    let r;
    try {
      r = await new DbImport(this, { repo, local, containerCmd, PATH }).run(dir, opts);
    } finally {
      this.busy = null;
    }
    if (stopped && !r.switchFailed) {
      this.progress(r.ok ? 'Starting the shard on the imported databases' : 'Starting the shard again (its databases are unchanged)');
      await this.start();
    } else if (stopped) {
      this.progress('The shard stays stopped: the switch failed partway (rollback first)', 'error');
    }
    return { ...r, ok: !!r.ok };
  }

  async importRollback(stamp) {
    if (this.busy) return { ok: false, error: `busy: ${this.busy}` };
    const { DbImport } = require('./dbimport');
    this.busy = 'importing';
    try { return await new DbImport(this, { repo, local, containerCmd, PATH }).rollback(stamp); } finally { this.busy = null; }
  }

  // The game client (tools/run-client.sh: CrossOver or Wine)
  // realAuth: log in through the AuthServer (-auth) instead of straight to the DBServer (-db)
  // loginFile: a one-time sign-in file in the client folder (Shard Admin's Spectate Player)
  startClient(realAuth = this.realAuth(), loginFile = '') {
    const env = { ...process.env, PATH, INCARNATE_CLIENT_AUTH: realAuth ? '1' : '0' };
    delete env.INCARNATE_LOGIN_FILE;
    if (loginFile) env.INCARNATE_LOGIN_FILE = loginFile;
    const child = spawn(path.join(repo, 'tools', 'run-client.sh'), [], { cwd: repo, env, stdio: 'ignore', detached: true });
    child.unref();
    this.progress(`Starting the client (tools/run-client.sh${realAuth ? ', real accounts through the AuthServer' : ''})`, 'ok');
    return { ok: true };
  }

  // ---- Tracker: docs/TESTING.md (things to test) and the To Do list in docs/CHANGES.md ----

  readTracker() {
    const parseItems = (text, startRe, checkbox) => {
      const lines = text.split('\n');
      const items = [];
      let on = !startRe;
      let section = '';
      lines.forEach((line, i) => {
        const h = line.match(/^##\s+(.*)/);
        if (h) { section = h[1].trim(); if (startRe) on = startRe.test(line); return; }
        if (!on) return;
        const m = checkbox ? line.match(/^- \[( |x)\] (.*)/i) : line.match(/^- (.*)/);
        const last = items[items.length - 1];
        if (m) items.push({ line: i, end: i, section, done: checkbox ? m[1].toLowerCase() === 'x' : false, text: checkbox ? m[2] : m[1] });
        else if (/^\s{2,}\S/.test(line) && last && last.end === i - 1) { last.text += ` ${line.trim()}`; last.end = i; }
      });
      return items;
    };
    const tests = parseItems(readText(path.join(repo, 'docs', 'TESTING.md')) || '', null, true);
    const todo = parseItems(readText(path.join(repo, 'docs', 'CHANGES.md')) || '', /^##\s+To Do/i, false);
    return { tests, todo };
  }

  // Tick or untick a test in docs/TESTING.md (the line it starts on)
  setTestDone(line, done) {
    const file = path.join(repo, 'docs', 'TESTING.md');
    const lines = (readText(file) || '').split('\n');
    if (!/^- \[( |x)\] /i.test(lines[line] || '')) throw new Error('That test moved; reload the list');
    lines[line] = lines[line].replace(/^- \[( |x)\] /i, done ? '- [x] ' : '- [ ] ');
    fs.writeFileSync(file, lines.join('\n'));
    return this.readTracker();
  }

  // The client's processes: Ouroboros.exe under CrossOver's wine, and run-client.sh around it
  async clientPids() {
    const ps = await run('ps', ['-axo', 'pid=,args=']);
    return ps.stdout.split('\n').map((l) => l.trim().match(/^(\d+)\s+(.*)$/)).filter(Boolean)
      .filter((m) => /Ouroboros\.exe/i.test(m[2]) || (/tools\/run-client\.sh/.test(m[2]) && m[2].includes(repo)))
      .map((m) => +m[1]).filter((pid) => pid !== process.pid);
  }

  async stopClient() {
    const pids = await this.clientPids();
    if (!pids.length) { this.progress('The client isn\'t running', 'warn'); return { ok: true }; }
    await this.killPids(pids, 4000);
    this.progress('Client stopped', 'ok');
    return { ok: true };
  }

  // A launcher manifest for this shard at an address other computers reach
  // (.local/incarnate-lan.xml; tools/remote-shard.sh manifest makes the one for a remote machine)
  writeManifest(ip) {
    if (!IP_RE.test(ip || '')) throw new Error('Manifest: an IPv4 address');
    const file = path.join(local, 'incarnate-lan.xml');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!-- The shard on this computer, for launchers on the network (Shard Admin, Settings). Add it in the launcher with "From file". -->
<manifest>
  <label>Incarnate (${ip})</label>
  <profiles>
    <launch exec="Ouroboros.exe" params="-db ${ip}" order="0">Incarnate</launch>
    <launch exec="Ouroboros.exe" params="-auth ${ip}" order="1">Incarnate (real accounts)</launch>
  </profiles>
  <filelist/>
  <incarnate status="http://${ip}:7099/status" signin="true"/>
</manifest>
`);
    this.progress(`Launcher manifest: ${file}`, 'ok');
    return { ok: true, file };
  }

  info() {
    return { repo, toggles: TOGGLES.map(({ on, off, ...t }) => t), clientOptimizations: CLIENT_OPTIMIZATIONS,
      settings: this.settings, platform: process.platform };
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch, toggles: { ...this.settings.toggles, ...(patch.toggles || {}) } };
    // Shared memory and the Debug build don't go together: the shared address is inside
    // AddressSanitizer's own memory, so a debug map server runs without sharing. The one just
    // turned on wins, and says what it turned off
    const t = this.settings.toggles;
    const pt = patch.toggles || {};
    if (t.sharedMemoryExperimental && t.debug) {
      if (pt.sharedMemoryExperimental) { t.debug = false; this.progress('Debug build turned off: shared memory can\'t run under AddressSanitizer (Restart all to apply)', 'warn'); }
      else if (pt.debug) { t.sharedMemoryExperimental = false; this.progress('Shared memory turned off: it can\'t run under the Debug build\'s AddressSanitizer (Restart all to apply)', 'warn'); }
    }
    saveSettings(this.settings);
    return this.settings;
  }
}

// The last run's log as <name>.prev.out (a crash restart's crash is in it), so a new start never
// empties it
function rotateLog(file) {
  try { if (fs.statSync(file).size > 0) fs.renameSync(file, file.replace(/\.out$/, '.prev.out')); } catch { /* none yet */ }
}

// A crash handler stack (compat/posix/src/process.c: "***   #N <module> +0x<offset> (<symbol>)"),
// with function names and file:line for frames in this repo's programs (addr2line)
let addr2line;
function nameFrames(lines) {
  if (addr2line === undefined) {
    addr2line = null;
    for (const t of ['addr2line', 'llvm-addr2line']) {
      try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'pipe' }); addr2line = t; break; } catch { /* not here */ }
    }
  }
  return lines.map((l) => {
    const m = l.match(/^\*\*\*\s+#(\d+) (\S+) \+(0x[0-9a-f]+)/);
    if (!m || !addr2line || !m[2].startsWith(repo) || !fs.existsSync(m[2])) return l;
    try {
      const out = execFileSync(addr2line, ['-e', m[2], '-f', '-C', '-i', '-p', m[3]], { encoding: 'utf8', timeout: 5000 })
        .trim().split('\n').map((x) => x.replace(repo + '/', '')).join('  (inlined in) ');
      return `    #${m[1]} ${out}`;
    } catch { return l; }
  });
}

// One line, no control characters, at most MESSAGE_MAX characters (a chat line)
function cleanMessage(text) {
  return String(text || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MESSAGE_MAX);
}

// The next time a schedule runs after now: every N minutes, or the same clock time N days on
// for whole days (so a daily restart stays at 4:00 across daylight saving). Once: done.
function nextRun(s, now) {
  if (!s.every) return { enabled: false };
  let at = s.at;
  const lead = s.kind === 'restart' ? s.warn * 60000 : 0;
  while (at - lead <= now) {
    if (s.every % 1440 === 0) { const d = new Date(at); d.setDate(d.getDate() + s.every / 1440); at = d.getTime(); }
    else at += s.every * 60000;
  }
  return { at };
}

// The game client's password hash (src/Game/src/clientcomm/authclient.c, acSendLoginMD5): SHA-512
// of the password (16 characters at most) and the Adler-32 of the lowercased account name as
// 8 hex digits, stored as its 128 hex digits
function adler32(buf) {
  let a = 1;
  let b = 0;
  for (const c of buf) { a = (a + c) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
// The DBServer's account id under fake auth (genFakeAuthId in DBServer clientcomm.c): Bob
// Jenkins' lookup2 hash of the lowercased name, seed 0xa74d94e3, top bit cleared. Characters
// belong to an account id, so a real account made with this uid keeps that name's characters.
function fakeAuthId(account) {
  const k = Buffer.from(String(account).toLowerCase(), 'latin1');
  let a = 0x9e3779b9; let b = 0x9e3779b9; let c = 0xa74d94e3;
  const mix = () => {
    a = (a - b - c) >>> 0; a = (a ^ (c >>> 13)) >>> 0;
    b = (b - c - a) >>> 0; b = (b ^ (a << 8)) >>> 0;
    c = (c - a - b) >>> 0; c = (c ^ (b >>> 13)) >>> 0;
    a = (a - b - c) >>> 0; a = (a ^ (c >>> 12)) >>> 0;
    b = (b - c - a) >>> 0; b = (b ^ (a << 16)) >>> 0;
    c = (c - a - b) >>> 0; c = (c ^ (b >>> 5)) >>> 0;
    a = (a - b - c) >>> 0; a = (a ^ (c >>> 3)) >>> 0;
    b = (b - c - a) >>> 0; b = (b ^ (a << 10)) >>> 0;
    c = (c - a - b) >>> 0; c = (c ^ (b >>> 15)) >>> 0;
  };
  let i = 0;
  let len = k.length;
  while (len >= 12) {
    a = (a + k.readUInt32LE(i)) >>> 0; b = (b + k.readUInt32LE(i + 4)) >>> 0; c = (c + k.readUInt32LE(i + 8)) >>> 0;
    mix(); i += 12; len -= 12;
  }
  c = (c + k.length) >>> 0;
  const at = (n) => k[i + n];
  /* eslint-disable no-fallthrough */
  switch (len) {
    case 11: c = (c + (at(10) << 24)) >>> 0;
    case 10: c = (c + (at(9) << 16)) >>> 0;
    case 9: c = (c + (at(8) << 8)) >>> 0;
    case 8: b = (b + (at(7) << 24)) >>> 0;
    case 7: b = (b + (at(6) << 16)) >>> 0;
    case 6: b = (b + (at(5) << 8)) >>> 0;
    case 5: b = (b + at(4)) >>> 0;
    case 4: a = (a + (at(3) << 24)) >>> 0;
    case 3: a = (a + (at(2) << 16)) >>> 0;
    case 2: a = (a + (at(1) << 8)) >>> 0;
    case 1: a = (a + at(0)) >>> 0;
    default: break;
  }
  mix();
  return c & 0x7fffffff;
}

// The client reads Crypto++'s Adler-32 digest (big-endian bytes) as a little-endian U32
// (cryptAdler32 in UtilitiesLib), so its salt is the checksum with its bytes swapped
function authSalt(account) {
  const v = adler32(Buffer.from(account.toLowerCase(), 'latin1'));
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0;
}
function authPasswordHash(account, password) {
  const salt = authSalt(account).toString(16).padStart(8, '0');
  return require('crypto').createHash('sha512').update(Buffer.concat([Buffer.from(password.slice(0, 16), 'latin1'), Buffer.from(salt)])).digest('hex');
}

const IP_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const CIDR_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(\/([89]|[12]\d|3[0-2]))?$/;

// This computer's addresses on its networks (IPv4, not loopback), for the Network settings
function networkInfo() {
  const out = [];
  for (const [name, list] of Object.entries(require('os').networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const bits = a.cidr ? +a.cidr.split('/')[1] : 24;
      const mask = bits ? (0xffffffff << (32 - bits)) >>> 0 : 0;
      const n = a.address.split('.').reduce((x, o) => ((x << 8) | +o) >>> 0, 0) & mask;
      const net = [24, 16, 8, 0].map((sh) => (n >>> sh) & 255).join('.');
      out.push({ name, address: a.address, network: `${net}/${bits}` });
    }
  }
  return { addresses: out, hostname: require('os').hostname() };
}
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

// servers.cfg settings the window can change
const CFG_FIELDS = [
  { key: 'ShardName', title: 'Shard name', hint: 'one word', check: /^[\w-]{1,32}$/, group: 'Shard' },
  { key: 'AdvertisedIp', title: 'Advertised IP', hint: 'the address players connect to', check: IP_RE, group: 'Network' },
  { key: 'LocalIp', title: 'Local IP', hint: 'this machine on the server network', check: IP_RE, group: 'Network' },
  { key: 'DbServer', title: 'Database Server address', hint: 'IP or host name', check: HOST_RE, group: 'Network' },
  { key: 'ChatServer', title: 'ChatServer address', hint: 'IP or host name', check: HOST_RE, group: 'Network' },
  { key: 'LogServer', title: 'LogServer address', hint: 'IP or host name', check: HOST_RE, group: 'Network' },
  { key: 'MaxPlayers', title: 'Max players', hint: 'a number', check: /^\d{1,5}$/, group: 'Shard' },
  { key: 'MaxLevel', title: 'Max level', hint: '1 to 50', check: /^([1-9]|[1-4]\d|50)$/, group: 'Shard' },
  { key: 'XPScale', title: 'XP scale', hint: 'like 1.0', check: /^\d+(\.\d+)?$/, group: 'Rates' },
  { key: 'InfluenceScale', title: 'Influence scale', hint: 'like 1.0', check: /^\d+(\.\d+)?$/, group: 'Rates' },
  { key: 'PrestigeScale', title: 'Prestige scale', hint: 'like 1.0', check: /^\d+(\.\d+)?$/, group: 'Rates' },
  { key: 'DefaultAccessLevel', title: 'Default access level (new characters)', hint: '0 to 11', check: /^(\d|1[01])$/, group: 'Access',
    warn: 'Every new character starts at this level. Anything above 0 gives staff commands to everyone who makes a character.' },
];

// Messages to players and restarts with a warning (docs/BROADCAST.md)
const DEFAULT_RESTART_MESSAGE = 'The server is restarting. It will be back in a few minutes.';
const RESTART_WARNINGS = [60, 30, 15, 10, 5, 3, 2, 1]; // minutes before a planned restart
const MESSAGE_MAX = 250;
const SCHEDULE_LATE_MS = 10 * 60 * 1000; // a message more than this late (the app was closed) is skipped
const inboxDir = path.join(readyDir, 'DBServer.inbox');
const outboxDir = path.join(readyDir, 'DBServer.outbox');
const chatInboxDir = path.join(readyDir, 'ChatServer.inbox');
const chatOutboxDir = path.join(readyDir, 'ChatServer.outbox');

// The chat protocol's escapes (utils.c escapeData / unescapeDataToBuffer), so a message with
// quotes, newlines or % goes over as one argument
function chatEscape(v) {
  return String(v ?? '').replace(/[\\\n\r\t"'%$]/g, (c) => ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '"': '\\q', "'": '\\s', '%': '\\p', $: '\\d' })[c]);
}
function chatUnescape(v) {
  return String(v ?? '').replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', q: '"', s: "'", p: '%', d: '$', '0': '', '\\': '\\' })[c] ?? c);
}
// A line the ChatServer sent: its words (quoted ones whole, unescaped)
function chatWords(line) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(chatUnescape(m[1] !== undefined ? m[1] : m[2]));
  return out;
}
// A reply worth showing (SysMsg ...): the words after the kind
function chatLineText(line) {
  const w = chatWords(line);
  return /^(Chan)?SysMsg$/.test(w[0]) ? w.slice(w[0] === 'ChanSysMsg' ? 2 : 1).join(' ') : '';
}

// The names the game client shows for server ids in its server list (clientmessages-en.bin,
// CoHWorldServer_<id>; this client names them itself, docs/AUTH.md). ensureAuthDb lists this
// shard as id 1.
const SERVER_NAMES = ['Freedom', 'Justice', 'Pinnacle', 'Virtue', 'Liberty', 'Guardian', 'Infinity', 'Protector',
  'Victory', 'Champion', 'Triumph', 'Defiant', 'Zukunft', 'Vigilance', 'Union', 'Exalted'];
const AUTH_SERVER_ID = 1;

// Zone names by static map id (the game's mapmove list), for the Shards view
let zoneNames = null;
function zoneName(id) {
  if (!zoneNames) {
    zoneNames = {};
    for (const line of (readText(path.join(__dirname, 'zones.txt')) || '').split('\n')) {
      const m = line.trim().match(/^(.*),(\d+)$/);
      if (m && !zoneNames[m[2]]) zoneNames[m[2]] = m[1];
    }
  }
  return zoneNames[id] || '';
}

// What the Shards view can do to an online player (Shard.playerAction). Each runs as that
// player on their map, through the DBServer (svrmoncomm.c, "player"), at access level 11.
const PLAYER_ACTIONS = {
  exitMission: { label: 'Out of the mission', cmd: () => 'exitmission' },
  stuck: { label: 'Unstuck', cmd: () => 'stuck' },
  toZone: { label: 'To the zone they came from', cmd: (p) => (p.staticMap > 0 ? `mapmove ${p.staticMap}` : null) },
  freeze: { label: 'Freeze', cmd: (p) => `freeze "${p.name}" 1` },
  unfreeze: { label: 'Unfreeze', cmd: (p) => `freeze "${p.name}" 0` },
  // svrkick is the server kick ("kick" is the team kick)
  kick: { label: 'Kick', cmd: (p, arg) => `svrkick "${p.name}" ${cleanMessage(arg).replace(/["$]/g, '') || 'Kicked by staff'}` },
};

// ---------------------------------------------------------------------------
// The machine the shard runs on (Machines tab): CPU over all cores, load, memory and swap, disk,
// temperature, pressure (Linux PSI). Read where the shard runs, so a picked machine reports its
// own. Cheap: /proc files and os calls; macOS's swap is one sysctl, kept for 10 s.
// ---------------------------------------------------------------------------
const os = require('os');
let hostPrev = null;
let hostSwapMac = { at: 0, total: 0, used: 0 };
function readKb(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
  return m ? +m[1] : 0;
}
function readFirst(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function cpuTemp() {
  // The CPU's sensor: AMD k10temp (the Steam Machine), Intel coretemp, else the first thermal zone
  try {
    for (const h of fs.readdirSync('/sys/class/hwmon')) {
      const name = readFirst(`/sys/class/hwmon/${h}/name`);
      if (/^(k10temp|coretemp|zenpower|cpu_thermal)$/.test(name)) {
        const t = +readFirst(`/sys/class/hwmon/${h}/temp1_input`);
        if (t) return Math.round(t / 100) / 10;
      }
    }
    const t = +readFirst('/sys/class/thermal/thermal_zone0/temp');
    if (t) return Math.round(t / 100) / 10;
  } catch { /* not Linux, or no sensors */ }
  return null;
}
function psi(kind) {
  // "some avg10": the share of the last 10 s some task waited on CPU / memory / disk
  const m = readFirst(`/proc/pressure/${kind}`).match(/^some avg10=([\d.]+)/m);
  return m ? +m[1] : null;
}
async function hostStats(dir) {
  const cpus = os.cpus();
  const times = cpus.reduce((a, c) => { const t = c.times; a.idle += t.idle; a.all += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, all: 0 });
  let cpuPct = null;
  if (hostPrev && times.all > hostPrev.all) cpuPct = Math.round(1000 * (1 - (times.idle - hostPrev.idle) / (times.all - hostPrev.all))) / 10;
  hostPrev = times;
  const out = {
    hostname: os.hostname(), platform: process.platform, cores: cpus.length, cpuModel: (cpus[0] && cpus[0].model || '').replace(/\s+/g, ' ').trim(),
    cpuPct, load: os.loadavg().map((x) => Math.round(x * 100) / 100), uptime: Math.round(os.uptime()),
    memTotalMB: Math.round(os.totalmem() / 1048576), memAvailMB: Math.round(os.freemem() / 1048576), swapTotalMB: 0, swapUsedMB: 0,
    tempC: null, pressure: null, diskFreeMB: null, diskTotalMB: null,
  };
  if (process.platform === 'linux') {
    const mi = readFirst('/proc/meminfo');
    if (mi) {
      out.memAvailMB = Math.round(readKb(mi, 'MemAvailable') / 1024) || out.memAvailMB;
      out.swapTotalMB = Math.round(readKb(mi, 'SwapTotal') / 1024);
      out.swapUsedMB = Math.round((readKb(mi, 'SwapTotal') - readKb(mi, 'SwapFree')) / 1024);
    }
    out.tempC = cpuTemp();
    const p = { cpu: psi('cpu'), memory: psi('memory'), io: psi('io') };
    if (p.cpu !== null || p.memory !== null) out.pressure = p;
  } else if (process.platform === 'darwin') {
    if (Date.now() - hostSwapMac.at > 10000) {
      hostSwapMac.at = Date.now();
      try {
        const t = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8', timeout: 2000 });
        const num = (k) => { const m = t.match(new RegExp(`${k} = ([\\d.]+)M`)); return m ? Math.round(+m[1]) : 0; };
        hostSwapMac.total = num('total'); hostSwapMac.used = num('used');
      } catch { /* leave it */ }
    }
    out.swapTotalMB = hostSwapMac.total; out.swapUsedMB = hostSwapMac.used;
  }
  try {
    const st = fs.statfsSync(dir && fs.existsSync(dir) ? dir : repo);
    out.diskFreeMB = Math.round(st.bavail * st.bsize / 1048576);
    out.diskTotalMB = Math.round(st.blocks * st.bsize / 1048576);
  } catch { /* old Node */ }
  return out;
}

// Restarted after a crash (Shard.autoRestart): these, 3 times in 10 minutes at most
const AUTO_RESTART = ['DBServer', 'Launcher', 'AuthServer'];
const AUTO_RESTART_MAX = 3;
const AUTO_RESTART_WINDOW_MS = 10 * 60 * 1000;

// What makes an alert. Known and expected lines are skipped.
const ALERT_IGNORE = /ERRORLOG|FILEERROR|socketSetBufferSize|performance counter|Can't connect to chatserver|directory watching|OpenThread: only|regfileLoadKeyValue|no shared heap/i;
const ALERT_RULES = [
  { re: /AddressSanitizer|==\d+==ERROR/, title: 'memory error (AddressSanitizer)', level: 'error' },
  { re: /\b(SIGSEGV|SIGBUS|SIGABRT|Segmentation fault|Bus error|Abort trap)\b|crashed: signal/, title: 'crashed', level: 'error' },
  { re: /Assertion failed|ASSERTION FAILED|assert failed/i, title: 'assertion failed', level: 'error' },
  { re: /could not connect to SQL|SQLDriverConnect.*failed|Login failed for user|^SQLERROR:|Can't open lib/i, title: 'database error', level: 'error' },
  { re: /\bFATAL\b|Fatal error|failure loading|Unable to locate|Bad or missing/i, title: 'fatal error', level: 'error' },
];

// ---------------------------------------------------------------------------
// Calls: what the window can ask of a shard. main.js uses these for this computer; the control
// service below offers the same ones to Shard Admin on another computer.
// ---------------------------------------------------------------------------

function shardCalls(shard) {
  return {
    info: () => shard.info(),
    status: () => shard.status(),
    start: () => shard.start(),
    stop: () => shard.stop(),
    stopShard: () => shard.stop({ keepGlobal: true }),
    startGlobal: () => shard.startGlobal(),
    stopAll: () => shard.stopAll(),
    restartAll: (opts) => shard.restartAll(opts || {}),
    broadcast: (text) => shard.broadcast(text),
    overview: () => shard.overview(),
    memoryErrors: () => shard.memoryErrors(),
    playerAction: (a) => shard.playerAction(a || {}),
    serverAction: (a) => shard.serverAction(a || {}),
    extraShards: () => shard.extraShards(),
    extraShardAction: (a) => shard.extraShardAction(a || {}),
    extraShardLog: (a) => shard.extraShardLog(a || {}),
    chatLogin: () => shard.chatLogin(),
    chatLogout: () => shard.chatLogout(),
    chatPoll: (since) => shard.chatPoll(since),
    chatRun: (a) => shard.chatRun(a || {}),
    zones: () => shard.zones(),
    staffSignIn: (a) => shard.staffSignIn(a || {}),
    staffSignOut: () => shard.staffSignOut(),
    staffCharacters: () => shard.staffCharacters(),
    staffPick: (a) => shard.staffPick(a || {}),
    cancelRestart: () => shard.cancelRestart(),
    schedules: () => shard.schedules(),
    saveSchedule: (item) => shard.saveSchedule(item || {}),
    deleteSchedule: (id) => shard.deleteSchedule(id),
    restart: (name) => shard.restart(name),
    restartUpdated: () => shard.restartUpdated(),
    stopPid: (pid) => shard.stopPid(pid),
    build: (targets) => shard.build(targets),
    buildChanged: () => shard.buildChanged(),
    checkOutdated: () => shard.checkOutdated(),
    configure: () => shard.configure(),
    readLog: (key) => shard.readLogTail(key),
    logKeys: () => shard.logKeys(),
    readCfg: () => shard.readServersCfg(),
    writeCfg: (values) => shard.writeServersCfg(values),
    writeGrants: (mode) => shard.writeGrants(mode),
    setStaff: ({ account, level }) => shard.setStaff(account, level),
    characters: (q) => shard.characters(q),
    setCharacterAccess: ({ id, level }) => shard.setCharacterAccess(id, level),
    setSettings: (patch) => shard.setSettings(patch),
    backup: () => shard.backup(),
    writeManifest: (ip) => shard.writeManifest(ip),
    importDatabases: ({ dir, ...opts } = {}) => shard.importDatabases(dir, opts),
    importRollback: (stamp) => shard.importRollback(stamp),
    accounts: () => shard.accounts(),
    setAccount: (a) => shard.setAccount(a),
  };
}

// ---------------------------------------------------------------------------
// The control service: Shard Admin on another computer drives the shard on this one.
//   node backend.js serve [port]   (tools/remote-shard.sh admin starts it, through serve-bg)
// It listens on 127.0.0.1 only; Shard Admin reaches it through an ssh tunnel, so it is never on
// the network, and every request needs the token in .local/shard-admin-serve.json (0600). Calls
// are POST /call/<name> with {"arg": ...}; GET /events streams logs, progress and alerts
// (server-sent events).
// ---------------------------------------------------------------------------

const serveFile = path.join(local, 'shard-admin-serve.json');

// Which code a control service runs: a sync that changes it makes serve-bg start a new one
function codeStamp() {
  const h = require('crypto').createHash('sha1');
  for (const f of ['backend.js', 'dbimport.js']) { try { h.update(fs.readFileSync(path.join(__dirname, f))); } catch { /* none */ } }
  return h.digest('hex').slice(0, 16);
}
const debug = process.env.INCARNATE_DEBUG === '1';

function serve(port) {
  const http = require('http');
  const crypto = require('crypto');
  const shard = new Shard();
  const calls = shardCalls(shard);
  const token = crypto.randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const streams = new Set();
  let inflight = 0;
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  const push = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of streams) res.write(msg);
  };
  for (const ev of ['log', 'progress', 'alert']) shard.on(ev, (d) => push(ev, d));

  const okToken = (req) => {
    const t = Buffer.from(String(req.headers['x-incarnate-token'] || ''));
    return t.length === tokenBuf.length && crypto.timingSafeEqual(t, tokenBuf);
  };
  const server = http.createServer((req, res) => {
    const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!okToken(req)) { log('refused: bad token', req.method, req.url); return json(403, { ok: false, error: 'bad token' }); }
    if (req.method === 'GET' && req.url === '/ping') return json(200, { ok: true, pid: process.pid, busy: shard.busy || (shard.restarting ? 'restarting' : null) });
    if (req.method === 'GET' && req.url === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      streams.add(res);
      log(`window connected (${streams.size})`);
      req.on('close', () => { streams.delete(res); log(`window disconnected (${streams.size})`); });
      return undefined;
    }
    const m = req.method === 'POST' && req.url.match(/^\/call\/(\w+)$/);
    if (!m || !Object.hasOwn(calls, m[1])) return json(404, { ok: false, error: 'no such call' });
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      inflight++;
      try {
        const { arg } = body ? JSON.parse(body) : {};
        if (debug) log('call', m[1]);
        const r = await calls[m[1]](arg);
        json(200, { result: r === undefined ? null : r });
      } catch (e) {
        json(200, { result: { ok: false, error: e.message } });
      } finally {
        inflight--;
      }
    });
    return undefined;
  });
  // Heartbeats keep the tunnel and the window's stream from looking dead
  setInterval(() => { for (const res of streams) res.write(': ping\n\n'); }, 15000);
  setInterval(() => { try { shard.pollLogs(); } catch { /* a log rotated mid-read */ } }, 700);
  shard.startScheduler(); // messages and planned restarts, with or without a window connected
  // Status runs the "stopped" alerts, so keep it going while no window is connected too
  setInterval(() => { if (!streams.size) shard.status().catch(() => {}); }, 5000);
  setInterval(() => { if (!shard.busy) shard.checkOutdated().catch(() => {}); }, 5 * 60 * 1000);

  // A sync that brings new code for this service: finish what's running, then exit. The next
  // connection (tools/remote-shard.sh admin) starts the new one; the shard itself keeps running.
  const me = fs.statSync(__filename).mtimeMs;
  setInterval(() => {
    let now;
    try { now = fs.statSync(__filename).mtimeMs; } catch { return; }
    if (now !== me && !shard.busy && !inflight) { log('backend.js changed: exiting for the new version'); process.exit(0); }
  }, 2000);

  let tries = 0;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries++ < 10) { port++; server.listen(port, '127.0.0.1'); return; }
    log(`can't listen: ${e.message}`);
    process.exit(1);
  });
  server.on('listening', () => {
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(serveFile, JSON.stringify({ pid: process.pid, port, token, code: codeStamp() }), { mode: 0o600 });
    fs.chmodSync(serveFile, 0o600);
    log(`listening on 127.0.0.1:${port} (pid ${process.pid})`);
  });
  server.listen(port, '127.0.0.1');
}

// Start the control service unless one is already answering, then print "admin: <port> <token>"
async function serveBackground() {
  const http = require('http');
  const ping = (s) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: s.port, path: '/ping', headers: { 'X-Incarnate-Token': s.token }, timeout: 2000 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { if (res.statusCode !== 200) return resolve(false); try { resolve(JSON.parse(body)); } catch { resolve({ ok: true }); } });
      });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  const current = () => { try { return JSON.parse(readText(serveFile)); } catch { return null; } };
  let s = current();
  // Running older code (a sync changed backend.js): replace it, unless it's in the middle of a
  // start, stop, restart or build, which would be cut off (the next connect replaces it then)
  if (s && alive(s.pid) && s.code !== codeStamp()) {
    const p = await ping(s);
    if (p && p.busy) console.error(`the control service runs older code but is ${p.busy}: keeping it for now`);
    else {
      try { process.kill(s.pid, 'SIGTERM'); } catch { /* gone */ }
      for (let i = 0; i < 25 && alive(s.pid); i++) await sleep(200);
      if (alive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* gone */ } }
      s = null;
    }
  }
  if (!(s && alive(s.pid) && await ping(s))) {
    try { fs.unlinkSync(serveFile); } catch { /* none */ }
    fs.mkdirSync(local, { recursive: true });
    const out = fs.openSync(path.join(local, 'shard-admin-serve.log'), 'a');
    const port = Number(process.env.INCARNATE_ADMIN_PORT || 7098);
    const child = spawn(process.execPath, [__filename, 'serve', String(port)], { cwd: repo, detached: true, stdio: ['ignore', out, out],
      env: { ...process.env, PATH } });
    child.unref();
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      s = current();
      if (s && s.pid === child.pid && await ping(s)) break;
      s = null;
    }
    if (!s) { console.error('the control service did not start (.local/shard-admin-serve.log)'); process.exit(1); }
  }
  console.log(`admin: ${s.port} ${s.token}`);
}

module.exports = { SERVER_NAMES, hostStats, chatWords, chatEscape, Shard, shardServers, shardCalls, cleanMessage, nextRun, networkInfo, authPasswordHash, authSalt, adler32, fakeAuthId, TOGGLES, CFG_FIELDS, IP_RE, CIDR_RE, repo };

// node backend.js status|outdated|chars [search]|start|stop|restart|build|build-changed
if (require.main === module) {
  const shard = ['serve', 'serve-bg'].includes(process.argv[2]) ? null : new Shard();
  const cmd = process.argv[2] || 'status';
  (async () => {
    if (cmd === 'status') {
      const s = await shard.status();
      console.log(`servers up: ${s.up}/${s.total}`);
      for (const x of [...s.servers, ...s.extras]) console.log(`  ${x.state.padEnd(8)} ${x.name}${x.pid ? ` (pid ${x.pid})` : ''}`);
    } else if (cmd === 'outdated') {
      console.log(await shard.checkOutdated());
    } else if (cmd === 'chars') {
      console.log(await shard.characters({ search: process.argv[3] || '', minLevel: 0 }));
    } else if (cmd === 'backup') {
      shard.on('progress', (p) => console.log(p.text));
      const r = await shard.backup();
      if (r.ok) console.log(`backup: ${r.dir}`); // tools/remote-shard.sh reads this line
      process.exit(r.ok ? 0 : 1);
    } else if (['start', 'stop', 'restart', 'build', 'build-changed', 'restore'].includes(cmd)) {
      // Headless use (tools/remote-shard.sh runs these on the server machine): the same steps
      // as the window's buttons, progress printed in color on a terminal
      const tty = process.stdout.isTTY && process.env.INCARNATE_COLOR !== '0';
      const paint = { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
      shard.on('progress', (p) => console.log(tty && paint[p.level] ? `${paint[p.level]}${p.text}\x1b[0m` : p.text));
      shard.on('alert', (a) => console.log(tty ? `\x1b[31malert: ${a.title}\x1b[0m ${a.body || ''}` : `alert: ${a.title} ${a.body || ''}`));
      const r = cmd === 'start' ? await shard.start() : cmd === 'stop' ? await shard.stop() : cmd === 'restart' ? await shard.restartAll()
        : cmd === 'build' ? await shard.build() : cmd === 'restore' ? await shard.restore(process.argv[3]) : await shard.buildChanged();
      process.exit(r && r.ok === false ? 1 : 0);
    } else if (cmd === 'import' || cmd === 'import-rollback') {
      const tty = process.stdout.isTTY && process.env.INCARNATE_COLOR !== '0';
      const paint = { ok: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
      shard.on('progress', (p) => console.log(tty && paint[p.level] ? `${paint[p.level]}${p.text}\x1b[0m` : p.text));
      const args = process.argv.slice(3);
      let r;
      if (cmd === 'import-rollback') r = await shard.importRollback(args[0]);
      else {
        const opts = { dryRun: args.includes('--dry-run'), quick: args.includes('--quick'), force: args.includes('--force'),
          stopShard: args.includes('--stop-shard'), map: {} };
        args.forEach((a, i) => { if (a === '--map' && args[i + 1]) { const [k, v] = args[i + 1].split('='); if (k && v) opts.map[k] = v; } });
        const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--map');
        r = await shard.importDatabases(dir || '', opts);
      }
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'account') {
      // tools/auth-account.sh: list | create <name> | passwd <name> | block <name> | unblock <name>.
      // The password comes on stdin (never the command line, where ps shows it).
      const tty = process.stdout.isTTY && process.env.INCARNATE_COLOR !== '0';
      const paint = (c, t) => (tty ? `\x1b[${c}m${t}\x1b[0m` : t);
      shard.on('progress', (p) => console.log(p.level === 'ok' ? paint(32, p.text) : p.level === 'error' ? paint(31, p.text) : p.text));
      const [sub, name] = process.argv.slice(3);
      const readPw = () => new Promise((resolve) => {
        let d = '';
        process.stdin.on('data', (c) => { d += c; });
        process.stdin.on('end', () => resolve(d.replace(/\r?\n$/, '')));
      });
      let r;
      try {
        if (sub === 'create') r = await shard.setAccount({ account: name, password: await readPw(), create: true });
        else if (sub === 'passwd') r = await shard.setAccount({ account: name, password: await readPw() });
        else if (sub === 'block' || sub === 'unblock') r = await shard.setAccount({ account: name, blocked: sub === 'block' });
        else if (sub === 'link') r = await shard.setAccount({ account: name, relink: true });
        else r = await shard.accounts();
      } catch (e) { r = { ok: false, error: e.message }; }
      if (!r.ok) { console.error(paint(31, r.error)); process.exit(1); }
      if (sub === 'list' || !sub) {
        if (!r.rows.length) console.log('No accounts yet: tools/auth-account.sh create <name>');
        for (const a of r.rows) console.log(`${a.account.padEnd(15)} uid ${String(a.uid).padEnd(11)} ${a.blocked ? paint(31, 'blocked') : paint(32, 'active ')}  ${a.hasPassword ? '' : paint(33, 'no password ')}${a.linked ? '' : paint(33, 'not linked (link: its fake-auth characters) ')}last login ${a.last || 'never'}`);
      }
      process.exit(0);
    } else if (cmd === 'serve') {
      serve(Number(process.argv[3] || process.env.INCARNATE_ADMIN_PORT || 7098));
    } else if (cmd === 'serve-bg') {
      await serveBackground();
    } else if (cmd === 'cfg') {
      console.log(JSON.stringify(shard.readServersCfg(), (k, v) => (v instanceof RegExp ? String(v) : v), 2));
    }
  })();
}
