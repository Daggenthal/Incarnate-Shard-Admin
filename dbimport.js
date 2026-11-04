// Database import: another server's SQL Server backups (any I24-based shard)
// into this shard's SQL Server container, without losing anything on either side.
//
//   tools/db-import.sh <folder of .bak files> [--dry-run] [--quick] [--force] [--map Name=cohdb]
//   tools/db-import.sh rollback <stamp>
//
// The order, and why:
//   1. Read each backup's header: a full backup, of a SQL Server no newer than this one.
//   2. RESTORE VERIFYONLY (WITH CHECKSUM when the backup has checksums): the file is whole.
//   3. Room: the restored size plus a margin has to fit next to what's there.
//   4. A backup of this shard's own databases (Back up DB), so the import can be undone.
//   5. Restore each one under a staging name (incimp_<name>), never over a live database.
//   6. DBCC CHECKDB on the staging copy (--quick skips it on very large databases).
//   7. Schema: tables and columns compared with this shard's own database. Missing ones stop
//      the import (these servers would fail on them) unless --force; extra ones are kept.
//   8. Row counts per table, compared with rowcounts.tsv from the other server when it's there
//      (tools/db-export.sql makes the backups and that file).
//   9. Only then, with the shard stopped: this shard's database is renamed to
//      <name>_before_<stamp> (kept, never dropped), and the staging copy takes its name.
//  10. Row counts again, and a report in .local/imports/<stamp>/.
// --dry-run does 1 to 8 and drops the staging copies. rollback <stamp> puts the old ones back
// (the imported ones are kept as <name>_imported_<stamp>). Nothing here ever drops a database
// that held data.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// The databases I24's servers use
const KNOWN = ['cohdb', 'cohchat', 'cohauc', 'cohacc', 'cohauth'];
const NAME_RE = /^[A-Za-z0-9_]{1,100}$/;
const q = (s) => String(s).replace(/'/g, "''"); // inside N'...'

class DbImport {
  constructor(shard, { repo, local, containerCmd, PATH }) {
    this.shard = shard;
    this.repo = repo;
    this.local = local;
    this.containerCmd = containerCmd;
    this.PATH = PATH;
  }

  say(text, level = 'info') { this.shard.progress(text, level); this.lines.push(`${level === 'info' ? '' : `[${level}] `}${text}`); }

  // A query whose result has a header row: rows as objects
  async table(query, db = 'master') {
    const r = await this.shard.sql(query, db, { header: true });
    if (!r.ok) throw new Error(r.error);
    const [head, ...rest] = r.rows;
    if (!head) return [];
    const body = rest.filter((row) => !row.every((c) => /^-*$/.test(c)));
    return body.map((row) => Object.fromEntries(head.map((h, i) => [h, row[i]])));
  }

  async exec(query, db = 'master') {
    const r = await this.shard.sql(query, db);
    if (!r.ok) throw new Error(r.error);
    return r.rows;
  }

  container(args, input) {
    const [c, ...pre] = this.containerCmd();
    return new Promise((resolve) => {
      const ch = spawn(c, [...pre, ...args], { env: { ...process.env, PATH: this.PATH } });
      let out = '';
      ch.stdout.on('data', (d) => { out += d; });
      ch.stderr.on('data', (d) => { out += d; });
      if (input) fs.createReadStream(input).pipe(ch.stdin); else ch.stdin.end();
      ch.on('close', (code) => resolve({ ok: code === 0, out }));
      ch.on('error', (e) => resolve({ ok: false, out: e.message }));
    });
  }

  // Exact counts (COUNT_BIG on every table), the same way tools/db-export.sql counts there
  async rowCounts(db) {
    const tables = await this.table(`SELECT s.name AS sch, t.name AS tbl FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE t.is_ms_shipped = 0 ORDER BY 1, 2`, db);
    const out = {};
    for (let i = 0; i < tables.length; i += 50) {
      const part = tables.slice(i, i + 50).map((t) => `SELECT N'${q(t.sch)}.${q(t.tbl)}' AS tbl, COUNT_BIG(*) AS n FROM [${t.sch.replace(/]/g, ']]')}].[${t.tbl.replace(/]/g, ']]')}]`);
      for (const r of await this.table(part.join(' UNION ALL '), db)) out[r.tbl] = Number(r.n);
    }
    return out;
  }

  async columns(db) {
    const rows = await this.table(`SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS tbl, COLUMN_NAME AS col, DATA_TYPE AS type
      FROM INFORMATION_SCHEMA.COLUMNS ORDER BY 1, 2`, db);
    const out = {};
    for (const r of rows) (out[r.tbl] ||= {})[r.col] = r.type;
    return out;
  }

  async exists(db) {
    const r = await this.exec(`SELECT DB_ID(N'${q(db)}')`);
    return !!(r[0] && /^\d+$/.test(r[0][0]));
  }

  // ---- The import ----

  async run(dir, opts = {}) {
    const { dryRun = false, quick = false, force = false, map = {} } = opts;
    this.lines = [];
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const outDir = path.join(this.local, 'imports', stamp);
    fs.mkdirSync(outDir, { recursive: true });
    const report = { stamp, dir: path.resolve(dir), dryRun, quick, force, databases: [], ok: false };
    const staged = [];
    let swapping = false;
    try {
      const full = path.resolve(this.repo, dir);
      let files = [];
      try { files = fs.readdirSync(full).filter((f) => /\.bak$/i.test(f)).sort(); } catch { /* none */ }
      if (!files.length) throw new Error(`No .bak files in ${full}`);
      this.say(`Import ${dryRun ? '(dry run) ' : ''}from ${full}: ${files.join(', ')}`);

      if (!dryRun && (await this.shard.listProcesses()).some((p) => p.name === 'DBServer')) {
        throw new Error('Stop the shard first, or --stop-shard (Shard Admin: "Stop the shard for the import"). A dry run works with it running');
      }
      const ours = Number((await this.exec("SELECT SERVERPROPERTY('ProductMajorVersion')"))[0][0]);
      const freeOut = await this.container(['exec', 'incarnate-mssql', 'df', '-Pk', '/var/opt/mssql']);
      let freeBytes = Infinity;
      const fm = freeOut.out.trim().split('\n').pop().split(/\s+/);
      if (freeOut.ok && fm[3] && /^\d+$/.test(fm[3])) freeBytes = Number(fm[3]) * 1024;

      // Counts from the other server, when it sent them (tools/db-export.sql)
      const theirCounts = {};
      const countsFile = path.join(full, 'rowcounts.tsv');
      if (fs.existsSync(countsFile)) {
        for (const line of fs.readFileSync(countsFile, 'utf8').split('\n')) {
          const [db, tbl, n] = line.trim().split('\t');
          if (db && tbl && /^\d+$/.test(n || '')) (theirCounts[db.toLowerCase()] ||= {})[tbl] = Number(n);
        }
        this.say(`rowcounts.tsv: counts for ${Object.keys(theirCounts).join(', ')}`);
      } else {
        this.say('No rowcounts.tsv next to the backups: counts are recorded, not compared (tools/db-export.sql makes it)', 'warn');
      }

      // 1 to 3: read, verify, size
      const plan = [];
      let needBytes = 0;
      const inside = `/var/opt/mssql/import-${stamp}`;
      const mk = await this.container(['exec', 'incarnate-mssql', 'mkdir', '-p', inside]);
      if (!mk.ok) throw new Error(`Couldn't make ${inside} in the container: ${mk.out.trim()}`);
      for (const f of files) {
        const src = path.join(full, f);
        const bak = `${inside}/${f.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        this.say(`${f}: copying into the SQL Server container (${(fs.statSync(src).size / 1e6).toFixed(0)} MB)`);
        // Through stdin, so the copy belongs to SQL Server's user there (docker cp keeps the owner)
        const cp = await this.container(['exec', '-i', 'incarnate-mssql', 'sh', '-c', `cat > '${bak}'`], src);
        if (!cp.ok) throw new Error(`${f}: copy failed: ${cp.out.trim()}`);
        const heads = await this.table(`RESTORE HEADERONLY FROM DISK = N'${q(bak)}'`);
        if (!heads.length) throw new Error(`${f}: not a SQL Server backup`);
        if (heads.length > 1) this.say(`${f}: ${heads.length} backups in one file; using the last one`, 'warn');
        const h = heads[heads.length - 1];
        const position = Number(h.Position || heads.length);
        if (h.BackupType !== '1') throw new Error(`${f}: a ${({ 2: 'log', 5: 'differential' })[h.BackupType] || `type ${h.BackupType}`} backup; only full backups import (BACKUP DATABASE ... WITH COPY_ONLY)`);
        if (Number(h.SoftwareVersionMajor) > ours) throw new Error(`${f}: from SQL Server version ${h.SoftwareVersionMajor}, newer than this one (${ours}); it can't be restored here`);
        const source = h.DatabaseName;
        const target = (map[source] || map[source.toLowerCase()] || KNOWN.find((k) => k === source.toLowerCase())
          || KNOWN.find((k) => k === path.basename(f, path.extname(f)).toLowerCase()) || '').toLowerCase();
        if (!target) { this.say(`${f}: database "${source}" isn't one these servers use (${KNOWN.join(', ')}); skipped. --map ${source}=<name> to import it`, 'warn'); continue; }
        if (!NAME_RE.test(target)) throw new Error(`--map: "${target}" isn't a plain database name`);
        if (plan.some((p) => p.target === target)) throw new Error(`Two backups for ${target}`);
        const checksums = h.HasBackupChecksums === '1';
        this.say(`${f}: ${source} -> ${target}, backed up ${h.BackupFinishDate}, SQL Server ${h.SoftwareVersionMajor}, ${checksums ? 'with checksums' : 'no checksums'}`);
        this.say(`${f}: verifying the backup`);
        await this.exec(`RESTORE VERIFYONLY FROM DISK = N'${q(bak)}' WITH FILE = ${position}${checksums ? ', CHECKSUM' : ''}`);
        if (!checksums) this.say(`${f}: readable, but without checksums its pages can't be checked until CHECKDB`, 'warn');
        const filelist = await this.table(`RESTORE FILELISTONLY FROM DISK = N'${q(bak)}' WITH FILE = ${position}`);
        const size = filelist.reduce((a, x) => a + Number(x.Size || 0), 0);
        needBytes += size;
        plan.push({ file: f, bak, position, source, target, checksums, filelist, size, backupDate: h.BackupFinishDate });
      }
      if (!plan.length) throw new Error('Nothing to import');
      const margin = needBytes * 0.15 + 512e6;
      this.say(`Room: ${(needBytes / 1e9).toFixed(2)} GB restored, ${(freeBytes / 1e9).toFixed(2)} GB free in the SQL Server volume`);
      if (needBytes + margin > freeBytes) throw new Error(`Not enough room: needs ${((needBytes + margin) / 1e9).toFixed(2)} GB free, has ${(freeBytes / 1e9).toFixed(2)} GB`);

      // 4: this shard's own databases first
      if (!dryRun) {
        this.say('Backing up this shard\'s databases first');
        this.shard.busy = null;
        const b = await this.shard.backup();
        if (!b.ok) throw new Error(`The backup of this shard's databases failed: ${b.error}. Nothing was changed.`);
        report.ourBackup = b.dir;
        this.say(`This shard's databases are in ${path.relative(this.repo, b.dir)}`, 'ok');
        this.shard.busy = 'importing';
      }

      // 5 to 8: staging copies, checked
      let problems = 0;
      for (const p of plan) {
        const stage = `incimp_${p.target}`;
        if (await this.exists(stage)) throw new Error(`${stage} is already there (an earlier import that stopped?). Drop it by hand after a look: DROP DATABASE [${stage}]`);
        const moves = p.filelist.map((x, i) => {
          const ext = x.Type === 'L' ? 'ldf' : i === 0 ? 'mdf' : 'ndf';
          return `MOVE N'${q(x.LogicalName)}' TO N'/var/opt/mssql/data/${stage}_${stamp}_${i}.${ext}'`;
        }).join(', ');
        this.say(`${p.target}: restoring under ${stage}`);
        await this.exec(`RESTORE DATABASE [${stage}] FROM DISK = N'${q(p.bak)}' WITH FILE = ${p.position}, ${moves}${p.checksums ? ', CHECKSUM' : ''}, RECOVERY, STATS = 25`);
        staged.push(stage);
        const entry = { target: p.target, source: p.source, file: p.file, backupDate: p.backupDate, stage };
        report.databases.push(entry);
        if (!quick) {
          this.say(`${p.target}: DBCC CHECKDB (can take a while)`);
          await this.exec(`DBCC CHECKDB ([${stage}]) WITH NO_INFOMSGS, ALL_ERRORMSGS`);
          this.say(`${p.target}: CHECKDB clean`, 'ok');
          entry.checkdb = 'clean';
        } else entry.checkdb = 'skipped (--quick)';

        // Schema against this shard's own database
        const theirs = await this.columns(stage);
        if (await this.exists(p.target)) {
          const mine = await this.columns(p.target);
          const missingTables = Object.keys(mine).filter((t) => !theirs[t]);
          const missingCols = [];
          const typeDiffs = [];
          for (const [t, cols] of Object.entries(mine)) {
            if (!theirs[t]) continue;
            for (const [c, type] of Object.entries(cols)) {
              if (!(c in theirs[t])) missingCols.push(`${t}.${c}`);
              else if (theirs[t][c] !== type) typeDiffs.push(`${t}.${c} (${theirs[t][c]}, here ${type})`);
            }
          }
          const extraTables = Object.keys(theirs).filter((t) => !mine[t]);
          entry.schema = { missingTables, missingColumns: missingCols, typeDifferences: typeDiffs, extraTables };
          if (extraTables.length) this.say(`${p.target}: ${extraTables.length} tables these servers don't use (kept): ${extraTables.slice(0, 8).join(', ')}${extraTables.length > 8 ? ', ...' : ''}`, 'warn');
          if (typeDiffs.length) this.say(`${p.target}: ${typeDiffs.length} columns with another type: ${typeDiffs.slice(0, 5).join(', ')}`, 'warn');
          if (missingTables.length || missingCols.length) {
            const what = [...missingTables.map((t) => `table ${t}`), ...missingCols].slice(0, 10).join(', ');
            this.say(`${p.target}: missing what these servers use: ${what}${missingTables.length + missingCols.length > 10 ? ', ...' : ''}`, force ? 'warn' : 'error');
            if (!force) problems++;
          } else this.say(`${p.target}: every table and column these servers use is there`, 'ok');
        } else {
          entry.schema = 'not compared: no database by that name here yet';
          this.say(`${p.target}: nothing here to compare its schema with (start the shard once to make one)`, 'warn');
        }

        // Counts
        entry.rows = await this.rowCounts(stage);
        const total = Object.values(entry.rows).reduce((a, n) => a + n, 0);
        const theirsN = theirCounts[p.source.toLowerCase()] || theirCounts[p.target];
        if (theirsN) {
          const diffs = Object.entries(theirsN).filter(([t, n]) => (entry.rows[t] ?? entry.rows[`dbo.${t}`]) !== n);
          entry.countDiffs = diffs.map(([t, n]) => `${t}: ${n} there, ${entry.rows[t] ?? entry.rows[`dbo.${t}`] ?? 'missing'} here`);
          if (diffs.length) { this.say(`${p.target}: row counts differ from rowcounts.tsv: ${entry.countDiffs.slice(0, 5).join('; ')}`, 'error'); problems++; }
          else this.say(`${p.target}: ${total} rows in ${Object.keys(entry.rows).length} tables, matching the other server's counts`, 'ok');
        } else this.say(`${p.target}: ${total} rows in ${Object.keys(entry.rows).length} tables`);
      }

      if (problems) throw new Error(`${problems} problem(s) above. Nothing here was changed; the staging copies are dropped. --force imports despite schema differences`);
      if (dryRun) {
        this.say('Dry run: everything checks out. Run again without --dry-run (shard stopped) to import.', 'ok');
        report.ok = true;
        return report;
      }

      // 9 and 10: the swap. From here a failure leaves the staging copies alone (they may be
      // the only copy under that name); rollback sorts it out
      swapping = true;
      for (const e of report.databases) {
        if (await this.exists(e.target)) {
          e.previous = `${e.target}_before_${stamp}`;
          await this.exec(`ALTER DATABASE [${e.target}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
            ALTER DATABASE [${e.target}] MODIFY NAME = [${e.previous}]; ALTER DATABASE [${e.previous}] SET MULTI_USER;`);
          this.say(`${e.target}: this shard's copy kept as ${e.previous}`);
        }
        await this.exec(`ALTER DATABASE [${e.stage}] MODIFY NAME = [${e.target}]`);
        staged.splice(staged.indexOf(e.stage), 1);
        const after = await this.rowCounts(e.target);
        const same = JSON.stringify(after) === JSON.stringify(e.rows);
        this.say(`${e.target}: imported${same ? ', row counts the same after the switch' : ', but the row counts changed after the switch (look at the report)'}`, same ? 'ok' : 'error');
      }
      report.ok = true;
      this.say(`Import done. Undo: tools/db-import.sh rollback ${stamp}. Start the shard and log in to check.`, 'ok');
      return report;
    } catch (e) {
      this.say(e.message, 'error');
      if (swapping) {
        report.switchFailed = true;
        this.say(`It stopped while switching databases: nothing was dropped. tools/db-import.sh rollback ${stamp} puts this shard's back`, 'error');
      }
      report.error = e.message;
      return report;
    } finally {
      if (!swapping) for (const s of staged) {
        // Only the staging copies this run made, which never held anyone's live data
        try { await this.exec(`ALTER DATABASE [${s}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${s}]`); } catch { /* reported below */ }
      }
      await this.container(['exec', 'incarnate-mssql', 'rm', '-rf', `/var/opt/mssql/import-${stamp}`]);
      fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
      fs.writeFileSync(path.join(outDir, 'report.txt'), `${this.lines.join('\n')}\n`);
      report.reportDir = outDir;
      this.shard.progress(`Import report: ${path.relative(this.repo, outDir)}/report.txt`, report.ok ? 'ok' : 'warn');
    }
  }

  // Put this shard's databases from before an import back. The imported ones stay, renamed.
  async rollback(stamp) {
    this.lines = [];
    if (!/^\d{14}$/.test(stamp || '')) return { ok: false, error: 'rollback <stamp>: the import\'s folder name in .local/imports' };
    if ((await this.shard.listProcesses()).some((p) => p.name === 'DBServer')) return { ok: false, error: 'Stop the shard first' };
    try {
      const rows = await this.exec(`SELECT name FROM sys.databases WHERE name LIKE '%[_]before[_]${stamp}'`);
      const names = rows.map((r) => r[0]).filter((n) => NAME_RE.test(n));
      if (!names.length) throw new Error(`No databases from before import ${stamp}`);
      for (const before of names) {
        const target = before.replace(`_before_${stamp}`, '');
        if (await this.exists(target)) {
          await this.exec(`ALTER DATABASE [${target}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
            ALTER DATABASE [${target}] MODIFY NAME = [${target}_imported_${stamp}]; ALTER DATABASE [${target}_imported_${stamp}] SET MULTI_USER;`);
        }
        await this.exec(`ALTER DATABASE [${before}] MODIFY NAME = [${target}]`);
        this.say(`${target}: back to before the import (the imported copy is ${target}_imported_${stamp})`, 'ok');
      }
      return { ok: true };
    } catch (e) {
      this.say(e.message, 'error');
      return { ok: false, error: e.message };
    }
  }
}

module.exports = { DbImport, KNOWN };
