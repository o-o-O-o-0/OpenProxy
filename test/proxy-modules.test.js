import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchModelsResponse } from '../src/proxy/models-service.js';
import { createAuthMiddleware } from '../src/proxy/middleware.js';
import {
  forwardOpenAIStreamToUpstream,
  forwardToUpstream,
} from '../src/proxy/upstream.js';
import {
  shouldUseStreamingResponse,
  createAnthropicMessagesHandler,
  createModelsHandler,
  createOpenAIChatHandler,
} from '../src/proxy/handlers.js';
import {
  getCustomChatUrlCandidates,
  getCustomModelUrlCandidates,
  getActiveAnthropicMessageUrlCandidates,
  parseGatewayModelId,
} from '../src/proxy/backend.js';
import { applyCliOverrides, parseArgs } from '../src/runtime-config.js';
import {
  redactAnthropicMessagesRequest,
  redactOpenAIChatRequest,
  redactText,
} from '../src/proxy/privacy-filter.js';
import { convertAnthropicToOpenAI } from '../src/convert.js';

test('redactText redacts PII and secrets while preserving common non-secrets', () => {
  const pii = redactText('联系 test.user@example.com 手机 13812345678 token=' + 'sk-' + 'abcdefghijklmnopqrst' + 'T3BlbkFJ' + 'abcdefghijklmnopqrst' + '');
  assert.match(pii.text, /\[PRIVATE_EMAIL\]/);
  assert.match(pii.text, /\[PRIVATE_PHONE\]/);
  assert.match(pii.text, /\[PRIVATE_SECRET\]/);

  assert.equal(redactText('ssh user@host.example.com').hit, false);
  assert.equal(redactText('ls /home/user/AbCdEfGh1234567890XyZ').hit, false);
  assert.equal(redactText('order_id=AbCdEfGh1234567890XyZ').hit, false);
  assert.equal(redactText('Authorization: Bearer abcDEF1234567890/xyzABC4567890==').hit, true);
});

test('redactOpenAIChatRequest redacts message history by default', () => {
  const body = {
    model: 'opencode/demo',
    messages: [
      { role: 'user', content: '我的邮箱是 a@b.com' },
      { role: 'assistant', content: '历史里有手机 13812345678' },
    ],
  };
  const result = redactOpenAIChatRequest(body, { privacy: { enabled: true } });
  assert.equal(result.count, 2);
  assert.equal(body.messages[0].content, '我的邮箱是 [PRIVATE_EMAIL]');
  assert.equal(body.messages[1].content, '历史里有手机 [PRIVATE_PHONE]');
});

test('redactText does not treat version-like strings as IPv4 addresses', () => {
  const version = redactText('x-anthropic-billing-header: cc_version=2.1.150.32b; cch=abcde;');
  assert.equal(version.hit, false);
  assert.equal(version.text, 'x-anthropic-billing-header: cc_version=2.1.150.32b; cch=abcde;');

  const ip = redactText('服务器 IP 是 192.168.1.10，请检查。');
  assert.equal(ip.hit, true);
  assert.equal(ip.text, '服务器 IP 是 [PRIVATE_IP]，请检查。');
});

test('redactAnthropicMessagesRequest redacts string system and message content', () => {
  const body = {
    system: '系统提示包含 token=' + 'sk-' + 'abcdefghijklmnopqrst' + 'T3BlbkFJ' + 'abcdefghijklmnopqrst' + '',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '身份证 11010519900307743X' }] },
    ],
  };
  const result = redactAnthropicMessagesRequest(body, { privacy: { enabled: true } });
  assert.equal(result.count, 2);
  assert.equal(body.system, '系统提示包含 [PRIVATE_SECRET]');
  assert.equal(body.messages[0].content[0].text, '身份证 [PRIVATE_ID_CARD]');
});

test('redactAnthropicMessagesRequest redacts system text blocks before native forwarding', () => {
  const body = {
    system: [
      { type: 'text', text: '系统提示，联系 admin@example.com' },
      { type: 'text', text: '服务器 IP 是 192.168.1.10' },
      { type: 'cache_control', ephemeral: true },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
    ],
  };

  const result = redactAnthropicMessagesRequest(body, { privacy: { enabled: true } });

  assert.equal(result.count, 2);
  assert.equal(Array.isArray(body.system), true);
  assert.equal(body.system[0].text, '系统提示，联系 [PRIVATE_EMAIL]');
  assert.equal(body.system[1].text, '服务器 IP 是 [PRIVATE_IP]');
  assert.deepEqual(body.system[2], { type: 'cache_control', ephemeral: true });
});

test('redactAnthropicMessagesRequest preserves system when privacy disabled', () => {
  const body = {
    system: [
      { type: 'text', text: '系统提示，联系 admin@example.com' },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '身份证 11010519900307743X' }] },
    ],
  };

  const result = redactAnthropicMessagesRequest(body, { privacy: { enabled: false } });

  assert.equal(result.count, 0);
  assert.equal(body.system[0].text, '系统提示，联系 admin@example.com');
  assert.equal(body.messages[0].content[0].text, '身份证 11010519900307743X');
});

test('redactAnthropicMessagesRequest redacts tool_result content by default', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: [{ type: 'text', text: '查询到手机号 13812345678' }] },
          { type: 'tool_result', tool_use_id: 'tool_2', content: '邮箱是 a@b.com' },
        ],
      },
    ],
  };

  const result = redactAnthropicMessagesRequest(body, { privacy: { enabled: true } });

  assert.equal(result.count, 2);
  assert.equal(body.messages[0].content[0].content[0].text, '查询到手机号 [PRIVATE_PHONE]');
  assert.equal(body.messages[0].content[1].content, '邮箱是 [PRIVATE_EMAIL]');
});

test('redactAnthropicMessagesRequest can preserve tool_result content', () => {
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: '手机号 13812345678' },
        ],
      },
    ],
  };

  const result = redactAnthropicMessagesRequest(body, {
    privacy: { enabled: true, redactToolResults: false },
  });

  assert.equal(result.count, 0);
  assert.equal(body.messages[0].content[0].content, '手机号 13812345678');
});

test('converted Anthropic phone history is redacted through OpenAI privacy path', () => {
  const body = {
    model: 'demo-model',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '这是我的手机号 19158351403' }] },
      { role: 'assistant', content: [{ type: 'text', text: '收到，谢谢分享。' }] },
      { role: 'user', content: [{ type: 'text', text: '我的手机号是什么' }] },
    ],
  };

  const converted = convertAnthropicToOpenAI(body);
  redactOpenAIChatRequest(converted, { privacy: { enabled: true } });

  assert.equal(converted.messages[0].content, '这是我的手机号 [PRIVATE_PHONE]');
  assert.equal(converted.messages[1].content, '收到，谢谢分享。');
  assert.equal(converted.messages[2].content, '我的手机号是什么');
});

test('fetchModelsResponse rejects when OpenCode models cannot be fetched offline', async () => {
  const config = createConfig();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };

  try {
    await assert.rejects(
      fetchModelsResponse(config),
      (error) => {
        assert.equal(error.code, 'MODEL_FETCH_ALL_FAILED');
        assert.ok(error.warnings.some(item => item.source === 'opencode' && item.code === 'MODEL_FETCH_NETWORK_ERROR'));
        assert.deepEqual(config.model.available, []);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchModelsResponse auto-detects custom /v1 root from bare base URL', async () => {
  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => {
    attempts.push(url);
    if (url === 'https://custom.example.com/v1/models') {
      return {
        ok: true,
        async json() {
          return {
            data: [
              { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', input_modalities: ['text'] },
            ],
          };
        },
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return 'not found';
      },
    };
  };

  try {
    const config = createConfig({
      backend: {
        custom: {
          baseUrl: 'https://custom.example.com',
          apiKey: 'sk-demo',
        },
      },
    });

    const response = await fetchModelsResponse(config);

    assert.deepEqual(attempts.filter(url => String(url).includes('custom.example.com')), ['https://custom.example.com/v1/models']);
    assert.equal(response.source, 'custom');
    assert.ok(response.warnings.some(item => item.source === 'opencode'));
    assert.ok(response.data.some(model => model.id === 'custom/gpt-4.1-mini'));
    assert.equal(config.backend.custom.resolvedBaseUrl, 'https://custom.example.com/v1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchModelsResponse prefixes slash-containing custom model ids', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'https://models.dev/api.json') {
      return {
        ok: true,
        async json() {
          return { opencode: { models: {} } };
        },
      };
    }

    if (url === 'https://custom.example.com/v1/models') {
      return {
        ok: true,
        async json() {
          return { data: [{ id: 'openai/gpt-4.1', input_modalities: ['text'] }] };
        },
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return 'not found';
      },
    };
  };

  try {
    const response = await fetchModelsResponse(createConfig({
      backend: {
        custom: {
          baseUrl: 'https://custom.example.com',
          apiKey: 'sk-demo',
        },
      },
    }));

    assert.equal(response.source, 'custom');
    assert.ok(response.warnings.some(item => item.source === 'opencode'));
    assert.ok(response.data.some(model => model.id === 'custom/openai/gpt-4.1'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchModelsResponse tries non-v1 fallback when /v1/models is missing', async () => {
  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => {
    attempts.push(url);
    if (url === 'https://custom.example.com/models') {
      return {
        ok: true,
        async json() {
          return {
            data: [
              { id: 'deepseek-chat', input_modalities: ['text'] },
            ],
          };
        },
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return 'not found';
      },
    };
  };

  try {
    const config = createConfig({
      backend: {
        custom: {
          baseUrl: 'https://custom.example.com',
          apiKey: 'sk-demo',
        },
      },
    });

    const response = await fetchModelsResponse(config);

    assert.deepEqual(attempts.filter(url => String(url).includes('custom.example.com')), [
      'https://custom.example.com/v1/models',
      'https://custom.example.com/models',
    ]);
    assert.equal(response.source, 'custom');
    assert.ok(response.warnings.some(item => item.source === 'opencode'));
    assert.ok(response.data.some(model => model.id === 'custom/deepseek-chat'));
    assert.equal(config.backend.custom.resolvedBaseUrl, 'https://custom.example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('custom URL candidate builders accept base URL with or without /v1', () => {
  const bare = createConfig({
    backend: {
      custom: {
        baseUrl: 'https://custom.example.com',
        apiKey: 'sk-demo',
      },
    },
  });
  const withV1 = createConfig({
    backend: {
      custom: {
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'sk-demo',
      },
    },
  });

  assert.deepEqual(getCustomModelUrlCandidates(bare), [
    'https://custom.example.com/v1/models',
    'https://custom.example.com/models',
  ]);
  assert.deepEqual(getCustomChatUrlCandidates(bare), [
    'https://custom.example.com/v1/chat/completions',
    'https://custom.example.com/chat/completions',
  ]);
  assert.deepEqual(getCustomModelUrlCandidates(withV1), [
    'https://custom.example.com/v1/models',
    'https://custom.example.com/models',
  ]);
});

test('parseGatewayModelId requires explicit source prefix', () => {
  assert.deepEqual(parseGatewayModelId('custom/openai/gpt-4.1'), {
    id: 'custom/openai/gpt-4.1',
    source: 'custom',
    upstreamId: 'openai/gpt-4.1',
  });
  assert.deepEqual(parseGatewayModelId('opencode/demo'), {
    id: 'opencode/demo',
    source: 'opencode',
    upstreamId: 'demo',
  });
  assert.throws(() => parseGatewayModelId('openai/gpt-4.1'), /missing source prefix/);
  assert.throws(() => parseGatewayModelId('demo'), /missing source prefix/);
});

test('runtime CLI overrides apply backend and upstream settings', () => {
  const cliArgs = parseArgs([
    '--custom-base-url', 'https://custom.example.com/v1',
    '--custom-api-key', 'sk-demo',
    '--opencode-base-url', 'https://fallback.example.com/v1/chat/completions',
    '--opencode-upstream-api-key', 'public-alt',
    '--privacy-enabled', 'false',
  ]);

  const config = applyCliOverrides(createConfig(), cliArgs);

  assert.equal(config.backend.custom.baseUrl, 'https://custom.example.com/v1');
  assert.equal(config.backend.custom.apiKey, 'sk-demo');
  assert.equal(config.backend.opencode.baseUrl, 'https://fallback.example.com/v1/chat/completions');
  assert.equal(config.backend.opencode.upstreamApiKey, 'public-alt');
  assert.equal(config.privacy.enabled, false);
});

function createMockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    endedWith: null,
    writes: [],
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.headersSent = true;
      this.body = payload;
      return this;
    },
    write(chunk) {
      this.headersSent = true;
      this.writes.push(chunk);
    },
    end() {
      this.headersSent = true;
      this.endedWith = 'end';
      return this;
    },
    sendStatus(code) {
      this.headersSent = true;
      this.endedWith = code;
      this.statusCode = code;
      return this;
    }
  };
}

function createConfig(overrides = {}) {
  return {
    proxy: {
      apiKey: 'secret',
      timeout: 1000,
      ...overrides.proxy,
    },
    backend: {
      opencode: {
        baseUrl: 'https://example.test/v1/chat/completions',
        upstreamApiKey: 'public',
        ...overrides.backend?.opencode,
      },
      custom: {
        baseUrl: '',
        apiKey: '',
        resolvedBaseUrl: '',
        ...overrides.backend?.custom,
      },
      ...overrides.backend,
    },
    model: {
      available: [],
      ...overrides.model,
    }
  };
}

function createFailingReadableStream(message = 'stream failed') {
  return new ReadableStream({
    start(controller) {
      controller.error(new Error(message));
    }
  });
}

function createPartialThenFailReadableStream(chunks, message = 'stream failed after output') {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
        return;
      }

      controller.error(new Error(message));
    }
  });
}

function createDelayedReadableStream(chunks, delayMs = 25) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      await new Promise(resolve => setTimeout(resolve, delayMs));
      const chunk = chunks[index++];
      controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk);
    }
  });
}

test('createAuthMiddleware allows valid API key and applies CORS headers', async () => {
  const middleware = createAuthMiddleware({ proxy: { apiKey: 'secret' } });
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer secret' }
  };
  const res = createMockResponse();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'GET, POST, OPTIONS');
});

test('createAuthMiddleware rejects invalid API key', async () => {
  const middleware = createAuthMiddleware({ proxy: { apiKey: 'secret' } });
  const req = {
    method: 'POST',
    headers: { 'x-api-key': 'wrong' }
  };
  const res = createMockResponse();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.type, 'invalid_api_key');
});

test('createAuthMiddleware short-circuits OPTIONS preflight', async () => {
  const middleware = createAuthMiddleware({ proxy: { apiKey: 'secret' } });
  const req = {
    method: 'OPTIONS',
    headers: {}
  };
  const res = createMockResponse();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.endedWith, 204);
  assert.equal(res.headers['Access-Control-Allow-Headers'], 'Content-Type, Authorization, x-api-key');
});

test('shouldUseStreamingResponse honors explicit stream flag', async () => {
  assert.equal(shouldUseStreamingResponse({ stream: true }, ''), true);
  assert.equal(shouldUseStreamingResponse({ stream: false }, 'application/json'), false);
});

test('shouldUseStreamingResponse enables SSE via Accept header', async () => {
  assert.equal(shouldUseStreamingResponse({}, 'text/event-stream'), true);
  assert.equal(shouldUseStreamingResponse({}, 'application/json, text/event-stream'), true);
});

test('forwardToUpstream throws proxy error on upstream 500', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      return 'upstream exploded';
    }
  });

  try {
    await assert.rejects(
      forwardToUpstream({ model: 'opencode/demo', messages: [] }, createConfig()),
      /Upstream error 500 at https:\/\/example\.test\/v1\/chat\/completions for model opencode\/demo: upstream exploded/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwardToUpstream sends normalized OpenAI-compatible request body', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { id: 'chatcmpl_1', choices: [] };
      },
    };
  };

  try {
    await forwardToUpstream({
      model: 'opencode/demo',
      max_tokens: 1,
      stream_options: { include_usage: true },
      parallel_tool_calls: true,
      tools: [],
      tool_choice: 'auto',
      messages: [{ role: 'developer', content: 'dev' }, { role: 'user', content: 'hi' }],
    }, createConfig());

    assert.equal(sentBody.max_tokens, 16);
    assert.equal(sentBody.messages[0].role, 'system');
    assert.equal('stream_options' in sentBody, false);
    assert.equal('parallel_tool_calls' in sentBody, false);
    assert.equal('tools' in sentBody, false);
    assert.equal('tool_choice' in sentBody, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwardToUpstream strips custom prefix with slash-containing upstream model ids', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return { id: 'chatcmpl_slash', choices: [] };
      },
    };
  };

  try {
    await forwardToUpstream({ model: 'custom/openai/gpt-4.1', messages: [] }, createConfig({
      backend: {
        custom: {
          baseUrl: 'https://custom.example.com',
          apiKey: 'sk-demo',
        },
      },
    }));
    assert.equal(sentBody.model, 'openai/gpt-4.1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwardToUpstream falls back from /v1/chat/completions to /chat/completions for custom service', async () => {
  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => {
    attempts.push(url);
    if (url === 'https://custom.example.com/chat/completions') {
      return {
        ok: true,
        async json() {
          return { id: 'chatcmpl_1', choices: [] };
        },
      };
    }

    return {
      ok: false,
      status: 404,
      async text() {
        return 'not found';
      },
    };
  };

  try {
    const config = createConfig({
      backend: {
        custom: {
          baseUrl: 'https://custom.example.com',
          apiKey: 'sk-demo',
        },
      },
    });

    const response = await forwardToUpstream({ model: 'custom/demo', messages: [] }, config);
    assert.deepEqual(attempts, [
      'https://custom.example.com/v1/chat/completions',
      'https://custom.example.com/chat/completions',
    ]);
    assert.deepEqual(response, { id: 'chatcmpl_1', choices: [] });
    assert.equal(config.backend.custom.resolvedBaseUrl, 'https://custom.example.com');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwardOpenAIStreamToUpstream returns proxy error when SSE pipe fails before output', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    body: createFailingReadableStream('openai stream failed')
  });

  const res = createMockResponse();

  try {
    await forwardOpenAIStreamToUpstream({ model: 'opencode/demo', messages: [] }, createConfig(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.type, 'proxy_error');
    assert.match(res.body.error.message, /openai stream failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwardOpenAIStreamToUpstream does not write JSON error after headers were sent', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    body: createPartialThenFailReadableStream(['data: first chunk\n\n'], 'openai stream failed late')
  });

  const res = createMockResponse();

  try {
    await forwardOpenAIStreamToUpstream({ model: 'opencode/demo', messages: [] }, createConfig(), res);
    assert.equal(res.headersSent, true);
    assert.equal(res.body, null);
    assert.equal(res.statusCode, 200);
    assert.equal(res.writes.length, 1);
    assert.equal(res.endedWith, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createAnthropicMessagesHandler bridges OpenCode Anthropic requests through OpenAI', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = null;
  let sentBody = null;
  globalThis.fetch = async (url, options) => {
    requestedUrl = url;
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          id: 'chatcmpl_bridge',
          model: 'opencode/demo',
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: 'Calling tool',
              tool_calls: [{
                id: 'call_1',
                function: { name: 'lookup', arguments: '{"city":"杭州"}' },
              }],
            },
          }],
        };
      },
    };
  };

  const handler = createAnthropicMessagesHandler(createConfig());
  const req = {
    body: {
      model: 'opencode/demo',
      max_tokens: 128,
      tools: [{ name: 'lookup', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'tool', name: 'lookup' },
      messages: [{ role: 'user', content: [{ type: 'text', text: '查杭州天气' }] }],
    },
    method: 'POST',
    originalUrl: '/v1/messages',
    headers: {},
  };
  const res = createMockResponse();

  try {
    await handler(req, res);
    assert.equal(requestedUrl, 'https://example.test/v1/chat/completions');
    assert.equal(sentBody.messages[0].content, '查杭州天气');
    assert.equal(sentBody.tools[0].function.name, 'lookup');
    assert.deepEqual(sentBody.tool_choice, { type: 'function', function: { name: 'lookup' } });
    assert.equal(res.body.stop_reason, 'tool_use');
    assert.equal(res.body.content[1].type, 'tool_use');
    assert.deepEqual(res.body.content[1].input, { city: '杭州' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createAnthropicMessagesHandler redacts Claude bridge requests after OpenAI conversion', async () => {
  const originalFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, options) => {
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          id: 'chatcmpl_bridge_privacy',
          model: 'opencode/demo',
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        };
      },
    };
  };

  const body = {
    model: 'opencode/demo',
    system: [{ type: 'text', text: '系统联系 admin@example.com' }],
    max_tokens: 128,
    messages: [{ role: 'user', content: [{ type: 'text', text: '我的手机号 19158351403' }] }],
  };
  const handler = createAnthropicMessagesHandler(createConfig());
  const res = createMockResponse();

  try {
    await handler({ body, method: 'POST', originalUrl: '/v1/messages', headers: {} }, res);
    assert.equal(body.system[0].text, '系统联系 admin@example.com');
    assert.equal(body.messages[0].content[0].text, '我的手机号 19158351403');
    assert.equal(sentBody.messages[0].role, 'system');
    assert.equal(sentBody.messages[0].content, '系统联系 [PRIVATE_EMAIL]');
    assert.equal(sentBody.messages[1].content, '我的手机号 [PRIVATE_PHONE]');
    assert.equal(res.body.content[0].text, 'ok');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createAnthropicMessagesHandler passes custom upstream Anthropic requests through natively', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = null;
  let sentBody = null;
  globalThis.fetch = async (url, options) => {
    requestedUrl = url;
    sentBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool_1', name: 'lookup', input: { city: '杭州' } }],
          stop_reason: 'tool_use',
        };
      },
    };
  };

  const config = createConfig({
    backend: {
      custom: {
        baseUrl: 'https://custom.example.com',
        apiKey: 'sk-demo',
      },
    },
  });
  const handler = createAnthropicMessagesHandler(config);
  const body = {
    model: 'custom/demo',
    system: [
      { type: 'text', text: '系统联系 admin@example.com' },
    ],
    max_tokens: 128,
    tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'lookup' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '查杭州天气' }] }],
  };
  const res = createMockResponse();

  try {
    await handler({ body, method: 'POST', originalUrl: '/v1/messages', headers: {} }, res);
    assert.equal(requestedUrl, 'https://custom.example.com/v1/messages');
    assert.equal(sentBody.model, 'demo');
    assert.equal(sentBody.system[0].text, '系统联系 [PRIVATE_EMAIL]');
    assert.deepEqual(sentBody.messages, body.messages);
    assert.equal(res.body.content[0].type, 'tool_use');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createOpenAIChatHandler returns 400 for unprefixed model ids', async () => {
  const handler = createOpenAIChatHandler(createConfig());
  const req = {
    body: { model: 'demo', messages: [{ role: 'user', content: 'hello' }], stream: false },
    method: 'POST',
    originalUrl: '/v1/chat/completions',
    headers: {}
  };
  const res = createMockResponse();

  await handler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, 'MODEL_SOURCE_PREFIX_REQUIRED');
});

test('createOpenAIChatHandler converts upstream 500 into proxy error response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 500,
    async text() {
      return 'handler upstream failed';
    }
  });

  const handler = createOpenAIChatHandler(createConfig());
  const req = {
    body: { model: 'opencode/demo', messages: [{ role: 'user', content: 'hello' }], stream: false },
    method: 'POST',
    originalUrl: '/v1/chat/completions',
    headers: {}
  };
  const res = createMockResponse();

  try {
    await handler(req, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.type, 'proxy_error');
    assert.match(res.body.error.message, /handler upstream failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createModelsHandler returns proxy error when all model sources fail offline', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline');
  };

  const handler = createModelsHandler(createConfig({
    backend: {
      custom: {
        baseUrl: 'https://custom.example.com',
        apiKey: 'sk-demo',
      },
    },
  }));
  const res = createMockResponse();

  try {
    await handler({ method: 'GET', originalUrl: '/v1/models', headers: {} }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error.code, 'MODEL_FETCH_ALL_FAILED');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
