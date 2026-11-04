// Finds the Incarnate checkout this app runs (the servers, tools/*.sh and the build folders all
// live there). In order: INCARNATE_REPO, the folder picked last time, then the usual places.
// The first folder that has tools/run-server.sh and src/ wins.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const cfgDir = path.join(
  process.env.XDG_CONFIG_HOME ||
    (process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32' ? (process.env.APPDATA || home) : path.join(home, '.config')),
  'incarnate-shard-admin');
const cfgFile = path.join(cfgDir, 'incarnate-repo.txt');

const isRepo = (d) => !!d && fs.existsSync(path.join(d, 'tools', 'run-server.sh')) && fs.existsSync(path.join(d, 'src'));
const saved = () => { try { return fs.readFileSync(cfgFile, 'utf8').trim(); } catch { return ''; } };

function candidates() {
  return [
    process.env.INCARNATE_REPO,
    saved(),
    path.resolve(__dirname, '..', 'Incarnate'),   // next to this app: ~/src/Incarnate-Shard-Admin + ~/src/Incarnate
    path.join(home, 'src', 'Incarnate'),
    path.join(home, 'Incarnate'),
    path.join(home, 'Documents', 'Incarnate'),
    path.resolve(__dirname, '..', '..'),           // the old layout: Incarnate/tools/shard-admin
  ].filter(Boolean).map((d) => path.resolve(d));
}

function find() { return candidates().find(isRepo) || null; }

function save(dir) {
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfgFile, `${path.resolve(dir)}\n`);
}

module.exports = { find, save, isRepo, candidates, cfgFile };
