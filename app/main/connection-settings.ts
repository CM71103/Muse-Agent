type Config = { llm: Record<string, any>; memory: Record<string, any> };

function modelId(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Model ID must be a string');
  const id = value.trim();
  if (!id || id.length > 256 || /[\s\u0000-\u001f\u007f",#\[\]\\]/.test(id)) throw new Error('Model ID must be 1–256 characters without whitespace or config delimiters');
  return id;
}

function normalizeVisibleModels(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('visible_models must be an array of at most 100 model IDs');
  return [...new Set(value.map(modelId))];
}

function visibleModels(cfg: Config): string[] {
  return cfg.llm.visible_models === undefined
    ? normalizeVisibleModels([cfg.llm.model]) : normalizeVisibleModels(cfg.llm.visible_models);
}

function validateSettingsPatch(patch: unknown): Record<string, any> {
  if (patch == null) return {};
  if (typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object');
  const value = patch as Record<string, any>;
  for (const key of ['base_url', 'model', 'api_key', 'embed_base_url', 'embed_model', 'embed_api_key']) {
    if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`${key} must be a string`);
  }
  if (value.model?.trim()) modelId(value.model);
  for (const key of ['base_url', 'embed_base_url']) {
    if (!value[key]?.trim()) continue;
    let url: URL;
    try { url = new URL(value[key].trim()); } catch { throw new Error(`${key} must be an HTTP or HTTPS URL`); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${key} must be an HTTP or HTTPS URL`);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol === 'http:' && !local) throw new Error(`${key} must use HTTPS except for a loopback endpoint`);
    if (url.username || url.password) throw new Error('Put your API key in the key field, not the endpoint URL');
  }
  if (value.temperature !== undefined && (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) {
    throw new Error('temperature must be a finite number between 0 and 2');
  }
  for (const key of ['max_tokens', 'context_tokens']) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key] <= 0)) throw new Error(`${key} must be a positive integer`);
  }
  return value.visible_models === undefined ? value : { ...value, visible_models: normalizeVisibleModels(value.visible_models) };
}

function assertConnectionKeyOrigins(cfg: Config, patch: Record<string, any>) {
  const origin = (value: string) => {
    try { return new URL(value).origin.toLowerCase(); } catch { return ''; }
  };
  const chatEndpoint = patch.base_url?.trim() || cfg.llm.base_url;
  const explicitChatKey = patch.api_key?.trim();
  const savedChatKey = cfg.llm.api_key || process.env[cfg.llm.api_key_env || 'MUSE_LLM_API_KEY'] || '';
  const savedChatOrigin = cfg.llm.key_origin || origin(cfg.llm.base_url);
  if (savedChatKey && !explicitChatKey && origin(chatEndpoint) !== savedChatOrigin.toLowerCase()) {
    throw new Error('Enter an API key for this endpoint; the saved chat key belongs to a different origin');
  }
  const oldEmbedEndpoint = cfg.memory.embed_base_url || cfg.llm.base_url;
  const embedOverride = patch.embed_base_url === undefined ? cfg.memory.embed_base_url : patch.embed_base_url.trim();
  const embedEndpoint = embedOverride || chatEndpoint;
  const savedEmbedKey = cfg.memory.embed_api_key || savedChatKey;
  const explicitEmbedKey = patch.embed_api_key?.trim() ||
    (!cfg.memory.embed_api_key && explicitChatKey && origin(embedEndpoint) === origin(chatEndpoint));
  if (savedEmbedKey && !explicitEmbedKey && origin(embedEndpoint) !== origin(oldEmbedEndpoint)) {
    throw new Error('Enter an embedding API key for this endpoint; the saved key belongs to a different origin');
  }
}

function extractionConfig(cfg: Config) {
  return {
    baseUrl: cfg.memory.llm_base_url || cfg.llm.base_url || '',
    apiKey: cfg.memory.llm_api_key || cfg.llm.api_key || process.env[cfg.llm.api_key_env || 'MUSE_LLM_API_KEY'] || '',
    model: cfg.memory.llm_model || cfg.llm.model || '',
  };
}

function embeddingSettingsChanged(memory: any, cfg: Config) {
  const expected = {
    baseUrl: cfg.memory.embed_base_url || cfg.llm.base_url || '',
    apiKey: cfg.memory.embed_api_key || cfg.llm.api_key || process.env[cfg.llm.api_key_env || 'MUSE_LLM_API_KEY'] || '',
    model: cfg.memory.embed_model || 'text-embedding-3-small',
    generation: cfg.memory.embed_generation || 'v1',
  };
  const normalizedUrl = (value: unknown) => String(value || '').replace(/\/+$/, '');
  if (normalizedUrl(memory.emb.baseUrl) !== normalizedUrl(expected.baseUrl)) return true;
  if (['apiKey', 'model', 'generation'].some(key => memory.emb[key] !== expected[key as keyof typeof expected])) return true;
  // Zero means auto-detect, not the adopted vector width already in emb.dims.
  return Number(memory.memCfg.embed_dims || 0) !== Number(cfg.memory.embed_dims || 0);
}

function applyChatSettings(agent: any, cfg: Config) {
  if (!agent) return;
  agent.cfg = cfg;
  agent.llm = new (require('../harness/llm').LlmClient)(cfg);
  agent.ctxBudget = cfg.llm.context_tokens || 200000;
  if (agent.memory) {
    agent.memory.cfg = cfg;
    agent.memory.memCfg = cfg.memory;
    agent.memory.xllm = extractionConfig(cfg);
  }
}

module.exports = { validateSettingsPatch, assertConnectionKeyOrigins, extractionConfig, embeddingSettingsChanged,
  modelId, normalizeVisibleModels, visibleModels, applyChatSettings };
