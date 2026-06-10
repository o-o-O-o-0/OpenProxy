/**
 * OpenProxy - Node.js 代理后端
 * 
 * 提供 OpenAI 和 Anthropic 双协议接口
 * 代理 OpenCode 免费模型
 * 
 * CLI 参数: --port <port> --lan-access
 */

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { applyCliOverrides, parseArgs } from './runtime-config.js';
import { createProxyServer } from './server.js';

const REQUEST_BODY_LIMIT = '64mb';
const NODE_LOG_PATH = process.env.OPENPROXY_NODE_LOG_PATH || path.join(os.tmpdir(), 'openproxy-node.log');

function formatLogError(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function appendNodeLog(level, message, error = null) {
  const timestamp = new Date().toISOString();
  const detail = error ? `\n${formatLogError(error)}` : '';
  const line = `[${timestamp}] [${level}] ${message}${detail}\n`;

  try {
    fs.appendFileSync(NODE_LOG_PATH, line);
  } catch {
  }
}

process.on('uncaughtException', (error) => {
  appendNodeLog('FATAL', 'Uncaught exception', error);
  console.error('[FATAL] Uncaught exception:', error);
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  appendNodeLog('FATAL', 'Unhandled rejection', reason);
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exitCode = 1;
});

const cliArgs = parseArgs();
const config = applyCliOverrides(loadConfig(), cliArgs);

function replaceRuntimeConfig(nextConfig) {
  for (const key of Object.keys(config)) {
    delete config[key];
  }
  Object.assign(config, nextConfig);
  return config;
}

function reloadRuntimeConfig(nextConfig = null) {
  return replaceRuntimeConfig(nextConfig || applyCliOverrides(loadConfig(), cliArgs));
}

appendNodeLog('INFO', `OpenProxy bootstrap pid=${process.pid}`);

const app = express();

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key')
}

app.use((req, res, next) => {
  applyCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }
  next()
})

// 解析请求体（支持 OpenAI 和 Anthropic 的 Content-Type）
app.use(express.json({ type: 'application/json', limit: REQUEST_BODY_LIMIT }));
app.use(express.json({ type: 'application/vnd.api+json', limit: REQUEST_BODY_LIMIT }));

// 创建代理服务器
const proxyServer = createProxyServer(config);

// 挂载 API 路由
app.use('/v1', proxyServer);

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', port: config.proxy.port, features: ['shutdown', 'reload-config'] });
});

app.post('/reload-config', (req, res) => {
  const auth = req.get('authorization') || ''
  const expected = `Bearer ${config.proxy.apiKey}`

  if (auth !== expected) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const nextConfig = reloadRuntimeConfig()
    appendNodeLog('INFO', 'Reloaded runtime config');
    res.json({ status: 'ok', port: nextConfig.proxy.port })
  } catch (error) {
    appendNodeLog('ERROR', 'Failed to reload runtime config', error);
    res.status(500).json({ error: { message: error.message, type: 'reload_failed' } })
  }
})

app.post('/shutdown', (req, res) => {
  const auth = req.get('authorization') || ''
  const expected = `Bearer ${config.proxy.apiKey}`

  if (auth !== expected) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  res.json({ status: 'shutting_down' })
  appendNodeLog('INFO', 'Received authenticated shutdown request');

  // Delay exit until the response is flushed.
  setImmediate(() => {
    server.close(() => {
      appendNodeLog('INFO', 'Server closed from /shutdown handler');
      process.exit(0)
    })
  })
})

app.use((err, req, res, next) => {
  appendNodeLog('ERROR', `Express middleware error ${req?.method || 'UNKNOWN'} ${req?.originalUrl || '[unknown]'}`, err);

  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        message: `Request payload too large. Current limit is ${REQUEST_BODY_LIMIT}.`,
        type: 'payload_too_large',
      }
    });
  }

  return next(err);
});

// 启动服务器
const host = config.proxy.host;
const server = app.listen(config.proxy.port, host, () => {
  const mode = config.proxy.lanAccess ? 'LAN' : 'localhost';
  appendNodeLog('INFO', `OpenProxy running at http://${host}:${config.proxy.port} [${mode}]`);
  console.log(`OpenProxy running at http://${host}:${config.proxy.port} [${mode}]`);
});

server.on('error', (error) => {
  appendNodeLog('ERROR', 'HTTP server emitted error', error);
  console.error('[ERROR] HTTP server emitted error:', error);

  if (error?.code === 'EADDRINUSE') {
    appendNodeLog('FATAL', `Port ${config.proxy.port} is already in use; exiting failed proxy process`);
    process.exit(1);
  }
});

// 优雅关闭
process.on('SIGINT', () => {
  appendNodeLog('INFO', 'Received SIGINT');
  console.log('Shutting down...');
  server.close(() => {
    appendNodeLog('INFO', 'Server closed after SIGINT');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  appendNodeLog('INFO', 'Received SIGTERM');
  console.log('Shutting down...');
  server.close(() => {
    appendNodeLog('INFO', 'Server closed after SIGTERM');
    process.exit(0);
  });
});

export { server };
