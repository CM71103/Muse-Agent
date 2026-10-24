'use strict';
// SQLite owner. No host or layer accesses connection; every mutation synchronous.
// v2 adds: deletions (logical-deletion inventory), usage (daily token
// accounting for caps), and metadata helpers used by policy/evidence versioning.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const SCHEMA_VERSION = 2;
const owners = new Set();
function openStore(dir) { return new Store(dir); }
class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(fs.realpathSync(dir), 'agent.db');
    this.lock = this.file + '.owner';
    if (owners.has(this.file)) throw new Error('Memory folder already owned. Close existing agent before opening another store.');
    try { fs.mkdirSync(this.lock); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid;
      try { pid = JSON.parse(fs.readFileSync(path.join(this.lock, 'owner.json'))).pid; } catch {}
      if (!Number.isInteger(pid)) throw new Error('Memory owner lock incomplete; verify no Muse process runs before removing ' + this.lock);
      try { process.kill(pid, 0); throw new Error('Memory folder owned by process ' + pid + '. Close it before opening another agent.'); }
      catch (err) { if (err.code !== 'ESRCH') throw err; }
      fs.rmSync(this.lock, { recursive: true });
      fs.mkdirSync(this.lock);
    }
    owners.add(this.file);
    fs.writeFileSync(path.join(this.lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    try {
      this.sql = new Database(this.file);
      this.sql.pragma('busy_timeout = 5000');
      this.sql.pragma('foreign_keys = ON');
      const version = this.sql.pragma('user_version', { simple: true });
      if (version > SCHEMA_VERSION) throw new Error('Memory schema newer than binary; upgrade Muse.');
      this.sql.pragma('journal_mode = WAL');
      if (version < 1) this.sql.transaction(() => {
        this.sql.exec(`CREATE TABLE memories(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_event_id TEXT, data TEXT NOT NULL, UNIQUE(project_id,source_event_id));
          CREATE TABLE turns(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE grades(turn_id TEXT PRIMARY KEY REFERENCES turns(id), data TEXT NOT NULL);
          CREATE TABLE projects(root TEXT PRIMARY KEY, id TEXT NOT NULL);
          CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE audit(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL);`);
        this.sql.pragma('user_version = 1');
      })();
      if (version < 2) this.sql.transaction(() => {
        // deletions: the inventory of logical removals (spec §7). Rows are kept
        // forever so listDeleted can disclose what was removed and its limits.
        this.sql.exec(`CREATE TABLE deletions(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, deleted_at TEXT NOT NULL, reason TEXT, inventory TEXT NOT NULL);`);
        // usage: per-UTC-day token accounting for embeddings + layer LLM calls
        // (daily token caps, spec §3). Turn usage lives on the turn row (host
        // billed tokens); this table tracks the LAYER's own provider spend.
        this.sql.exec(`CREATE TABLE usage(day TEXT PRIMARY KEY, embed_tokens INTEGER NOT NULL DEFAULT 0, llm_tokens INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);`);
        this.sql.pragma('user_version = 2');
      })();
      this._importLegacy(path.join(dir, 'memory.json'));
      this.sql.transaction(() => {
        for (const t of this.listTurns()) if (['prepared','sent'].includes(t.state)) {
          t.state = 'unknown'; t.fail_reason = 'restart_without_authoritative_reconciliation'; this._putTurn(t);
        }
      })();
    } catch (e) { this.close(); throw e; }
  }
  close() {
    if (this.sql && this.sql.open) this.sql.close();
    owners.delete(this.file);
    fs.rmSync(this.lock, { recursive: true, force: true });
  }
  transaction(fn) { return this.sql.transaction(fn)(); }
  audit(kind, data) { this.sql.prepare('INSERT INTO audit(kind,data) VALUES (?,?)').run(kind,JSON.stringify(data)); }
  // metadata (policy versions, centroids, decay timestamps, prompt hashes)
  getMeta(key) { const r=this.sql.prepare('SELECT value FROM metadata WHERE key=?').get(key); return r ? r.value : null; }
  setMeta(key,value) { this.sql.prepare('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); }
  bumpMeta(key,by=1) { const cur=Number(this.getMeta(key)||0); const v=(Number.isFinite(cur)?cur:0)+by; this.setMeta(key,String(v)); return v; }
  allMeta() { const o={};for(const r of this.sql.prepare('SELECT key,value FROM metadata').all())o[r.key]=r.value;return o; }
  _importLegacy(file) {
    if (this.sql.prepare("SELECT 1 FROM metadata WHERE key='legacy_import'").get()) return;
    if (!fs.existsSync(file)) return;
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(old.schema_version) || old.schema_version > 1) throw new Error('Unsupported legacy schema; original JSON unchanged.');
    this.transaction(() => {
      if (this.listAllMemories().length) throw new Error('Refusing implicit merge of legacy JSON and SQLite.');
      for (const m of Object.values(old.memories || {})) {
        // Legacy vectors lack generation provenance. Preserve content/scope, require re-embedding.
        if (m.status === 'active' && !m.generation) m.status='pending_embed';
        this.insertMemory(m);
      }
      for (const t of Object.values(old.turns || {})) this._putTurn(t);
      for (const [id,g] of Object.entries(old.grades || {})) this.sql.prepare('INSERT INTO grades VALUES (?,?)').run(id,JSON.stringify(g));
      for (const [root,id] of Object.entries(old.projects || {})) this.sql.prepare('INSERT INTO projects VALUES (?,?)').run(root,id);
      this.sql.prepare("INSERT INTO metadata VALUES ('legacy_import','done')").run();
    }); // original JSON retained, never used as journal
  }
  insertMemory(m) { this.sql.prepare('INSERT INTO memories VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,source_event_id=excluded.source_event_id,data=excluded.data').run(m.id,m.project_id,m.source_event_id || null,JSON.stringify(m)); }
  getMemory(id) { const r=this.sql.prepare('SELECT data FROM memories WHERE id=?').get(id); return r ? JSON.parse(r.data) : null; }
  listAllMemories() { return this.sql.prepare('SELECT data FROM memories').all().map(r=>JSON.parse(r.data)); }
  listMemories(pid) { return this.sql.prepare('SELECT data FROM memories WHERE project_id=?').all(pid).map(r=>JSON.parse(r.data)).sort((a,b)=>String(b.updated_at).localeCompare(String(a.updated_at))); }
  findSource(pid,id) { const r=this.sql.prepare('SELECT data FROM memories WHERE project_id=? AND source_event_id=?').get(pid,id); return r ? JSON.parse(r.data) : null; }
  patch(id, values) { const m=this.getMemory(id); if(m) this.insertMemory({...m,...values}); }
  updateStatus(id,status,updated_at) { this.patch(id,{status,updated_at}); }
  updateText(id,text,updated_at,injection_risk) { this.patch(id,{text,updated_at,injection_risk}); }
  updateEvidence(id,evidence,updated_at) { this.patch(id,{evidence,updated_at}); }
  supersede(oldId,newId,updated_at) { this.transaction(()=>{this.patch(oldId,{status:'superseded',updated_at});this.patch(newId,{supersedes:oldId,updated_at});}); }
  // ---- deletion inventory ----
  recordDeletion(d) { this.sql.prepare('INSERT INTO deletions(id,project_id,deleted_at,reason,inventory) VALUES (?,?,?,?,?)').run(d.id,d.project_id,d.deleted_at,d.reason||null,JSON.stringify(d.inventory||{})); }
  listDeletions(pid) { return this.sql.prepare('SELECT * FROM deletions' + (pid ? ' WHERE project_id=?' : '') + ' ORDER BY deleted_at DESC').all(...(pid?[pid]:[])).map(r=>({id:r.id,project_id:r.project_id,deleted_at:r.deleted_at,reason:r.reason,inventory:JSON.parse(r.inventory)})); }
  // ---- usage accounting (daily caps) ----
  usageAdd(day, dEmbed, dLlm, ts) { this.sql.prepare(`INSERT INTO usage(day,embed_tokens,llm_tokens,updated_at) VALUES (?,?,?,?) ON CONFLICT(day) DO UPDATE SET embed_tokens=embed_tokens+excluded.embed_tokens, llm_tokens=llm_tokens+excluded.llm_tokens, updated_at=excluded.updated_at`).run(day,dEmbed|0,dLlm|0,ts); }
  usageDay(day) { const r=this.sql.prepare('SELECT embed_tokens e, llm_tokens l FROM usage WHERE day=?').get(day); return r ? {embed_tokens:r.e, llm_tokens:r.l} : {embed_tokens:0,llm_tokens:0}; }
  usageAll() { return this.sql.prepare('SELECT day, embed_tokens, llm_tokens, updated_at FROM usage ORDER BY day').all(); }
  _putTurn(t) { this.sql.prepare('INSERT INTO turns VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(t.id,JSON.stringify(t)); }
  redactTurn(t) { this._putTurn(t); }
  insertTurn(t) { if(this.getTurn(t.id)) throw new Error('Duplicate turn'); this._putTurn({...t,state:'prepared',sent_ids:null}); }
  getTurn(id) { const r=this.sql.prepare('SELECT data FROM turns WHERE id=?').get(id);return r ? JSON.parse(r.data) : null; }
  listTurns() { return this.sql.prepare('SELECT data FROM turns').all().map(r=>JSON.parse(r.data)); }
  markSent(id,sent_ids,payload_hash,ts,citation_map) { this.transaction(()=>{const t=this.getTurn(id);if(t.state!=='prepared') throw new Error('Invalid send state'); this._putTurn({...t,state:'sent',sent_ids,payload_hash,citation_map,sent_at:ts,membership_known:true});for(const mid of sent_ids)this.patch(mid,{last_used:ts});}); }
  completeTurn(id,state,response_text,usage,completed_at,fail_reason) { const t=this.getTurn(id); this._putTurn({...t,state,response_text,usage,completed_at,fail_reason}); }
  grade(id,r,version,apply) { return this.transaction(()=>{
    const t=this.getTurn(id);
    const refuse=reason=>{this.audit('grade_refused',{id,r,reason});return {ok:false,reason};};
    if(!t)return refuse('turn_not_found');
    if(t.state!=='completed')return refuse('turn_not_completed');
    if(!t.membership_known)return refuse('membership_unknown');
    if(![0,1].includes(r))return refuse('invalid_grade');
    if(t.evidence_version!==version)return refuse('version_mismatch');
    if(this.sql.prepare('SELECT 1 FROM grades WHERE turn_id=?').get(id))return refuse('already_graded');
    this.sql.prepare('INSERT INTO grades VALUES (?,?)').run(id,JSON.stringify({r,evidence_version:version,created_at:new Date().toISOString()}));
    // adaptive apply runs INSIDE the same transaction (R-35 one txn, version-pinned)
    if (typeof apply === 'function') apply(t, r);
    return {ok:true,turn:t};
  }); }
  getGrade(id) { const r=this.sql.prepare('SELECT data FROM grades WHERE turn_id=?').get(id); return r ? JSON.parse(r.data) : null; }
  allGrades() { return this.sql.prepare('SELECT turn_id,data FROM grades').all().map(r=>({...JSON.parse(r.data), turn_id:r.turn_id})); }
  registerProject(root) { const r=this.sql.prepare('SELECT id FROM projects WHERE root=?').get(root);if(r)return r.id;const id=crypto.randomUUID();this.sql.prepare('INSERT INTO projects VALUES (?,?)').run(root,id);return id; }
  healthStats() { const turns={},memories={};for(const t of this.listTurns())turns[t.state]=(turns[t.state]||0)+1;for(const m of this.listAllMemories())memories[m.status]=(memories[m.status]||0)+1;return {turns,memories,grades:this.sql.prepare('SELECT count(*) n FROM grades').get().n}; }
}
module.exports = { openStore, SCHEMA_VERSION };
