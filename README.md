# Incarnate Shard Admin

A desktop app (Electron) for running the local shard: every server's status, live logs,
alerts, start/stop/restart, builds, settings, optimizations and staff access, in one window.

## Start it

Shard Admin runs a shard from an [Incarnate](https://github.com/Daggenthal/Incarnate) checkout. Clone both side by side:

```
git clone https://github.com/Daggenthal/Incarnate.git
git clone https://github.com/Daggenthal/Incarnate-Shard-Admin.git
Incarnate-Shard-Admin/start.sh
```

The first run installs Electron (Node.js 20 or newer needed). Shard Admin finds the Incarnate folder by itself when it sits next to it, or in `~/src/Incarnate`, `~/Incarnate` or `~/Documents/Incarnate`. Anywhere else: set `INCARNATE_REPO=/path/to/Incarnate`, or pick the folder when it asks; the choice is remembered. By hand: `npm install && npm start`.

**Where it runs**
- **Linux and macOS:** the full app. The shard runs on this computer (the servers and SQL Server in containers), or on another machine (Machines, below).
- **Windows:** start it with `start.cmd`. It runs and manages a shard on a Linux machine over ssh (Machines); a shard on Windows itself isn't supported yet, because the Incarnate server tools are shell scripts.

Paths like `tools/db-up.sh` below are in the Incarnate checkout.

The shard keeps running when you close the window. Open the app again and it picks the
running servers back up. **Stop shard** stops everything.

## What's in it

**Top bar**
- **N/M servers up:** Servers that finished starting, out of the ones this shard runs (the
  DBServer, the Launcher, and every AppName in `loadBalanceShardSpecific.cfg` except map
  servers). Under it: total CPU and RAM of every shard process.
- **Start shard:** SQL Server (`tools/db-up.sh`), then the DBServer, then the Launcher as
  soon as the DBServer waits for it. The Launcher starts the other servers.
- **Stop shard / Restart all**
- **Restart updated:** Restarts only the servers running an older build than the one on
  disk (the `restart` tags; the badge counts them), so the rest of the shard keeps going.
  The DBServer starts them again within a minute. Map servers on an old build are stopped
  too, and start again when a player needs that zone (players on them go back to the
  login screen). If the DBServer or the Launcher changed, that still needs Restart all.
- **Build changed:** Builds only the servers whose code changed since their last build. The
  badge counts them, and a server with changes shows an `update` tag. The app checks a few
  seconds after you save a source file, and every 5 minutes.
- **Build all:** Every server target.
- **Build client:** The game client (`build-mingw`), then staged into `build-mingw/dist`
  (`tools/stage-client.sh`), where Start client and the launcher run it. Build all doesn't
  include the client.
- **Back up DB:** Copies every `coh*` database to `.local/backups/<date>/`.
- **Start client:** `tools/run-client.sh`.
- **Auto / Light / Dark:** The theme. Auto follows the system.

**Servers (left)**
- Green: up. Yellow, pulsing: running but still starting. Gray: not running.
- `update`: The code changed since this server was built. `restart`: A newer build is
  on disk than the one running; restart it to use the new build.
- Click one to see its log.
- Running maps and beacon processes are listed under the servers, one row each, with
  a **stop** link. The DBServer starts maps again when a player needs one.

**Logs:** Live, colored the same as the terminal tools (red errors, yellow warnings, green
success, cyan stack frames). There's a filter box and an "errors and warnings only" switch.
**Clear** empties the view (the file stays as it is; only new lines show), and every build starts
on an empty Build log, so a finished build shows only its own output.
**Restart** works for the selected server:
- The DBServer: restarts the whole shard.
- The Launcher: restarts with everything it started.
- Any other server: it is stopped and the DBServer starts it again within a minute.

**Alerts:** Crashes, AddressSanitizer reports, failed asserts, database errors, fatal
start errors, and any server that was up and stopped. Each alert also shows as a desktop
notification (it can be turned off in Settings). Click one to open its log.

**Activity:** What the app did (starts, stops, builds, backups) and when.

**Optimizations:** The server switches, with what the running shard started with.
Changing one shows "Restart all to apply". The client's optimizations are listed with
the chat commands that switch them.

**Settings:**
- `servers.cfg`: Shard name, IPs, max players and level, XP/influence/prestige rates, and
  the default access level (with a warning when it is above 0).
- `ServerListConfig.txt`: The server list the client shows.
- This app: Start SQL with the shard, notifications, and the build folder.

**Tracker:** Two collapsible lists. **Things to test** comes from `docs/TESTING.md`;
ticking one here saves `[x]` there. **To do** is the To Do list in `docs/CHANGES.md`.
Both live in the repo, so they stay current as the work lands. The tab's badge counts
the open tests.

**Staff:**
- Staff accounts (`StaffAccount` in `servers.cfg`): Add, change or remove.
- Characters: Search by character or account name, filter by access level (11 by
  default), and set a character's access level. Setting a level needs the shard stopped,
  because the DBServer would write its own copy back.

## How it knows what it knows

- **Up:** Each server writes `src/bin/logs/servers/<Name>.ready` (its process id) when it
  finishes starting, and removes it at exit (`incServerReady` in UtilitiesLib).
- **Logs:** The DBServer and Launcher log to `.local/DBServer.out` and `.local/Launcher.out`
  (`tools/run-server.sh`). The app sets `INCARNATE_SERVER_LOG_DIR=.local/servers`, so
  everything the Launcher starts gets its own file there: `ChatServer.out`, `MapServer-1.out`
  (map id 1), `MapServer-standby.out`, and so on (the POSIX layer's `CreateProcess`).
- **Changes to build:** ninja's explain output names the objects whose source or header
  changed. Each object belongs to a server, or to a library that the server links.
- **Settings and switches:** `.local/shard-admin.json`. What the running shard started
  with is in `.local/shard-admin-applied.json`.

From a terminal, the same checks run without the window:

```
node backend.js status     # servers up, one line each
node backend.js outdated   # which servers have changes to build
node backend.js chars Test # characters matching "Test"
node backend.js backup     # back up the databases
```

## Shards

**Shards** in the sidebar: the shard under the name players pick in the game (Freedom). Click it
(or right-click, **Show Services**) for its page. Its **Services** tab shows what it's doing
while it starts or restarts (servers up out of how many, the step it's on), every server (up,
starting, down, or crashed or stopped and when) with Restart and Log, the map servers with Stop
and Log, the Global ones, and what happened lately. Its **Zones and players** tab shows the
zones and who is where. Log in at the top (Login for Controls) with a staff account and pick its
character. Click a player to teleport them (out of a mission, to any zone, to another
player), unstuck, freeze, kick or block them, bring them to your character, or go to them
invisibly. `docs/BROADCAST.md`.

## Memory errors

Every server prints its stack when it crashes (with function names). With **Debug build** on
(Optimizations), the servers also run with AddressSanitizer: every bad memory read or write is
reported with its stack, and the server keeps going. Alerts, **Copy crashes and memory
errors** gathers every crash and report from every log, counts each bug once, copies them, and
saves them to `.local/memory-errors.txt`.

## Admin Messages

The **Messages** tab sends a message every player online sees (red, in every chat tab), and
schedules messages and restarts, once or repeating. **Restart all** asks whether to warn
players first (now, or 1 to 60 minutes with a countdown in chat), then saves every map before
it stops anything. `docs/BROADCAST.md`.

## Crash restarts

A DBServer, Launcher or AuthServer that stops on its own is started again, at most 3 times in
10 minutes; after that it stays down and alerts, since a crash loop needs a look. The DBServer
brings the other services back itself. Settings, This app, turns it off.

The crash is in the run before: each start keeps the last log as `.local/DBServer.prev.out`
(and the Launcher's, the AuthServer's). The sidebar's "DBServer, previous run" shows it, and
every server prints its stack when it crashes, with function names. **Copy crashes and memory
errors** in Alerts gathers them all.

## Real accounts

With **Fake auth** off (Optimizations), the AuthServer runs with the shard (first in the server
list) and players log in with real accounts: the Staff tab's **Accounts** section makes them,
changes passwords and blocks them. Start client logs in through the AuthServer then.
`docs/AUTH.md`.

## Machines (a shard on another computer)

Pick a machine at the top (under the title) and the window shows and controls the shard there:
the same buttons, logs, alerts and settings. Add one in the **Machines** tab (an ssh target
like `deck@192.168.1.50`); the tab has the first-time steps in order (ssh key, set up, game
data). It goes through an ssh tunnel to a small control service on the machine (127.0.0.1
only, with a token), so nothing new is open on the network. `INCARNATE_DEBUG=1` prints the
connection's steps. Details: `docs/REMOTE_SHARD.md`.

The top of the Machines tab shows the picked machine: CPU over all its cores, how many cores
the shard keeps busy (100% CPU is one core, so 125% is 1.25), load average, RAM and the shard's
share of it, swap, disk, CPU temperature, and on Linux how long processes waited for a core,
memory or the disk (pressure, where lag shows first), plus the busiest shard processes.

## Other shards on the machine

The top bar's **Start Global** starts what every shard shares, SQL Server and the AuthServer;
**Stop All** stops every shard and those. A shard starts from the sidebar: double-click it when
it's stopped, or right-click it for Start, Restart, Stop and the rest (Freedom's Stop leaves the
AuthServer and SQL Server up for the other shards). Right-click a server for its log and Restart.

Server Applications is split into **Global** (shared by every shard: the AuthServer and SQL
Server) and **Local** (this shard's own). Under Shards, each other shard (Justice, Pinnacle...,
`docs/SHARDS.md`) has the same page: Services (its container too) and Crash reports.

## Names: ours and the original's

Where the original tools (ServerMonitor, ShardMonitor, the game's staff commands) had a name,
Shard Admin uses it, so anyone who ran a CoH shard knows what a button is. Each player
action's tooltip names the command it runs.

| In Shard Admin | Original | Where it comes from |
|---|---|---|
| Server Applications | Server Applications | ServerMonitor |
| Shard Configuration | Shard Configuration | ServerMonitor |
| Admin Messages, Send Admin Message | Send Admin Message | ServerMonitor |
| map xfer (a player loading into a map) | Players in map xfer | ServerMonitor |
| Kill mapserver N | Kill Mapservers | ServerMonitor |
| Delink | Delink | ServerMonitor |
| Overload Protection, Back to automatic | Overload Protection | ServerMonitor |
| Reset Mission Link | Reset Mission Link | ServerMonitor |
| connected, logging in, in the queue, SQL queue, launchers | the same columns | ServerMonitor |
| Chat tab | ChatAdmin | ChatAdmin (docs/CHAT_ADMIN.md) |
| Delete channel, Silence, Rename, Let them rename, Send to all | CsrChanKill, CsrSilence, CsrName, CsrGrantRename, CsrSendAll | ChatServer commands |
| Send to zone | `/mapmove` | MapServer command |
| Send to player, Spectate Player | `/goto` (with `/invisible`) | MapServer command |
| Bring them to me | `/teleport` | MapServer command |
| Freeze, Unfreeze | `/freeze` | MapServer command |
| Kick | `/svrkick` | MapServer command |
| Unstuck | `/stuck` | MapServer command |
| Database Server | DBServer (the program's name; its tooltip and log files keep it) | the original source |
| Shard, Launcher, map server | the same | the original source |

Ours, with no original: Shard Admin itself, Login for Controls, Spectate Player (the action),
the Staff Panel in the game (the original had only commands, by access level), and Things to
test.

## Updates

Shard Admin's updates are this repository's: newer commits on
the branch it follows. Settings, Software shows the Software Version (the app's version and the commit it
runs), **Check for Updates**, and **Automatically check for updates**, which checks once at
launch (on unless you turn it off). When there are newer commits, **Update Available** shows
under the title; clicking it pulls them (`git pull --ff-only`: nothing is merged, your
uncommitted changes stay), runs `npm install` if the app's packages changed, and restarts the
app on the new code. A copy with commits the remote doesn't have can't fast-forward: push
first. If the update changes the Electron version, `npm install` runs again on the next start. git
never asks for a password here: it uses what your keychain or ssh agent already has.

It also notices newer code already on disk than the window runs (a sync, an edit, a pull in a
terminal; looked at every 15 seconds while Automatically check is on): Update Available then
just restarts Shard Admin on it, no pull.


## License

MIT. See [LICENSE](LICENSE). City of Heroes and its data belong to NCSoft and are not covered.
