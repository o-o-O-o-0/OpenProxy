/**
 * OpenProxy - 代理服务器
 * 
 * 提供 OpenAI 和 Anthropic 双协议接口
 * 
 * CLI 参数: --port <port> --lan-access
 */

import { Router } from 'express';
import { createAuthMiddleware } from './proxy/middleware.js';
import { createAnthropicMessagesHandler, createModelsHandler, createOpenAIChatHandler } from './proxy/handlers.js';

/**
 * 创建代理服务器
 */
export function createProxyServer(config) {
  const router = Router();
  router.use(createAuthMiddleware(config));
  router.post('/messages', createAnthropicMessagesHandler(config));
  router.post('/chat/completions', createOpenAIChatHandler(config));
  router.get('/models', createModelsHandler(config));
  
  return router;
}
