'use strict';
// model-caps.js — what the currently selected model can actually do.
//
// Only one model is active at a time (config.llm.model). Attachments need to
// know whether that model can SEE (accept image parts) or is text-only, so the
// app can send pixels when possible and fall back to locally extracted text
// when not.
//
// Overrides (config.toml, optional):
//   [llm]
//   vision_capable = true            # force the active model to be vision-capable
//   vision_models = ["gpt-4o", …]    # extra model ids that can see

const VISION_PATTERNS = [
  // OpenAI
  /\bgpt-?4[.\-]?o\b/i, /\bgpt-?4[.\-]?1\b/i, /\bgpt-?4[.\-]?5\b/i, /\bgpt-?5\b/i,
  /\bgpt-?4\.2\b/i, /\bgpt-?[45](\.\d+)?-?mini\b/i, /\bchatgpt-4o\b/i,
  // Anthropic
  /\bclaude-?3\b/i, /\bclaude-?3[.\-]\d/i, /\bclaude-?4\b/i, /\bclaude-?sonnet\b/i,
  /\bclaude-?opus\b/i, /\bclaude-?haiku\b/i, /\bclaude-3-5/i,
  // Google
  /\bgemini\b/i, /\bgemma-?3\b/i, /\bgoogle-.*(vision|vl)\b/i,
  // Qwen / Alibaba
  /\bqwen.*-?vl\b/i, /\bqwen-?omni\b/i, /\bqwen3?-?vl\b/i,
  // DeepSeek / Moonshot
  /\bdeepseek-?vl\b/i, /\bkimi-?vl\b/i, /\bmoonshot.*vl\b/i,
  // Llama / Mistral / others
  /\bllama-?3[.\-]?[12].*vision\b/i, /\bllama-?4\b/i, /\bllava\b/i, /\bpixtral\b/i,
  /\bmistral-?small.*(2503|2409|3[.\-]1)/i, /\bministral.*pixtral\b/i,
  /\bglm-?4.*v\b/i, /\bchatglm\b/i, /\binternvl\b/i, /\bminimax.*vl\b/i,
  /\bseed-?1\.6\b/i, /\bdoubao.*vision\b/i, /\bernie.*vl\b/i, /\bstep-?2.*vision\b/i,
  /\bomni-?modest\b/i, /\bunited-?ocr\b/i, /\bgot-?ocr\b/i, /\bdots-?ocr\b/i,
  /\bnemotron.*vision\b/i, /\bcogvlm\b/i, /\bmplug-?ocr\b/i, /\bhunyuan-?vl\b/i,
];

const OCR_PATTERNS = [
  /\bocr\b/i, /\bvision\b/i, /\bvl\b/i, /\bmultimodal\b/i, /\bllava\b/i,
  /\bomni\b/i, /\bpixtral\b/i, /\bgemma-?3\b/i,
];

function normalize(id) { return String(id || '').trim(); }

// Does this model id look like it can accept image parts?
function modelIsVisionCapable(modelId, cfg = {}) {
  const id = normalize(modelId);
  if (!id) return false;
  // Explicit per-model allow-list wins.
  const extra = cfg.llm && Array.isArray(cfg.llm.vision_models) ? cfg.llm.vision_models.map(normalize) : [];
  if (extra.some(m => m && (m === id || id.includes(m) || m.includes(id)))) return true;
  // Explicit global override.
  if (cfg.llm && typeof cfg.llm.vision_capable === 'boolean') return cfg.llm.vision_capable;
  return VISION_PATTERNS.some(re => re.test(id));
}

// Is this model an OCR-specialist (reads text out of images better than a
// general VLM)? Only a hint for the UI wording.
function modelIsOcrFocused(modelId) {
  const id = normalize(modelId);
  return OCR_PATTERNS.some(re => re.test(id));
}

module.exports = { modelIsVisionCapable, modelIsOcrFocused, VISION_PATTERNS };
