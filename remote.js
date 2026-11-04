// Shard Admin's remote mode: the shard runs on another machine (tools/remote-shard.sh), and this
// window drives it. tools/remote-shard.sh admin copies the source over and starts the control
// service there (backend.js serve, 127.0.0.1 only, with a token); an ssh tunnel brings its port
// here, and every call and event goes through it. Nothing listens on the network.
'use strict';

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { repo, IP_RE, CIDR_RE } = require('./backend');

const script = path.join(repo, 'tools', 'remote-shard.sh');
const outFile = path.join(repo, '.local', 'remote', 'connection.out');
const extraPath = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const PATH = [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), ...extraPath])].join(':');
const debug = process.env.INCARNATE_DEBUG === '1' || process.argv.includes('--debug');
const dlog = (...a) => { if (debug) console.log('\x1b[36m[remote]\x1b[0m', ...a); };

// A machine, as the Machines tab saves it. Every value ends up in an ssh command, so only plain
// ones get through (remote-shard.sh checks them again).
function checkProfile(p) {
  const out = {
    id: String(p.id || `m${Date.now().toString(36)}`),
    name: String(p.name || '').trim().slice(0, 48),
    ssh: String(p.ssh || '').trim(),
    port: String(p.port || '22').trim(),
    ip: String(p.ip || '').trim(),
    dir: String(p.dir || 'Incarnate').trim(),
    box: String(p.box || 'incarnate').trim(),
    staffFrom: String(p.staffFrom || 'auto').trim().replace(/\s+/g, ''),
  };
  if (!/^m[\w]{1,20}$/.test(out.id)) throw new Error('bad machine id');
  if (!/^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/.test(out.ssh)) throw new Error('SSH: user@host, like deck@192.168.1.50');
  if (!/^\d{1,5}$/.test(out.port) || +out.port < 1 || +out.port > 65535) throw new Error('SSH port: a number, usually 22');
  if (out.ip && !IP_RE.test(out.ip)) throw new Error('Address players use: an IPv4 address, or empty for the SSH host');
  if (!/^[A-Za-z0-9._/-]+$/.test(out.dir) || out.dir.includes('..') || out.dir.startsWith('/')) throw new Error('Folder there: under the home folder, like Incarnate');
  if (!/^[A-Za-z0-9._-]+$/.test(out.box)) throw new Error('Container: a name, or none to run straight on the machine');
  if (!['auto', 'none'].includes(out.staffFrom) && !out.staffFrom.split(',').every((n) => CIDR_RE.test(n))) {
    throw new Error('Staff logins from: auto, none, or addresses and networks like 192.168.1.0/24');
  }
  if (!out.name) out.name = out.ssh;
  return out;
}

// Opened from the Dock or Finder, the app doesn't get what the login shell sets up, and an ssh
// agent set in .zshrc or .bash_profile (1Password, Secretive, a custom ssh-agent) is the usual
// way a key gets in without a password. Ask the login shell once.
let shellAgent;
function agentSock() {
  if (shellAgent !== undefined) return shellAgent;
  shellAgent = '';
  if (process.platform === 'win32') return shellAgent;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    const out = require('child_process').execFileSync(sh, ['-ilc', 'printf "\n__SOCK__%s\n" "$SSH_AUTH_SOCK"'],
      { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/__SOCK__(.*)$/m);
    if (m && m[1] && fs.existsSync(m[1])) shellAgent = m[1];
  } catch { /* no login shell answer: keep what the app has */ }
  if (shellAgent && shellAgent !== process.env.SSH_AUTH_SOCK) dlog(`ssh agent from the login shell: ${shellAgent}`);
  return shellAgent;
}

function profileEnv(p) {
  const sock = agentSock();
  return { ...process.env, ...(sock ? { SSH_AUTH_SOCK: sock } : {}), PATH, INCARNATE_COLOR: '0', INCARNATE_SSH_BATCH: '1',
    INCARNATE_REMOTE: p.ssh, INCARNATE_REMOTE_PORT: p.port, INCARNATE_REMOTE_IP: p.ip, INCARNATE_REMOTE_DIR: p.dir,
    INCARNATE_REMOTE_BOX: p.box, INCARNATE_REMOTE_STAFF_FROM: p.staffFrom };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class RemoteShard extends EventEmitter {
  constructor(profile) {
    super();
    this.profile = checkProfile(profile);
    this.state = 'idle';        // idle | connecting | connected | down | closed
    this.error = '';
    this.ip = '';               // the address players use, as remote-shard.sh worked it out
    this.port = 0;              // the tunnel's end here
    this.token = '';
    this.tunnel = null;
    this.events = null;
    this.retry = 2000;
    this.connecting = null;
    this.syncing = null;
    this.busyLocal = null;      // a remote-shard.sh step this window is running (setup, data, ...)
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
  }

  describe() {
    return { kind: 'remote', id: this.profile.id, name: this.profile.name, ssh: this.profile.ssh, ip: this.ip || this.profile.ip,
      state: this.state, error: this.error, busy: this.busyLocal };
  }

  setState(state, error = '') {
    this.state = state;
    this.error = error;
    dlog(state, error);
    this.emit('state', this.describe());
  }

  // tools/remote-shard.sh with this machine's settings. Its output goes to the Machine log.
  script(args, { quiet = false, keepStdout = false } = {}) {
    return new Promise((resolve) => {
      const out = fs.createWriteStream(outFile, { flags: 'a' });
      if (!quiet) {
        const head = `\n===== ${new Date().toLocaleString()}: remote-shard.sh ${args.join(' ')}\n`;
        out.write(head);
        this.emit('log', { key: 'machine', text: head });
      }
      const child = spawn(script, args, { cwd: repo, env: profileEnv(this.profile) });
      let stdout = '';
      let all = '';
      const onData = (d, isOut) => {
        const s = String(d);
        if (isOut) stdout += s;
        all += s;
        const shown = keepStdout && isOut ? s.replace(/^admin: .*$/gm, 'admin: (connection details)') : s;
        if (!quiet || !isOut) { out.write(shown); this.emit('log', { key: 'machine', text: shown }); }
      };
      child.stdout.on('data', (d) => onData(d, true));
      child.stderr.on('data', (d) => onData(d, false));
      child.on('error', (e) => onData(`${e.message}\n`, false));
      child.on('close', (code) => {
        out.end();
        const lastErr = all.trim().split('\n').filter(Boolean).pop() || `exit ${code}`;
        resolve({ ok: code === 0, code, stdout, error: code === 0 ? '' : lastErr });
      });
    });
  }

  // ---- The connection ----

  connect() {
    if (!this.connecting) this.connecting = this.doConnect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async doConnect() {
    if (this.state === 'closed') return false;
    clearTimeout(this.retryTimer);
    this.dropTunnel();
    this.setState('connecting');
    const r = await this.script(['admin'], { keepStdout: true });
    if (this.state === 'closed') return false;
    const m = r.stdout.match(/^admin: (\d+) ([0-9a-f]+) (\S+)$/m);
    if (!r.ok || !m) { this.fail(r.error || 'the control service did not answer'); return false; }
    const [, remotePort, token, ip] = m;
    this.token = token;
    this.ip = ip;
    this.port = await freePort();
    this.tunnel = spawn(script, ['tunnel', String(this.port), remotePort], { cwd: repo, env: profileEnv(this.profile), stdio: ['ignore', 'ignore', 'pipe'] });
    let tunnelErr = '';
    this.tunnel.stderr.on('data', (d) => { tunnelErr += d; });
    const t = this.tunnel;
    t.on('close', (code) => {
      if (this.tunnel !== t) return;
      this.tunnel = null;
      if (this.state !== 'closed') this.fail(`the ssh tunnel closed (${(tunnelErr.trim().split('\n').pop()) || `exit ${code}`})`);
    });
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (this.tunnel !== t) return false;
      if (await this.ping()) break;
      if (i === 49) { this.fail('the tunnel opened, but the control service did not answer through it'); return false; }
    }
    this.openEvents();
    clearTimeout(this.retryTimer);
    this.retry = 2000;
    this.setState('connected');
    return true;
  }

  fail(msg) {
    this.dropTunnel();
    if (this.state === 'closed') return;
    // Wrong or missing key: trying again changes nothing until it's fixed
    if (/Permission denied|without a password|Host key verification failed/i.test(msg)) {
      const hint = /Host key/i.test(msg)
        ? ' The machine\'s host key changed or isn\'t known yet: ssh to it once in a terminal.'
        : ' Fix the key (Machines tab, SSH key), then Try again.';
      this.setState('down', `${msg}.${hint}`);
      clearTimeout(this.retryTimer);
      return;
    }
    this.setState('down', msg);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 30000);
  }

  dropTunnel() {
    if (this.events) { this.events.destroy(); this.events = null; }
    if (this.tunnel) { const t = this.tunnel; this.tunnel = null; t.kill(); }
  }

  close() {
    this.setState('closed');
    clearTimeout(this.retryTimer);
    this.dropTunnel();
  }

  request(method, urlPath, body, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify({ arg: body });
      const req = http.request({ host: '127.0.0.1', port: this.port, path: urlPath, method,
        headers: { 'X-Incarnate-Token': this.token, 'Content-Type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          try { resolve({ code: res.statusCode, body: JSON.parse(text) }); } catch { reject(new Error(`bad answer (${res.statusCode})`)); }
        });
      });
      req.on('error', reject);
      if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('no answer')));
      if (data) req.write(data);
      req.end();
    });
  }

  async ping() {
    try { return (await this.request('GET', '/ping', undefined, 2000)).code === 200; } catch { return false; }
  }

  openEvents() {
    const req = http.get({ host: '127.0.0.1', port: this.port, path: '/events', headers: { 'X-Incarnate-Token': this.token } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); this.fail(`events: ${res.statusCode}`); return; }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const data = (block.match(/^data: (.*)$/m) || [])[1];
          if (ev && data) { try { this.emit(ev, JSON.parse(data)); } catch { /* a broken line */ } }
        }
      });
      // The service there stopped (a sync brought it new code) or the tunnel went
      const gone = () => { if (this.events === req) { this.events = null; this.fail('the connection closed'); } };
      res.on('end', gone);
      res.on('close', gone);
      res.on('aborted', gone);
    });
    req.on('error', () => { if (this.events === req) { this.events = null; this.fail('the connection closed'); } });
    this.events = req;
  }

  // A call on the shard there. Waits for the connection; one retry after a reconnect, since
  // a sync can restart the service between two calls.
  async call(name, arg, timeoutMs = ['status', 'info', 'logKeys', 'readLog'].includes(name) ? 15000 : 0) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.state !== 'connected') {
        if (this.state === 'closed') return { ok: false, error: 'not connected' };
        if (!(await this.connect())) return { ok: false, error: `${this.profile.name}: ${this.error || 'not connected'}` };
      }
      try {
        const r = await this.request('POST', `/call/${name}`, arg === undefined ? null : arg, timeoutMs);
        if (r.code === 200) return r.body.result;
        return { ok: false, error: r.body.error || `error ${r.code}` };
      } catch (e) {
        dlog(`call ${name}: ${e.message}`);
        if (attempt === 0 && this.state !== 'closed') { this.fail(e.message); await sleep(300); continue; }
        return { ok: false, error: e.message };
      }
    }
    return { ok: false, error: 'not connected' };
  }

  // The source (and its servers.cfg) over to the machine. Calls share one sync at a time.
  sync() {
    if (!this.syncing) {
      this.syncing = this.script(['sync']).finally(() => { this.syncing = null; });
    }
    return this.syncing;
  }

  // A remote-shard.sh step from the Machines tab, output in the Machine log
  async step(cmd) {
    const allowed = ['sync', 'setup', 'data', 'copy-db', 'manifest', 'logs', 'mem', 'status'];
    if (!allowed.includes(cmd)) throw new Error(`not a machine step: ${cmd}`);
    if (this.busyLocal) return { ok: false, error: `busy: ${this.busyLocal}` };
    this.busyLocal = cmd;
    this.emit('state', this.describe());
    try {
      return await this.script([cmd]);
    } finally {
      this.busyLocal = null;
      this.emit('state', this.describe());
    }
  }

  // Test: can ssh get there without a password, and what's there
  async test() {
    return this.script(['config']).then(async (c) => {
      if (!c.ok) return c;
      return this.script(['status']);
    });
  }
}

module.exports = { RemoteShard, checkProfile, profileEnv, outFile, script };
