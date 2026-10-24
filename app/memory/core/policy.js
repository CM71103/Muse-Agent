'use strict';
// memory/core/policy.js — adaptive-policy machinery (spec §9 progressive activation).
// Pure logic where possible; version state lives in the store (metadata table).
//
// Flags: adaptive_ranking | adaptive_budget | query_clustering. All default
// false. Any flag change starts a NEW policy/evidence version (recorded in the
// store + audit). Baseline feedback is never replayed into evidence after
// activation: grade() records the version a turn was created under and the
// apply step only consumes grades whose turn carries the ACTIVE version.
//
// De-promotion (all flags false) restores baseline serving — cosine, fixed
// budget, diagnostics-only clustering — without deleting anything.

const KAPPA = 10;

const FLAG_NAMES = ['adaptive_ranking', 'adaptive_budget', 'query_clustering'];

// ×1.5 budget ladder. Level 0 = baseline budget. growth on eligible /bad only.
const LADDER = [1, 1.5, 2.25, 3.375, 5.0625, 7.59375];  // ~×1.5^n, capped at n=5

function flagsFrom(cfg) {
  const f = {};
  for (const k of FLAG_NAMES) f[k] = !!(cfg && cfg[k]);
  return f;
}

function anyActive(flags) { return FLAG_NAMES.some(k => flags[k]); }

// Version string derives from the flag set deterministically. baseline when
// nothing is active. This is the version written onto new turns and grades.
// seed: bumped when a frozen prompt changes or evidence semantics change —
// a new seed starts a new evidence lineage (spec §2).
function versionFor(flags, seed = '1') {
  if (!anyActive(flags)) return 'baseline-v' + seed;
  const parts = [];
  if (flags.adaptive_ranking) parts.push('rank');
  if (flags.adaptive_budget) parts.push('budget');
  if (flags.query_clustering) parts.push('cluster');
  return 'adaptive-' + parts.join('+') + '-v' + seed;
}

// Evidence-version guard for applying a grade: a grade may move evidence only
// when its turn was created under the currently-active version. Pre-activation
// (baseline) grades keep their baseline version and are never applied after
// activation (spec: baseline feedback never replayed into evidence).
function gradeApplicable(turnVersion, activeVersion) {
  return turnVersion === activeVersion;
}

// ---- adaptive budget: ladder controller ----

// prevOutcome: { state: 'completed'|'failed'|'unknown', r: 0|1|null, eligible: bool }
// Only eligible /bad on COMPLETED, membership-known turns may GROW the next
// budget; nothing ever shrinks it, and /good does not penalize or reward here.
// Returns the ladder LEVEL (index), caller applies the multiplier.
function nextBudgetLevel(prevLevel, prevOutcome, maxLevel = LADDER.length - 1) {
  let lvl = Math.max(0, Math.min(prevLevel, maxLevel));
  if (prevOutcome && prevOutcome.eligible && prevOutcome.state === 'completed' && prevOutcome.r === 0) {
    lvl = Math.min(lvl + 1, maxLevel);
  }
  return lvl;
}

function budgetForLevel(baseBudget, level) {
  const mult = LADDER[Math.max(0, Math.min(level, LADDER.length - 1))];
  return Math.max(0, Math.floor(baseBudget * mult));
}

// ---- query clustering: frozen centroids ----

// Build K centroids from vectors by deterministic farthest-point seeding.
// Frozen: the returned centroids are persisted and never move afterward
// (spec §9 phase 3). Deterministic: same rows -> same centroids.
function buildCentroids(vectors, k) {
  const vols = vectors.filter(v => Array.isArray(v.vec) && v.vec.length);
  if (!vols.length) return [];
  const kk = Math.max(1, Math.min(k | 0, vols.length));
  // deterministic order: by id, then farthest-point from a stable start
  const sorted = vols.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const centroids = [sorted[0].vec.slice()];
  while (centroids.length < kk) {
    let best = null, bestD = -1;
    for (const v of sorted) {
      let d = Infinity;
      for (const c of centroids) d = Math.min(d, 1 - cosineOf(v.vec, c));
      if (d > bestD) { bestD = d; best = v.vec; }
    }
    centroids.push(best.slice());
  }
  return centroids;
}

function cosineOf(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

// Assign a query vector to the closest frozen centroid.
// Returns { cluster: index|null, similarity: number|null }.
// Abstention: below the floor the query is unfamiliar -> cluster stays null and
// the caller records c_∅ (abstain), per spec.
function assignCluster(queryVector, centroids, floor) {
  let best = -1, bestSim = -1;
  for (let i = 0; i < centroids.length; i++) {
    const sim = cosineOf(queryVector, centroids[i]);
    if (sim > bestSim) { bestSim = sim; best = i; }
  }
  if (best < 0 || bestSim < floor) return { cluster: null, similarity: bestSim >= 0 ? bestSim : null };
  return { cluster: best, similarity: bestSim };
}

// Context key for evidence buckets. Clustering ON: cluster index (or c_empty
// sentinel for abstained queries). Clustering OFF: flat 'default' bucket.
function contextKey(cluster) {
  return cluster == null ? 'c_empty' : 'cluster-' + cluster;
}

module.exports = {
  FLAG_NAMES, LADDER, KAPPA,
  flagsFrom, anyActive, versionFor, gradeApplicable,
  nextBudgetLevel, budgetForLevel,
  buildCentroids, assignCluster, contextKey, cosineOf,
};
