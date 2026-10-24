'use strict';
// memory/core/scorer.js — pure score function.
// score_i = sim_i · (μ_i[c] + c·σ_i[c])   (R-08: multiplicative only, no floors)
// σ from pooled Beta posterior; μ,σ come from posterior.js derive().

function score(sim, mu, sigma, c = 0.5) {
  const s = sim * (mu + c * sigma);
  if (!Number.isFinite(s)) return 0;
  return s < 0 ? 0 : s;
}

module.exports = { score };
