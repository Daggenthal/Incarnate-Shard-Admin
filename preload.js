// The only bridge between the window and the shard: named calls and the event streams
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const calls = ['info', 'status', 'start', 'stop', 'restartAll', 'restart', 'stopPid', 'build', 'buildChanged',
  'checkOutdated', 'configure', 'readLog', 'logKeys', 'readCfg', 'writeCfg', 'writeServerList', 'setStaff',
  'characters', 'setCharacterAccess', 'setSettings', 'backup', 'startClient', 'reveal', 'openRepoPath', 'setTheme', 'readTracker', 'setTestDone', 'stopClient', 'restartUpdated', 'writeGrants', 'buildClient',
  'writeManifest', 'target', 'machines', 'useTarget', 'saveMachine', 'deleteMachine', 'machineStep', 'machineTerminal', 'pickFolder', 'importDatabases', 'importRollback', 'accounts', 'setAccount', 'copyText',
  'startGlobal', 'stopAll', 'stopShard', 'appVersion', 'appCheckUpdate', 'appSetAutoUpdate', 'appUpdate', 'broadcast', 'overview', 'memoryErrors', 'playerAction', 'serverAction', 'extraShards', 'extraShardAction', 'extraShardLog', 'chatLogin', 'chatLogout', 'chatPoll', 'chatRun', 'zones', 'staffSignIn', 'staffSignOut', 'staffCharacters', 'staffPick', 'ghostTo', 'cancelRestart', 'schedules', 'saveSchedule', 'deleteSchedule'];

const api = {};
for (const c of calls) api[c] = (arg) => ipcRenderer.invoke(c, arg);
for (const ev of ['status', 'log', 'progress', 'alert', 'focus-log', 'target', 'app-update'])
  api[`on${ev.replace(/(^|-)(\w)/g, (_, __, ch) => ch.toUpperCase())}`] = (fn) => ipcRenderer.on(ev, (_e, d) => fn(d));

contextBridge.exposeInMainWorld('shard', api);
