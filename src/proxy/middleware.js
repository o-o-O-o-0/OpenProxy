import { createInvalidApiKeyResponse } from './errors.js';

function applyCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
}

export function createAuthMiddleware(config) {
  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      applyCorsHeaders(res);
      return res.sendStatus(204);
    }

    applyCorsHeaders(res);

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    if (config.proxy.apiKey && apiKey !== config.proxy.apiKey) {
      return res.status(401).json(createInvalidApiKeyResponse());
    }

    next();
  };
}
