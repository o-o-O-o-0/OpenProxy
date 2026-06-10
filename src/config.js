/**
 * OpenProxy - 配置管理
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXED_PROXY_PORT = 3210;

function normalizeConfig(config = {}) {
  if (!config.proxy || typeof config.proxy !== 'object') {
    config.proxy = {};
  }

  config.proxy.port = FIXED_PROXY_PORT;
  config.proxy.host = config.proxy.lanAccess ? '0.0.0.0' : '127.0.0.1';

  if (!config.backend || typeof config.backend !== 'object') {
    config.backend = {};
  }
  if (!config.backend.opencode || typeof config.backend.opencode !== 'object') {
    config.backend.opencode = {};
  }
  if (!config.backend.custom || typeof config.backend.custom !== 'object') {
    config.backend.custom = {};
  }
  delete config.backend.openai;
  delete config.backend.type;

  if (!config.ui || typeof config.ui !== 'object') {
    config.ui = {};
  }
  config.ui.modelSource = config.ui.modelSource === 'custom' ? 'custom' : 'opencode';

  if (!config.privacy || typeof config.privacy !== 'object') {
    config.privacy = {};
  }
  config.privacy.enabled = config.privacy.enabled !== false;
  config.privacy.redactAssistantMessages = config.privacy.redactAssistantMessages !== false;
  config.privacy.redactToolResults = config.privacy.redactToolResults !== false;
  config.privacy.logHits = config.privacy.logHits !== false;

  delete config.security;

  return config;
}

/**
 * 生成随机 API Key
 */
export function generateApiKey() {
  const prefix = 'op-';
  const random = randomBytes(16).toString('hex');
  return `${prefix}${random}`;
}

/**
 * 加载配置
 */
export function loadConfig() {
  const configPath = join(__dirname, '..', 'config', 'default.json');
  
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      return normalizeConfig(config);
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }
  
  // 返回默认配置
  return normalizeConfig(getDefaultConfig());
}

/**
 * 获取默认配置
 */
function getDefaultConfig() {
  return {
    proxy: {
      host: '127.0.0.1',
      port: FIXED_PROXY_PORT,
      lanAccess: false,
      apiKey: generateApiKey(),
      timeout: 3000000
    },
    model: {
      available: []
    },
    privacy: {
      enabled: true,
      redactAssistantMessages: true,
      redactToolResults: true,
      logHits: true,
    },
    ui: {
      modelSource: 'opencode'
    },
    backend: {
      opencode: {
        baseUrl: 'https://opencode.ai/zen/v1/chat/completions',
        upstreamApiKey: 'public'
      },
      custom: {
        baseUrl: '',
        apiKey: '',
        resolvedBaseUrl: ''
      }
    }
  };
}
