'use strict';
// memory/layer.js — the MemoryLayer facade. The ONLY surface the host touches.
// Implements the R-49 host contract call order from INTEGRATION-ARCHITECTURE.md §5:
//   requestContext → host renders → commitPrepared → host sends →
//   acknowledgeSent → completeTurn → parseCitations → grade
// plus the remaining normative surface: extract() session-end extraction,
// daily token caps, comprehensive deletion inventory, healthMetrics(), and the
// adaptive-policy evidence-version machinery (§9).
//
// Reuses the existing core math (posterior/packer/scorer/citations) — no
// parallel memory subsystem (do-not #10).

const crypto = require('crypto');
const { openStore } = require('./adapters/store');
const { countTokens } = require('./adapters/tokenizer');
const { embed, checkRowPin, cosine } = require('./adapters/embeddings');
const { pack } = require('./core/packer');
const { templatePayload, parseCitations } = require('./core/evidence');
const posterior = require('./core/posterior');
const scorer = require('./core/scorer');
const policy = require('./core/policy');
const extractCore = require('./core/extract');
const llmAdapter = require('./adapters/llm');
const turnlog = require('./adapters/turnlog');
const prompts = require('./prompts/prompts');

// Evidence-version seed. Bump ONLY when a frozen prompt changes or the
// evidence semantics themselves change — a new seed starts a new evidence
// lineage (spec §2 prompts: changing them starts a new evidence version).
const EVIDENCE_VERSION_SEED = '1';

// ---------- MemoryLayer ----------

class MemoryLayer {
  constructor(cfg, opts = {}) {
    this.cfg = cfg || {};
    this.opts = opts || {};
    this.dataDir = opts.dataDir;
    if (!this.dataDir) throw new Error('MemoryLayer: dataDir required');
    this.store = openStore(this.dataDir);

    // config shape: harness/config.js DEFAULTS -> cfg.memory.*, cfg.llm.*
    const m = (cfg && cfg.memory) || {};
    const llm = (cfg && cfg.llm) || {};
    this.memCfg = m;

    // identity: layer mints a fresh task_id per session (obligation 2)
    this.taskId = crypto.randomUUID();
    this.sessionId = opts.sessionId || null;
    this.agentId = opts.agentId || 'desktop';

    // project scoping: auto = Git root -> opaque registry id (spec §3)
    this._strategy = m.project_id_strategy || 'auto';
    try { this.projectId = this._resolveProject(opts.cwd, opts.projectId || m.project_id); }
    catch (e) { this.store.close(); throw e; }
    this.lastError = null;
    this.embed = opts.embed || embed;

    // embedding config: memory.embed_* overrides, else the chat endpoint + key
    this.emb = {
      baseUrl: opts.embedBaseUrl || m.embed_base_url || llm.base_url,
      apiKey: opts.embedApiKey || m.embed_api_key || llm.api_key ||
        process.env[llm.api_key_env || 'MUSE_LLM_API_KEY'] || '',
      model: m.embed_model || 'text-embedding-3-small',
      dims: m.embed_dims || 1536,
      generation: m.embed_generation || 'v1',
    };
    // extraction LLM: layer-owned endpoint config (defaults to the chat path)
    this.xllm = {
      baseUrl: m.llm_base_url || llm.base_url || '',
      apiKey: m.llm_api_key || llm.api_key ||
        process.env[llm.api_key_env || 'MUSE_LLM_API_KEY'] || '',
      model: m.llm_model || llm.model || '',
    };

    // daily token caps (spec §3): embeddings + layer-LLM usage per UTC day,
    // persisted in store usage table. cap <= 0 disables capping.
    this.dailyTokenCap = Number(m.daily_token_cap ?? 200000);
    if (!Number.isFinite(this.dailyTokenCap) || this.dailyTokenCap < 0) { this.close(); throw new Error('Invalid memory.daily_token_cap'); }
    this._clock = opts.clock || (() => Date.now());   // injectable for tests

    // policy version: flags default false (Phase 0 baseline). Any change is
    // recorded as a new policy/evidence version (§9).
    this.flags = policy.flagsFrom(m);
    this.fixedBudget = Number(m.budget_tokens ?? 1200);
    if (!Number.isFinite(this.fixedBudget) || this.fixedBudget < 0) { this.close(); throw new Error('Invalid memory budget'); }
    this.scoreCutoff = Number(m.score_cutoff || 0.20);
    this.clusterFloor = Number(m.cluster_floor ?? 0.35);
    if (!Number.isFinite(this.clusterFloor) || this.clusterFloor < 0 || this.clusterFloor > 1) { this.close(); throw new Error('Invalid memory.cluster_floor'); }
    this._applyFlags(this.flags, 'startup');

    // replenish decay on startup when adaptive ranking serves (§9 phase 1)
    if (this.flags.adaptive_ranking) {
      try { this.runDecay(); } catch (e) { this.lastError = `decay_run failed: ${e.message}`; }
    }
  }

  _resolveProject(cwd, explicitId) {
    const strategy = this._strategy || 'auto';
    if ((strategy === '_default' || strategy === 'manual') && explicitId) {
      return explicitId;
    }
    if (strategy !== 'auto') {
      throw new Error('memory: project_id_strategy=manual requires explicit projectId — ' +
        'surface the selection prompt, never fall back silently (spec §3).');
    }
    let root;
    try {
      root = require('child_process').execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: cwd || process.cwd(), timeout: 5000, stdio: ['ignore','pipe','pipe'], windowsHide: true,
      }).toString().trim();
    } catch {
      throw new Error('MEMORY_SCOPE_REQUIRED: Git detection failed. Explicitly select personal (_default + project_id) or manual project scope. Existing scopes stay separate.');
    }
    if (!root) throw new Error('MEMORY_SCOPE_REQUIRED: empty Git root');
    return this.store.registerProject(root);
  }

  // ---------- policy / evidence-version machinery (§9) ----------

  // Records the active flag set + policy version. Any change from the stored
  // version writes the new version + audit. Enabling any flag moves serving to
  // a NEW evidence version; baseline grades keep their baseline version and are
  // never applied afterward (store.grade refuses version mismatches).
  _applyFlags(flags, source) {
    this.flags = policy.flagsFrom(flags);
    this.evidenceVersion = policy.versionFor(this.flags, EVIDENCE_VERSION_SEED);
    const stored = this.store.getMeta('policy:version');
    if (stored !== this.evidenceVersion) {
      this.store.transaction(() => {
        this.store.setMeta('policy:version', this.evidenceVersion);
        this.store.setMeta('policy:flags', JSON.stringify(this.flags));
        this.store.audit('policy_version', { version: this.evidenceVersion, flags: this.flags, source, prompt_hashes: prompts.manifest() });
      });
    }
  }

  // Runtime flag change (IPC / explicit call). Validates names, writes the new
  // policy/evidence version + audit. De-promotion (all false) restores baseline
  // serving without deleting anything (§9).
  setFlags(patch) {
    const next = { ...this.flags };
    for (const [k, v] of Object.entries(patch || {})) {
      if (!policy.FLAG_NAMES.includes(k)) throw new Error(`unknown policy flag: ${k}`);
      next[k] = !!v;
    }
    this._applyFlags(next, 'explicit');
    if (this.flags.adaptive_ranking) {
      try { this.runDecay(); } catch (e) { this.lastError = `decay_run failed: ${e.message}`; }
    }
    return { ok: true, flags: { ...this.flags }, evidence_version: this.evidenceVersion };
  }

  // Current allowance for a turn: ladder level under adaptive_budget, else the
  // fixed base budget. The controller only ever GROWS on eligible /bad (§6).
  _allowance() {
    if (!this.flags.adaptive_budget) return this.fixedBudget;
    const lvl = Number(this.store.getMeta('budget:level') || 0);
    return policy.budgetForLevel(this.fixedBudget, lvl);
  }

  // ---------- daily token caps (spec §3) ----------

  _todayKey() {
    return new Date(this._clock()).toISOString().slice(0, 10);   // UTC day
  }
  _capRemaining() {
    if (!(this.dailyTokenCap > 0)) return Infinity;   // capping disabled
    const u = this.store.usageDay(this._todayKey());
    return this.dailyTokenCap - (u.embed_tokens + u.llm_tokens);
  }
  _recordUsage(kind, tokens) {
    const n = Math.max(0, Math.round(Number(tokens) || 0));
    if (!n) return;
    this.store.usageAdd(this._todayKey(), kind === 'embed' ? n : 0, kind === 'llm' ? n : 0, new Date().toISOString());
  }
  _estimateTokens(texts) {
    let n = 0; for (const t of texts) n += countTokens(t);
    return n;
  }
  // Cap-aware embed wrapper. Refusal is a 429-style degrade — never a silent
  // bypass: callers surface `token_cap_exceeded` to the host/UI.
  async _embedCapped(texts) {
    if (this._capRemaining() <= 0) {
      const e = new Error('daily_token_cap_exceeded'); e.code = 'TOKEN_CAP'; throw e;
    }
    const r = await this.embed(this.emb, texts);
    const used = r.usage && Number.isFinite(Number(r.usage.total_tokens))
      ? Number(r.usage.total_tokens)
      : this._estimateTokens(texts);   // disclosed estimate when usage missing
    this._recordUsage('embed', used);
    return r;
  }

  // ---------- obligation 3: request context with a budget ----------

  // query: user text for this turn.
  // budgetInfo: { contextLimit, otherInputTokens, outputReserve }
  // Returns PackedContext. May clamp budget to zero — that is normal, not an error.
  async requestContext(query, budgetInfo, opts = {}) {
    const clamp = this._clampBudget(budgetInfo);
    // Retry durable pending writes on next user request, including migrated vectors.
    if (clamp > 0) await this.embedPending();
    const t0 = new Date().toISOString();

    // fetch all rows — packer applies the status filter and reports omissions
    const allRows = this.store.listMemories(this.projectId);
    if (allRows.length === 0 || clamp <= 0 || !String(query || '').trim()) {
      this.store.bumpMeta('stats:requests_empty');
      return this._emptyContext(clamp, t0, allRows.length === 0 ? 'no_memories' : clamp <= 0 ? 'budget_zero' : 'empty_query');
    }

    // embed the query (pin check per row happens on stored rows below)
    let qv;
    try {
      const r = await this._embedCapped([String(query)]);
      const qvec = r.vectors[0];
      const pin = checkRowPin({ embedding: qvec.vector, model_pin: r.model, generation: this.emb.generation }, this.emb.model, this.emb.dims, this.emb.generation);
      if (!pin.ok) throw new Error(`query embedding failed pin check: ${pin.reason}`);
      qv = qvec.vector;
    } catch (e) {
      // Embedding failure is NOT a memory failure that poisons the turn — degrade to empty context.
      // Token-cap refusal is likewise a disclosed degrade, never a silent bypass.
      const reason = e.code === 'TOKEN_CAP' ? 'token_cap_exceeded' : `embed_failed: ${e.message}`;
      this.lastError = reason;
      this.store.bumpMeta('stats:requests_empty');
      return this._emptyContext(clamp, t0, reason);
    }

    // query clustering (§9 phase 3): frozen project-local centroids; unfamiliar
    // queries abstain (cluster null → c_empty context key).
    let cluster = null, assignmentSimilarity = null;
    if (this.flags.query_clustering) {
      try {
        const cents = this._centroids();
        if (cents.length) {
          const a = policy.assignCluster(qv, cents, this.clusterFloor);
          cluster = a.cluster; assignmentSimilarity = a.similarity;
        }
      } catch (e) { this.lastError = `clustering failed: ${e.message}`; }
    }
    const ctxKey = this.flags.query_clustering ? policy.contextKey(cluster) : 'default';

    // Rank: Phase 0 = cosine only. adaptive_ranking = posterior score
    // sim·(μ + c·σ) from pooled evidence at this context key (§9 phase 1).
    const candidates = [];
    for (const row of allRows) {
      if (row.status !== 'active') {
        // non-active rows pass through so the packer reports status/scope omissions
        candidates.push({ id: row.id, tokens: 0, score: 0, status: row.status });
        continue;
      }
      const pin = checkRowPin(row, this.emb.model, this.emb.dims, this.emb.generation);
      if (!pin.ok) continue;    // pinned rows only — never use unpinned vectors
      let vec = row.embedding;
      if (!Array.isArray(vec)) continue;
      const sim = cosine(qv, vec);
      if (!(sim > 0)) continue; // orthogonal or negative — skip
      let score = sim;
      if (this.flags.adaptive_ranking) {
        const cc = (row.evidence && typeof row.evidence === 'object') ? row.evidence : {};
        const d = posterior.derive(cc, ctxKey, row.type || 'fact');
        score = scorer.score(sim, d.mu, d.sigma);
      }
      candidates.push({
        id: row.id, text: row.text, type: row.type, trust_tier: row.trust_tier, provenance: row.provenance,
        tokens: countTokens(row.text) + 6,   // ~ [cN] prefix + newline overhead
        sim,
        score,
        status: 'active',
      });
    }

    const pk = pack(candidates, clamp, this.scoreCutoff);

    // Estimator includes labels and delimiters, not only record text.
    while (pk.packed.length && countTokens(templatePayload(pk.packed)) + 48 > clamp) {
      const removed=pk.packed.pop();pk.omitted.push({id:removed.id,reason:'budget'});
    }
    pk.position=Object.fromEntries(pk.packed.map((r,i)=>[r.id,i+1]));
    const packedTokens = pk.packed.length ? countTokens(templatePayload(pk.packed)) + 48 : 0;

    const payload = templatePayload(pk.packed);

    // lifecycle: prepared (nothing is evidence yet). tokens/predictions/cluster
    // ride on the turn for healthMetrics (utilization, calibration) and for the
    // grade-time evidence update.
    const turnId = crypto.randomUUID();
    const prepared = {
      id: turnId,
      project_id: this.projectId,
      agent_id: this.agentId,
      channel: opts.channel || 'desktop',
      task_id: this.taskId,
      query_text: String(query || ''),
      prepared_ids: pk.packed.map(r => r.id),
      citation_map: Object.fromEntries(Object.entries(pk.position).map(([id,n]) => [String(n),id])),
      payload_hash: hashPayload(payload),
      created_at: t0,
      evidence_version: this.evidenceVersion,
      tokens_used: packedTokens,
      tokens_budget: clamp,
      predicted_scores: Object.fromEntries(pk.packed.map(r => [r.id, r.score])),
      query_cluster: cluster,
      assignment_similarity: assignmentSimilarity,
    };

    return {
      prepared,
      turn_id: turnId,
      records: pk.packed.map(r => ({ id: r.id, text: r.text, type: r.type, trust_tier: r.trust_tier })),
      payload,              // rendered memory block — host must send verbatim or report drift
      payload_hash: hashPayload(payload),
      citation_map: prepared.citation_map,
      position: pk.position,
      tokens_used: packedTokens,
      tokens_budget: clamp,
      omitted_ids: pk.omitted,
      candidate_ids: candidates.map(c => c.id),
      packed_ids: pk.packed.map(r => r.id),
      query_cluster: cluster,
      assignment_similarity: assignmentSimilarity,
      unassigned: pk.omitted.filter(o => o.reason === 'near_miss').map(o => o.id),
      clamp_reason: clamp === 0 ? 'budget_zero' : null,
    };
  }

  _clampBudget(budgetInfo) {
    // spec §4.3: clamp = context_limit − other_input − output_reserve − 256
    const allowance = this._allowance();
    if (!budgetInfo) return allowance;
    const ctx = budgetInfo.contextLimit ?? 200000;
    const other = budgetInfo.otherInputTokens ?? 0;
    const reserve = budgetInfo.outputReserve ?? 0;
    if (![ctx,other,reserve].every(v=>Number.isFinite(v) && v>=0)) throw new Error('Invalid request budget');
    const raw = ctx - other - reserve - 256;
    if (raw <= 0) return 0;    // may clamp to zero — normal
    return Math.min(raw, allowance);
  }

  _emptyContext(budget, ts, reason) {
    return {
      turn_id: null,
      records: [], payload: '', payload_hash: null,
      citation_map: {}, position: {}, tokens_used: 0, tokens_budget: budget,
      omitted_ids: [], candidate_ids: [], packed_ids: [],
      query_cluster: null, assignment_similarity: null, unassigned: [],
      clamp_reason: reason,
    };
  }

  // ---------- clustering: frozen project-local centroids (§9 phase 3) ----------

  _centroids() {
    const key = `cluster:centroids:${this.projectId}`;
    const raw = this.store.getMeta(key);
    if (raw) return JSON.parse(raw);
    // build once from pinned active rows, then FREEZE (never move afterward)
    const rows = this.store.listMemories(this.projectId)
      .filter(m => m.status === 'active' && Array.isArray(m.embedding) &&
        checkRowPin(m, this.emb.model, this.emb.dims, this.emb.generation).ok);
    const cents = policy.buildCentroids(rows.map(m => ({ id: m.id, vec: m.embedding })), 4);
    this.store.setMeta(key, JSON.stringify(cents));
    this.store.audit('centroids_built', { project_id: this.projectId, k: cents.length });
    return cents;
  }

  // ---------- lifecycle: prepared → sent ----------

  // obligation 4: acknowledge what was ACTUALLY sent. Host reports sentIds +
  // payload hash of what it really put on the wire. Unknown membership ⇒
  // feedback ineligible later — never guessed.
  commitPrepared(ctx) {
    for (const id of ctx.packed_ids) {
      const m = this.store.getMemory(id);
      if (!m || m.project_id !== this.projectId || m.status !== 'active' || m.injection_risk > 0 ||
          !ctx.records.some(r=>r.id===id && r.text===m.text && r.trust_tier===m.trust_tier)) {
        throw new Error('MEMORY_REPACK_REQUIRED: record changed before send');
      }
    }
    if (!this.store.getTurn(ctx.turn_id)) this.store.insertTurn(ctx.prepared);
    return ctx;
  }

  acknowledgeSent(turnId, sentIds, payloadHash, citationMap) {
    const t = this.store.getTurn(turnId);
    if (!t) throw new Error(`acknowledgeSent: unknown turn ${turnId}`);
    if (t.state !== 'prepared') throw new Error(`acknowledgeSent: turn ${turnId} in state ${t.state}`);
    const expected = Object.values(citationMap || {});
    if (!Array.isArray(sentIds) || !citationMap || !/^sha256:[a-f0-9]{64}$/.test(payloadHash || '') ||
        new Set(sentIds).size !== sentIds.length || expected.length !== sentIds.length ||
        !expected.every(id => sentIds.includes(id)) || !sentIds.every(id => t.prepared_ids.includes(id))) {
      this.failTurn(turnId, 'unknown', 'invalid_actual_send_acknowledgement');
      throw new Error('Actual membership, citation map and hash required; turn unknown');
    }
    this.store.markSent(turnId, sentIds, payloadHash, new Date().toISOString(), citationMap);
    return { ok: true };
  }

  failTurn(id, state = 'unknown', reason = 'send_unconfirmed') {
    const t = this.store.getTurn(id);
    if (t && ['prepared','sent'].includes(t.state)) this.store.completeTurn(id,state,null,null,new Date().toISOString(),reason);
  }

  // ---------- lifecycle: sent → completed | failed | unknown ----------

  // obligation 5: attach response, usage, outcome. Provider failure ≠ memory
  // failure. state ∈ completed | failed | unknown.
  async completeTurn(turnId, { response, usage, outcome } = {}) {
    const t = this.store.getTurn(turnId);
    if (!t) throw new Error(`completeTurn: unknown turn ${turnId}`);
    if (t.state !== 'sent') throw new Error(`completeTurn: turn ${turnId} in state ${t.state}`);

    let state = 'completed';
    let failReason = null;
    // outcome may be a string ('failed' | 'unknown') or {status, reason} — accept both
    const outcomeState = typeof outcome === 'string' ? outcome : (outcome && outcome.status) || null;
    const outcomeReason = outcome && outcome.reason;
    if (!usage && outcomeState !== 'failed') { state = 'unknown'; failReason = 'missing_usage'; }
    if (outcomeState === 'failed') { state = 'failed'; failReason = outcomeReason || 'provider_error'; }
    else if (outcomeState === 'unknown') { state = 'unknown'; failReason = outcomeReason || 'unresolved'; }

    const ts = new Date().toISOString();
    this.store.completeTurn(turnId, state, response || null, usage || null, ts, failReason);

    // adaptive ranking: packed_n audit counters move with completed turns
    // (audit only — S/F move exclusively on eligible grades, one txn).
    if (state === 'completed' && this.flags.adaptive_ranking) {
      try {
        const key = this.flags.query_clustering ? policy.contextKey(t.query_cluster) : 'default';
        this.store.transaction(() => {
          for (const id of t.sent_ids || []) {
            const m = this.store.getMemory(id);
            if (!m || m.status !== 'active') continue;
            const cc = (m.evidence && typeof m.evidence === 'object') ? m.evidence : {};
            posterior.bumpPacked(cc, key);
            this.store.updateEvidence(id, cc, ts);
          }
        });
      } catch (e) { this.lastError = `packed audit bump failed: ${e.message}`; }
      // replenish decay runs on schedule: startup + after each completed turn
      try { this.runDecay(); } catch (e) { this.lastError = `decay_run failed: ${e.message}`; }
    }

    return { ok: true, state };
  }

  // ---------- obligation 6: explicit grades ----------

  // r ∈ {1, 0} from /good /bad. One accepted grade per turn, immutable,
  // idempotent, version-pinned (R-35: one txn). Baseline: recorded only.
  // adaptive_ranking: eligible /good updates usefulness evidence INSIDE the
  // same transaction (packed-and-cited → S+=r; packed-and-not-cited → F+=ε·r;
  // r=0 adds no mass — /bad never penalizes packed memories).
  // adaptive_budget: eligible /bad may grow the NEXT budget one ×1.5 ladder
  // step (never shrink, never touch packed rows) — same transaction.
  grade(turnId, r, opts = {}) {
    const self = this;
    const res = this.store.grade(turnId, r, this.evidenceVersion, (turn, rr) => {
      if (self.flags.adaptive_ranking) {
        const key = self.flags.query_clustering ? policy.contextKey(turn.query_cluster) : 'default';
        const cited = new Set(Object.values(turn.citation_map || {}));
        for (const id of turn.sent_ids || []) {
          const m = self.store.getMemory(id);
          if (!m || m.status !== 'active') continue;
          const cc = (m.evidence && typeof m.evidence === 'object') ? m.evidence : {};
          posterior.update(cc, key, cited.has(id), rr);
          self.store.updateEvidence(id, cc, new Date().toISOString());
        }
      }
      if (self.flags.adaptive_budget && rr === 0) {
        const lvl = Number(self.store.getMeta('budget:level') || 0);
        const next = policy.nextBudgetLevel(lvl, { eligible: true, state: turn.state, r: rr });
        if (next !== lvl) {
          self.store.setMeta('budget:level', String(next));
          self.store.audit('budget_grow', { turn: turnId, from_level: lvl, to_level: next });
        }
      }
    });
    if (!res.ok) return res;
    const applied = this.flags.adaptive_ranking || (this.flags.adaptive_budget && r === 0);
    return { ok: true, applied, reason: applied ? 'adaptive_applied' : 'baseline_feedback_recorded_not_applied' };
  }

  // ---------- replenish decay runner (§9 phase 1) ----------

  // Deterministic: same stored state + same `now` → same result. Callable on
  // startup and after each completed turn. Applies posterior.replenish toward
  // the type prior per elapsed days since the previous run (stored timestamp).
  runDecay(nowMs) {
    if (!this.flags.adaptive_ranking) return { skipped: 'adaptive_ranking_off' };
    const now = Number.isFinite(nowMs) ? nowMs : this._clock();
    const last = this.store.getMeta('decay:last_run');
    if (!last) {
      this.store.setMeta('decay:last_run', new Date(now).toISOString());
      return { decayed: 0, first_run: true };
    }
    const days = (now - Date.parse(last)) / 86400000;
    if (!(days > 0)) return { decayed: 0, days_elapsed: days };
    const ts = new Date(now).toISOString();
    let n = 0;
    this.store.transaction(() => {
      for (const m of this.store.listMemories(this.projectId)) {
        if (m.status !== 'active') continue;
        const cc = (m.evidence && typeof m.evidence === 'object') ? m.evidence : {};
        if (!Object.keys(cc).length) continue;
        if (posterior.replenish(cc, m.type || 'fact', days)) {
          this.store.updateEvidence(m.id, cc, ts);
          n++;
        }
      }
      this.store.setMeta('decay:last_run', ts);
      this.store.audit('decay_run', { project_id: this.projectId, days: Number(days.toFixed(6)), rows: n });
    });
    return { decayed: n, days_elapsed: days };
  }

  // ---------- obligation 7: correction / deletion ----------

  // Logical deletion + comprehensive inventory (spec §7). Covers: primary
  // content, embeddings (nulled), derived posteriors (cleared), turn payload
  // references (redacted), and a JSONL export removal request (future exports
  // exclude the id; already-written files are a disclosed limit). Never secure
  // erasure (do-not #9) — limits are recorded in the inventory itself.
  deleteMemory(id, reason) {
    const m = this.store.getMemory(id);
    if (!m || m.project_id !== this.projectId) return { ok: false, reason: 'not_found' };
    const ts = new Date().toISOString();
    this.store.transaction(() => {
      const turnHits = this.store.listTurns().filter(t => (t.prepared_ids || []).includes(id) || (t.sent_ids || []).includes(id));
      for (const t of turnHits) {
        this.store.redactTurn({...t,query_text:null,response_text:null,payload_hash:null,prepared_ids:[],sent_ids:null,citation_map:{},membership_known:false});
      }
      // primary content cleared; embeddings nulled; derived posteriors cleared
      this.store.patch(id,{status:'deleted',text:'',embedding:null,model_pin:null,dims:null,generation:null,evidence:{},updated_at:ts});
      const inventory = {
        content: 'primary text cleared',
        embedding: 'vector, model pin, dims and generation nulled',
        posteriors: 'derived evidence counters cleared',
        turn_payloads: turnHits.map(t => t.id),
        export_request: 'future JSONL exports exclude this id; previously written export files are NOT rewritten',
        limits: ['legacy JSON files', 'host transcripts outside the layer', 'backups', 'provider retention', 'previously written JSONL exports'],
      };
      this.store.recordDeletion({ id, project_id: this.projectId, deleted_at: ts, reason: reason || null, inventory });
      this.store.audit('logical_deletion', { id, reason: reason || null, inventory });
    });
    return { ok: true, id, deleted_at: ts, reason: reason || null };
  }

  // Deletion inventory reader (disclosure surface).
  listDeleted() {
    return this.store.listDeletions(this.projectId);
  }

  quarantine(id, reason) {
    const m = this.store.getMemory(id);
    if (!m || m.project_id !== this.projectId) return { ok: false, reason: 'not_found' };
    const ts = new Date().toISOString();
    this.store.updateStatus(id, 'quarantined', ts);
    return { ok: true, id, quarantined_at: ts, reason: reason || null };
  }

  // Supersede: atomic old→new replacement (correction surface).
  supersede(oldId, newRecord) {
    const o = this.store.getMemory(oldId);
    if (!o) return { ok: false, reason: 'not_found' };
    const ts = new Date().toISOString();
    this.store.transaction(() => {
      this.store.insertMemory(newRecord);
      this.store.supersede(oldId, newRecord.id, ts);
    });
    return { ok: true, oldId, newId: newRecord.id };
  }

  // ---------- ingestion (obligation 1): source events, idempotent ----------

  // events: [{source_event_id, text, provenance, type?, channel?, trust_tier?}]
  // Idempotent by source_event_id: dedupe against existing rows keyed on
  // source_event_id. Provenance tier: user | tool | imported | unknown.
  async ingest(events) {
    const out = [];
    for (const ev of events || []) {
      if (!ev || !ev.source_event_id || !ev.text) {
        out.push({ ok: false, reason: 'bad_event' });
        continue;
      }
      const ts = new Date().toISOString();
      const id = `mem-${crypto.randomUUID()}`;
      // dedupe: source_event_id stored in row (keyed map below)
      if (this._sourceSeen(ev.source_event_id)) { out.push({ ok: true, id: this._sourceId(ev.source_event_id), dedup: true }); continue; }
      const text = String(ev.text);
      const risk = injectionRisk(text, ev.provenance);
      const record = {
        id,
        project_id: this.projectId,
        agent_id: this.agentId,
        channel: ev.channel || 'desktop',
        provenance: ev.provenance || 'unknown',
        trust_tier: ev.trust_tier || (ev.provenance === 'user' ? 'user' : 'derived'),
        type: ev.type || 'fact',
        text,
        embedding: null,
        model_pin: null,
        dims: null,
        created_at: ts,
        updated_at: ts,
        status: risk > 0 ? 'quarantined' : 'pending_embed',   // suspected injection quarantined until user review (spec §7)
        injection_risk: risk,
        source_event_id: ev.source_event_id,
        evidence: {},
      };

      this.store.insertMemory(record);
      out.push({ ok: true, id, dedup: false });
    }
    return out;
  }

  _sourceSeen(id) { return !!this.store.findSource(this.projectId,id); }
  _sourceId(id) { const m=this.store.findSource(this.projectId,id); return m && m.id; }
  close() { this.store.close(); }
  startSession(sessionId) { this.sessionId=sessionId; this.taskId=crypto.randomUUID(); }
  scopes() {
    const counts={};for(const m of this.store.listAllMemories())counts[m.project_id]=(counts[m.project_id] || 0)+1;
    return Object.entries(counts).map(([project_id,records])=>({project_id,records}));
  }
  listMemories() { return this.store.listMemories(this.projectId); }
  review(id) {
    const m=this.store.getMemory(id);
    if (!m || m.project_id!==this.projectId || m.status!=='quarantined') throw new Error('Quarantined record not in selected scope');
    this.store.transaction(()=>{this.store.patch(id,{status:'pending_embed',injection_risk:0});this.store.audit('review_safe',{id});});
    return this.embedPending();
  }
  // Embed all pending rows (status pending_embed). Batch to the provider,
  // gated by the daily token cap. Cap refusal is a returned degrade, not a
  // silent skip; rows stay durable pending_embed until a later window.
  async embedPending() {
    const pending = this.store.listMemories(this.projectId).filter(m => m.status === 'pending_embed');
    if (!pending.length) return { embedded: 0 };
    if (this._capRemaining() <= 0) {
      return { embedded: 0, refused: 'daily_token_cap_exceeded', pending: pending.length };
    }
    const texts = pending.map(m => m.text);
    let r;
    try { r = await this._embedCapped(texts); }
    catch (e) {
      if (e.code === 'TOKEN_CAP') return { embedded: 0, refused: 'daily_token_cap_exceeded', pending: pending.length };
      this.lastError = `Embedding write failed: ${e.message}`; throw new Error(this.lastError);
    }
    const out = [];
    for (let i = 0; i < pending.length; i++) {
      const row = pending[i];
      const v = r.vectors[i];
      const pin = checkRowPin({ embedding: v.vector, model_pin: r.model, generation: this.emb.generation }, this.emb.model, this.emb.dims, this.emb.generation);
      if (!pin.ok) { out.push({ id: row.id, ok: false, reason: pin.reason }); continue; }
      const current = this.store.getMemory(row.id);
      if (!current || current.status !== 'pending_embed') continue;
      row.embedding = v.vector;
      row.model_pin = r.model;
      row.dims = v.vector.length;
      row.generation = this.emb.generation;
      row.status = 'active';
      row.updated_at = new Date().toISOString();
      this.store.insertMemory(row);
      out.push({ id: row.id, ok: true });
    }
    if (out.some(x=>!x.ok)) { this.lastError = 'Embedding rows failed pin validation'; throw new Error(this.lastError); }
    return { embedded: out.filter(x => x.ok).length, rows: out };
  }

  // ---------- extraction: session-end distillation (spec §2 extract) ----------

  // events: [{source_event_id, text, provenance, type?}] supplied by the host
  // (agent collects during the session). Runs the frozen extraction prompt
  // through the layer LLM adapter (30s/≤3 retries, daily-token-cap aware),
  // then feeds candidates through the normal ingest pipeline with dedupe:
  // candidate source_event_id = extract:<sha256(project|prompt_hash|text)>, so
  // re-running extraction over the same events is idempotent. Provenance is
  // preserved from the candidate derivation. Raw source rows whose events the
  // candidates consumed are superseded (kept in the row, out of packing) so
  // extraction replaces noise rather than duplicating it; if extraction fails
  // or is refused, raw rows stay active — nothing is lost.
  async extractSession(events, opts = {}) {
    const evs = (events || []).filter(e => e && e.source_event_id && e.text);
    if (!evs.length) return { ok: true, extracted: 0, note: 'no_events' };
    const promptHash = prompts.load('extract-prompt.md').hash;
    let result;
    try {
      result = await extractCore.extract(evs, async ({ system, user }) => {
        if (this._capRemaining() <= 0) {
          const e = new Error('daily_token_cap_exceeded'); e.code = 'TOKEN_CAP'; throw e;
        }
        if (!this.xllm.baseUrl || !this.xllm.model) {
          const e = new Error('extraction LLM not configured (memory.llm_base_url / llm_model)'); e.code = 'LLM_UNCONFIGURED'; throw e;
        }
        const r = await llmAdapter.chat(this.xllm, { system, user, temperature: 0.1, max_tokens: 2048 });
        const used = r.usage && Number.isFinite(Number(r.usage.total_tokens))
          ? Number(r.usage.total_tokens)
          : this._estimateTokens([system, user]);
        this._recordUsage('llm', used);
        return r;
      });
    } catch (e) {
      if (e.code === 'TOKEN_CAP') return { ok: false, reason: 'daily_token_cap_exceeded', prompt_hash: promptHash };
      return { ok: false, reason: `extract_failed: ${e.message}`, prompt_hash: promptHash };
    }
    if (!result.candidates.length) {
      this.store.audit('extraction', { project_id: this.projectId, prompt_hash: result.prompt_hash, candidates: 0 });
      return { ok: true, extracted: 0, note: result.note || 'no_candidates', prompt_hash: result.prompt_hash };
    }
    // dedupe + ingest candidates (provenance preserved, channel from opts)
    const derived = result.candidates.map(c => ({
      source_event_id: `extract:${crypto.createHash('sha256')
        .update([this.projectId, result.prompt_hash, c.text].join('|')).digest('hex')}`,
      text: c.text,
      provenance: c.provenance,
      type: c.type,
      channel: opts.channel || 'desktop',
    }));
    const ingested = await this.ingest(derived);
    // supersede raw rows whose source events the candidates consumed
    const consumed = new Set();
    for (const c of result.candidates) for (const sid of c.source_event_ids || []) consumed.add(sid);
    const superseded = [];
    for (const sid of consumed) {
      const raw = this._sourceId(sid) && this.store.findSource(this.projectId, sid);
      if (raw && ['active', 'pending_embed'].includes(raw.status)) {
        this.store.updateStatus(raw.id, 'superseded', new Date().toISOString());
        superseded.push(raw.id);
      }
    }
    // embed the new candidates (cap-guarded; pending rows stay durable)
    let embedRes = { embedded: 0 };
    try { embedRes = await this.embedPending(); }
    catch (e) { this.lastError = `extraction embed failed: ${e.message}`; }
    this.store.audit('extraction', {
      project_id: this.projectId, prompt_hash: result.prompt_hash,
      candidates: result.candidates.length, dedup: ingested.filter(x => x.dedup).length,
      superseded, embedded: embedRes.embedded || 0,
    });
    return {
      ok: true,
      extracted: ingested.filter(x => x.ok && !x.dedup).length,
      deduped: ingested.filter(x => x.dedup).length,
      superseded, embedded: embedRes.embedded || 0,
      prompt_hash: result.prompt_hash,
    };
  }

  // ---------- JSONL export (export-only, never write-ahead; spec §8) ----------

  // Writes JSONL via the turnlog adapter: excludes deleted ids, records the
  // deletion inventory in the header. Never read back as a recovery source.
  exportJsonl(file) {
    const deletedIds = this.listDeleted().map(d => d.id);
    const delSet = new Set(deletedIds);
    const memories = this.store.listMemories(this.projectId).filter(m => !delSet.has(m.id));
    const turns = this.store.listTurns().filter(t => t.project_id === this.projectId);
    const turnIds = new Set(turns.map(t => t.id));
    const grades = this.store.allGrades().filter(g => turnIds.has(g.turn_id));
    return turnlog.writeExport(file, {
      rows: [
        ...memories.map(m => ({ kind: 'memory', ...m })),
        ...turns.map(t => ({ kind: 'turn', ...t })),
        ...grades.map(g => ({ kind: 'grade', ...g })),
      ],
      deletedIds,
      inventory: { deletions: this.listDeleted() },
      meta: {
        project_id: this.projectId,
        evidence_version: this.evidenceVersion,
        flags: { ...this.flags },
        prompt_hashes: prompts.manifest(),
      },
    });
  }

  // ---------- citation parsing (host displays; malformed logged, not credited) ----------

  parseCitations(text, turnId) {
    const turn = turnId ? this.store.getTurn(turnId) : null;
    const positionMap = turn ? turn.citation_map : {};
    return parseCitations(text, positionMap);
  }

  _lastSentTurn() {
    const turns = this.store.listTurns()
      .filter(t => t.state === 'sent' || t.state === 'completed')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return turns[0] || null;
  }

  // ---------- health (§2 healthMetrics) ----------

  // utilization: budget used vs budget (mean over prepared turns carrying both).
  // c_∅ share: requests that produced no packed memories / all requests.
  // cost rollup: layer token usage per UTC day (embeddings + extraction LLM).
  // calibration: grades vs predicted score buckets (coarse quintiles).
  healthMetrics() {
    const base = this.store.healthStats();
    const turns = this.store.listTurns().filter(t => t.project_id === this.projectId);
    const withBudget = turns.filter(t => Number(t.tokens_budget) > 0 && Number.isFinite(Number(t.tokens_used)));
    const utilization = withBudget.length
      ? withBudget.reduce((s, t) => s + (t.tokens_used / t.tokens_budget), 0) / withBudget.length
      : null;
    // c_∅ share: turns whose prepared pack was EMPTY over all prepared turns
    // (derived from the turn table — no counters to drift). Empty contexts that
    // never create a turn (no_memories / budget_zero / embed failure) count via
    // the stats:requests_empty bump.
    const preparedTurns = turns.filter(t => Array.isArray(t.prepared_ids));
    const emptyPrepared = preparedTurns.filter(t => t.prepared_ids.length === 0).length;
    const emptyNoTurn = Number(this.store.getMeta('stats:requests_empty') || 0);
    const allRequests = preparedTurns.length + emptyNoTurn;
    const c_empty_share = allRequests > 0 ? (emptyPrepared + emptyNoTurn) / allRequests : null;
    const usage = this.store.usageAll();
    const calibration = this._calibration(turns);
    return {
      ...base,
      utilization,
      utilization_turns: withBudget.length,
      requests_total: allRequests,
      requests_packed: preparedTurns.length - emptyPrepared,
      c_empty_share,
      usage,
      usage_today: this.store.usageDay(this._todayKey()),
      daily_token_cap: this.dailyTokenCap > 0 ? this.dailyTokenCap : null,
      calibration,
      deletions: this.store.listDeletions(this.projectId).length,
      flags: { ...this.flags },
      evidence_version: this.evidenceVersion,
      budget: { base: this.fixedBudget, level: Number(this.store.getMeta('budget:level') || 0), allowance: this._allowance() },
    };
  }

  // grades vs predicted score: mean predicted score over each graded turn's
  // packed set, bucketed coarsely; per bucket {n, good}.
  _calibration(turns) {
    const buckets = { '0-0.2': { n: 0, good: 0 }, '0.2-0.4': { n: 0, good: 0 }, '0.4-0.6': { n: 0, good: 0 }, '0.6-0.8': { n: 0, good: 0 }, '0.8-1.0': { n: 0, good: 0 } };
    const byId = new Map(turns.map(t => [t.id, t]));
    for (const g of this.store.allGrades()) {
      const t = byId.get(g.turn_id);
      if (!t || !t.predicted_scores || !(t.sent_ids || []).length) continue;
      let sum = 0, n = 0;
      for (const id of t.sent_ids) {
        const s = t.predicted_scores[id];
        if (Number.isFinite(s)) { sum += s; n++; }
      }
      if (!n) continue;
      const mean = sum / n;
      const key = mean < 0.2 ? '0-0.2' : mean < 0.4 ? '0.2-0.4' : mean < 0.6 ? '0.4-0.6' : mean < 0.8 ? '0.6-0.8' : '0.8-1.0';
      buckets[key].n++;
      if (g.r === 1) buckets[key].good++;
    }
    return buckets;
  }
}

function hashPayload(payload) {
  return 'sha256:' + crypto.createHash('sha256').update(payload || '').digest('hex');
}

// Injection-risk heuristic (spec §7: suspected injection → quarantine until
// explicit user review). Conservative: only flags instruction-shaped content
// arriving from non-user provenance. Provenance user starts at 0 risk.
function injectionRisk(text, provenance) {
  if (provenance === 'user') return 0;   // user's own words are trusted at ingest
  const t = String(text || '');
  const pats = [
    /ignore (all|previous|prior) instructions/i,
    /disregard (all|previous|prior) instructions/i,
    /you are now/i,
    /(new|updated) (system )?prompt:/i,
    /reveal|print|show (your|the) (system )?prompt/i,
    /execute (the following|this) command/i,
    /run .{0,40}(shell|bash|powershell|cmd)/i,
    /\bcurl\b|\bwget\b/i,
  ];
  let hits = 0;
  for (const p of pats) if (p.test(t)) hits++;
  return hits;   // >0 ⇒ quarantined on ingest
}

module.exports = { MemoryLayer, hashPayload, injectionRisk, EVIDENCE_VERSION_SEED };
