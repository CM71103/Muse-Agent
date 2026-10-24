'use strict';
// memory/core/posterior.js — pinned per-row counters and the pooled posterior.
// Invariants (R-10, R-36, honesty 3/4/5/10):
//  - α,β are DERIVED on read, never persisted as truth.
//  - μ_global always shrunk toward μ_0; raw ratio forbidden.
//  - cited_n/packed_n are unweighted audit counts, never decayed.
//  - decay is replenish: fixed point = type prior, concentration grows to 2κ, never 0.

const KAPPA = 10;
const EPS = 0.25;
const HALF_LIFE_DAYS = 5000;              // H
const LAMBDA_PER_DAY = Math.pow(2, -1 / HALF_LIFE_DAYS);

const TYPE_PRIOR = {
  fact: 0.5, decision: 0.5, preference: 0.5,
  procedure: 0.75, error_fix: 0.75,
};

function priorMu(type) { return TYPE_PRIOR[type] != null ? TYPE_PRIOR[type] : 0.5; }

// cluster_counts shape: { [context_key]: { S, F, cited_n, packed_n } }
function ensure(cc, key, type) {
  if (!cc[key]) cc[key] = { S: 0, F: 0, cited_n: 0, packed_n: 0 };
  const c = cc[key];
  if (!Number.isFinite(c.S) || c.S < 0) c.S = 0;
  if (!Number.isFinite(c.F) || c.F < 0) c.F = 0;
  if (!Number.isFinite(c.cited_n)) c.cited_n = 0;
  if (!Number.isFinite(c.packed_n)) c.packed_n = 0;
  return c;
}

// Shrunk global usefulness across a row's clusters, toward the row's type prior.
function shrunkGlobal(cc, type, kappa = KAPPA) {
  const mu0 = priorMu(type);
  let sumS = 0, sumN = 0;
  for (const key of Object.keys(cc)) {
    const c = cc[key];
    sumS += Number.isFinite(c.S) ? c.S : 0;
    sumN += (Number.isFinite(c.S) ? c.S : 0) + (Number.isFinite(c.F) ? c.F : 0);
  }
  return (sumS + kappa * mu0) / (sumN + kappa);
}

// Pooled posterior for one (row, context_key). Returns {mu, sigma, muHat, alpha, beta}.
function derive(cc, contextKey, type, kappa = KAPPA) {
  const mu0 = priorMu(type);
  const c = ensure(cc, contextKey, type);
  const S = c.S, F = c.F;
  const n = S + F;
  let muHat, alpha, beta;
  if (n <= 0) {
    muHat = mu0;
    alpha = kappa * mu0;
    beta = kappa * (1 - mu0);
  } else {
    muHat = S / n;
    const muG = shrunkGlobal(cc, type, kappa);
    alpha = S + kappa * muG;
    beta = F + kappa * (1 - muG);
  }
  const mu = alpha / (alpha + beta);
  const sigma = Math.sqrt((alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1)));
  return { mu, sigma, muHat, alpha, beta };
}

// R-20 update rule. r must be >= OUTCOME_SUCCESS_MIN (caller checks).
// packed-and-cited -> S += r ; packed-and-not-cited -> F += eps*r.
function update(cc, contextKey, cited, r, eps = EPS) {
  const c = ensure(cc, contextKey, 'fact');
  if (cited) c.S += r; else c.F += eps * r;
  c.packed_n += 1;
  if (cited) c.cited_n += 1;
  return c;
}

// Audit counters only (no S/F movement) — used for silent turns.
function bumpPacked(cc, contextKey) {
  const c = ensure(cc, contextKey, 'fact');
  c.packed_n += 1;
  return c;
}

// R-11 replenish decay toward the type prior. Fixed point: μ_0, concentration 2κ.
// daysElapsed >= 0. Applied per cluster counter block.
function replenish(cc, type, daysElapsed, kappa = KAPPA) {
  if (!(daysElapsed > 0)) return false;
  const mu0 = priorMu(type);
  const lam = Math.pow(LAMBDA_PER_DAY, daysElapsed);
  for (const key of Object.keys(cc)) {
    const c = cc[key];
    c.S = lam * c.S + (1 - lam) * kappa * mu0;
    c.F = lam * c.F + (1 - lam) * kappa * (1 - mu0);
  }
  return true;
}

module.exports = { KAPPA, EPS, HALF_LIFE_DAYS, TYPE_PRIOR, priorMu, ensure, derive, update, bumpPacked, replenish, shrunkGlobal };
