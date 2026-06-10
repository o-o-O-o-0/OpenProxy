/**
 * OpenProxy - 免费模型动态获取
 * 
 * 从 models.dev API 拉取 OpenCode 免费模型列表
 * 支持缓存（1h TTL + 6h 定时刷新）
 */

const FREE_MODELS = {
  API_URL: 'https://models.dev/api.json',
  CACHE_TTL: 3_600_000,              // 1 小时
  CACHE_REFRESH_INTERVAL: 6 * 3600_000, // 6 小时
  FETCH_TIMEOUT: 10000,               // 10 秒超时
};

let cache = { models: null, expiry: 0 };

/**
 * 获取免费模型列表
 */
export async function fetchFreeModels() {
  // 1. 检查缓存
  if (cache.models && Date.now() < cache.expiry) {
    return cache.models;
  }
  
  try {
    // 2. 从 models.dev 拉取
    const resp = await fetch(FREE_MODELS.API_URL, {
      signal: AbortSignal.timeout(FREE_MODELS.FETCH_TIMEOUT)
    });
    const data = await resp.json();
    const opencode = data?.opencode;
    
    // 3. 筛选免费模型
    const freeModels = [];
    for (const [id, model] of Object.entries(opencode?.models || {})) {
      if (model.status === 'deprecated') continue;
      const cost = model.cost || {};
      if (cost.input === 0 && cost.output === 0) {
        freeModels.push({
          id,
          name: model.name || id,
          reasoning: model.reasoning || false,
          input: model.modalities?.input || ['text'],
          contextWindow: model.limit?.context || 128000,
          maxTokens: model.limit?.output || 32000,
        });
      }
    }
    
    // 4. 缓存 + 返回
    if (freeModels.length > 0) {
      cache.models = freeModels;
      cache.expiry = Date.now() + FREE_MODELS.CACHE_TTL;
      return freeModels;
    }
  } catch (error) {
    console.error('Failed to fetch models from models.dev:', error.message);
    const fetchError = new Error('Failed to fetch OpenCode free models');
    fetchError.code = 'MODEL_FETCH_NETWORK_ERROR';
    fetchError.cause = error;
    throw fetchError;
  }

  const emptyError = new Error('OpenCode free model list is empty');
  emptyError.code = 'MODEL_FETCH_EMPTY';
  throw emptyError;
}
