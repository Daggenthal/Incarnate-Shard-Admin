// Updates for Incarnate's own apps (Incarnate Launcher and Shard Admin). Both run the code in
// this repository (tools/install-apps.sh), so an update is the repository's: newer commits on
// the branch it follows. check() fetches and counts them; update() pulls them (fast-forward
// only, so nothing of yours is ever merged or lost), runs npm install when the app's packages
// changed, and the app restarts itself on the new code.
//
//   const upd = require('../tools/app-update.js');
//   upd.version(appDir)  -> { version, commit, date, branch }
//   await upd.check()    -> { ok, available, behind, ahead, newest: [{ commit, subject, date }], ... }
//   await upd.update(appDir) -> { ok, from, to, npm, electronChanged, error }
//   const w = upd.watchCode(appDir)  -> w.changed(): this app's files that changed on disk since
//                                       it started (a sync, an edit, a pull from a terminal)
//
// So "Update Available" means either: newer commits on the remote (pulled, then a restart), or
// newer code already on disk than the running app (just a restart).
//
// git never asks for anything (no password prompt, ssh in batch mode): it works with what the
// keychain or ssh agent already has, or says why it couldn't.
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const repo = path.resolve(__dirname); // this app's own checkout (Incarnate-Shard-Admin)
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes -o ConnectTimeout=15' };
// macOS apps opened from Finder don't get the shell's PATH: Homebrew's git and npm
gitEnv.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd || repo, env: gitEnv, timeout: opts.timeout || 60000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() || (err ? err.message : '') }));
  });
}
const git = (...a) => run('git', a);

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// What's running: the app's version (its package.json) and the commit it's on
function version(appDir) {
  const pkg = readJson(path.join(appDir, 'package.json')) || {};
  let commit = '';
  let date = '';
  let branch = '';
  try {
    const { execFileSync } = require('child_process');
    const g = (...a) => execFileSync('git', a, { cwd: repo, env: gitEnv, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    commit = g('rev-parse', '--short', 'HEAD');
    date = g('log', '-1', '--format=%cs');
    branch = g('rev-parse', '--abbrev-ref', 'HEAD');
  } catch { /* not a git checkout */ }
  return { version: pkg.version || '0.0.0', commit, date, branch, electron: process.versions.electron || '' };
}

async function upstreamOf() {
  const u = await git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}');
  return u.code === 0 ? u.out : '';
}

async function check() {
  if (!fs.existsSync(path.join(repo, '.git'))) return { ok: false, error: 'Not a git checkout: nothing to update from' };
  const up = await upstreamOf();
  if (!up) return { ok: false, error: 'This branch follows no remote branch (git branch --set-upstream-to)' };
  const remote = up.split('/')[0];
  const f = await run('git', ['fetch', '--quiet', remote], { timeout: 90000 });
  if (f.code !== 0) return { ok: false, error: `Couldn't reach ${remote}: ${f.err.split('\n').pop()}` };
  const behind = +(await git('rev-list', '--count', `HEAD..${up}`)).out || 0;
  const ahead = +(await git('rev-list', '--count', `${up}..HEAD`)).out || 0;
  const log = behind ? (await git('log', '--format=%h%x09%cs%x09%s', '-n', '10', `HEAD..${up}`)).out : '';
  const newest = log ? log.split('\n').map((l) => { const [commit, date, ...s] = l.split('\t'); return { commit, date, subject: s.join('\t') }; }) : [];
  const dirty = (await git('status', '--porcelain', '--untracked-files=no')).out.split('\n').filter(Boolean).length;
  return { ok: true, available: behind > 0, behind, ahead, newest, upstream: up, dirty, checkedAt: Date.now(),
    // Ahead too: both have commits the other lacks, so a fast-forward can't happen
    canUpdate: behind > 0 && ahead === 0 };
}

async function update(appDir) {
  const from = (await git('rev-parse', 'HEAD')).out;
  const c = await check();
  if (!c.ok) return c;
  if (!c.available) return { ok: true, from, to: from, nothing: true };
  if (c.ahead) return { ok: false, error: `This copy has ${c.ahead} commit${c.ahead === 1 ? '' : 's'} the remote doesn't: push or rebase first (it won't merge for you)` };
  const p = await run('git', ['pull', '--ff-only', '--quiet'], { timeout: 180000 });
  if (p.code !== 0) return { ok: false, error: `git pull: ${(p.err || p.out).split('\n').slice(-2).join(' ')} (your uncommitted changes are untouched)` };
  const to = (await git('rev-parse', 'HEAD')).out;
  // The app's packages changed: install them before it starts again
  const rel = path.relative(repo, appDir) || '.';
  const changed = (await git('diff', '--name-only', from, to, '--', `${rel}/package.json`, `${rel}/package-lock.json`)).out;
  let npm = '';
  if (changed) {
    const n = await run('npm', ['install', '--no-audit', '--no-fund'], { cwd: appDir, timeout: 600000 });
    npm = n.code === 0 ? 'installed' : `npm install failed: ${n.err.split('\n').pop()}`;
  }
  // A new Electron needs the app made again (tools/install-apps.sh); the repo's npm start is fine
  const oldPkg = (await git('show', `${from}:${rel}/package.json`)).out;
  const newPkg = readJson(path.join(appDir, 'package.json')) || {};
  let electronChanged = false;
  try { electronChanged = JSON.parse(oldPkg).devDependencies.electron !== newPkg.devDependencies.electron; } catch { /* no old one */ }
  return { ok: true, from: from.slice(0, 7), to: to.slice(0, 7), npm, electronChanged };
}

// The app's own code as it is on disk: every .js, .html, .css and .json in its folder (not
// node_modules), and this file. A stamp per file, so it can say which changed.
function codeFiles(appDir) {
  const out = [path.join(__dirname, 'app-update.js')];
  const walk = (d, depth) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(f, depth + 1);
      else if (/\.(js|html|css|json)$/.test(e.name) && e.name !== 'package-lock.json') out.push(f);
    }
  };
  walk(appDir, 0);
  return out;
}
function stampOf(files) {
  const crypto = require('crypto');
  const m = new Map();
  for (const f of files) {
    try { m.set(f, crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex')); } catch { m.set(f, 'gone'); }
  }
  return m;
}
function watchCode(appDir) {
  const start = stampOf(codeFiles(appDir));
  return {
    // The files that differ from what the app started with (new files too)
    changed() {
      const now = stampOf(codeFiles(appDir));
      const diff = [];
      for (const [f, h] of now) if (start.get(f) !== h) diff.push(path.relative(repo, f));
      for (const f of start.keys()) if (!now.has(f)) diff.push(path.relative(repo, f));
      return diff;
    },
  };
}

module.exports = { version, check, update, watchCode, repo };
