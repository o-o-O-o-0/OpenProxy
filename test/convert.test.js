import test from 'node:test';
import assert from 'node:assert/strict';
import {
  convertAnthropicToOpenAI,
  convertOpenAIResponse,
  convertOpenAISSEToAnthropicSSE,
  createAnthropicSSEPingEvent,
} from '../src/convert.js';
import { normalizeOpenAIRequest } from '../src/proxy/upstream.js';

test('normalizeOpenAIRequest converts developer role to system', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    messages: [
      { role: 'developer', content: 'dev instructions' },
      { role: 'user', content: 'hello' },
    ],
  });

  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[0].content, 'dev instructions');
  assert.equal(result.messages[1].role, 'user');
});

test('normalizeOpenAIRequest leaves non-developer roles unchanged', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
  });

  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[1].role, 'user');
  assert.equal(result.messages[2].role, 'assistant');
});

test('normalizeOpenAIRequest returns input unchanged if no messages', () => {
  const body = { model: 'test-model' };
  const result = normalizeOpenAIRequest(body);
  assert.deepEqual(result, body);
});

test('normalizeOpenAIRequest preserves other fields', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.model, 'test-model');
  assert.equal(result.max_tokens, 100);
  assert.equal(result.stream, true);
});

test('normalizeOpenAIRequest removes fields that commonly break OpenAI-compatible upstreams', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    stream_options: { include_usage: true },
    parallel_tool_calls: true,
    store: false,
    metadata: { source: 'test' },
    user: 'local-user',
  });

  assert.equal('stream_options' in result, false);
  assert.equal('parallel_tool_calls' in result, false);
  assert.equal('store' in result, false);
  assert.equal('metadata' in result, false);
  assert.equal('user' in result, false);
});

test('normalizeOpenAIRequest raises tiny max_tokens to a safer minimum', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.max_tokens, 16);
});

test('normalizeOpenAIRequest maps max_completion_tokens and avoids conflicts', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    max_completion_tokens: 8,
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(result.max_tokens, 16);
  assert.equal('max_completion_tokens' in result, false);
});

test('normalizeOpenAIRequest drops empty tools and invalid tool_choice', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    tool_choice: { type: 'function', function: { name: 'missing' } },
  });

  assert.equal('tools' in result, false);
  assert.equal('tool_choice' in result, false);
});

test('normalizeOpenAIRequest keeps valid tool_choice', () => {
  const result = normalizeOpenAIRequest({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    tool_choice: { type: 'function', function: { name: 'lookup' } },
  });

  assert.equal(result.tool_choice.function.name, 'lookup');
});

function createSSEStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    }
  });
}

async function readStreamText(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

function parseSSEPayloads(text) {
  return text
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const dataLine = block
        .split('\n')
        .find(line => line.startsWith('data: '));
      return JSON.parse(dataLine.replace(/^data:\s*/, ''));
    });
}

test('convertAnthropicToOpenAI maps tools and tool_choice for OpenCode bridge', () => {
  const result = convertAnthropicToOpenAI({
    model: 'demo-model',
    max_tokens: 256,
    stream: false,
    system: [{ type: 'text', text: 'system one' }],
    tools: [{
      name: 'get_weather',
      description: 'Get weather',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    }],
    tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [{ role: 'user', content: [{ type: 'text', text: '杭州天气' }] }],
  });

  assert.equal(result.messages[0].role, 'system');
  assert.equal(result.messages[1].content, '杭州天气');
  assert.equal(result.tools[0].type, 'function');
  assert.equal(result.tools[0].function.name, 'get_weather');
  assert.deepEqual(result.tool_choice, { type: 'function', function: { name: 'get_weather' } });
});

test('convertAnthropicToOpenAI maps tool_use and tool_result turns', () => {
  const result = convertAnthropicToOpenAI({
    model: 'demo-model',
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Calling tool' },
          { type: 'tool_use', id: 'tool_1', name: 'lookup', input: { city: 'Paris' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: [{ type: 'text', text: 'Sunny' }] }],
      },
    ],
  });

  assert.deepEqual(result.messages[0], {
    role: 'assistant',
    content: 'Calling tool',
    tool_calls: [{
      id: 'tool_1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"city":"Paris"}' },
    }],
  });
  assert.deepEqual(result.messages[1], {
    role: 'tool',
    tool_call_id: 'tool_1',
    content: 'Sunny',
  });
});

test('convertAnthropicToOpenAI preserves base64 images with media_type', () => {
  const result = convertAnthropicToOpenAI({
    model: 'demo-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this image' },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'ZmFrZS1pbWFnZS1kYXRh',
          },
        },
      ],
    }],
  });

  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'Analyze this image' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,ZmFrZS1pbWFnZS1kYXRh' },
    },
  ]);
});

test('convertAnthropicToOpenAI preserves base64 images with mediaType', () => {
  const result = convertAnthropicToOpenAI({
    model: 'demo-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this image' },
        {
          type: 'image',
          source: {
            type: 'base64',
            mediaType: 'image/jpeg',
            data: 'ZmFrZS1qcGVn',
          },
        },
      ],
    }],
  });

  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'Analyze this image' },
    {
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,ZmFrZS1qcGVn' },
    },
  ]);
});

test('convertAnthropicToOpenAI preserves url images', () => {
  const result = convertAnthropicToOpenAI({
    model: 'demo-model',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Analyze this image' },
        {
          type: 'image',
          source: {
            type: 'url',
            url: 'https://example.test/image.png',
          },
        },
      ],
    }],
  });

  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'Analyze this image' },
    {
      type: 'image_url',
      image_url: { url: 'https://example.test/image.png' },
    },
  ]);
});

test('convertAnthropicToOpenAI preserves tool_result images', () => {
  const result = convertAnthropicToOpenAI({
    model: 'demo-model',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: [
          { type: 'text', text: 'Image loaded' },
          {
            type: 'image',
            source: {
              type: 'base64',
              mediaType: 'image/jpeg',
              data: 'ZmFrZS10b29sLWpwZWc=',
            },
          },
        ],
      }],
    }],
  });

  assert.deepEqual(result.messages[0], {
    role: 'tool',
    tool_call_id: 'tool_1',
    content: [
      { type: 'text', text: 'Image loaded' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,ZmFrZS10b29sLWpwZWc=' },
      },
    ],
  });
});

test('convertOpenAIResponse maps tool calls to Anthropic tool_use', () => {
  const result = convertOpenAIResponse({
    id: 'chatcmpl_1',
    model: 'demo-model',
    usage: { prompt_tokens: 12, completion_tokens: 8 },
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        content: 'Calling tool',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'lookup', arguments: '{"city":"Paris"}' },
        }],
      },
    }],
  });

  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content, [
    { type: 'text', text: 'Calling tool' },
    { type: 'tool_use', id: 'call_1', name: 'lookup', input: { city: 'Paris' } },
  ]);
});

test('convertOpenAIResponse ignores reasoning-only non-standard fields', () => {
  const result = convertOpenAIResponse({
    id: 'chatcmpl_reasoning',
    model: 'demo-model',
    choices: [{
      finish_reason: 'stop',
      message: { content: '', reasoning_content: 'internal reasoning' },
    }],
  });

  assert.deepEqual(result.content, []);
});

test('convertOpenAIResponse keeps visible content separate from reasoning', () => {
  const result = convertOpenAIResponse({
    id: 'chatcmpl_reasoning_content',
    model: 'demo-model',
    choices: [{
      finish_reason: 'stop',
      message: { content: '你好，我可以帮你写代码。', reasoning_content: 'internal reasoning' },
    }],
  });

  assert.deepEqual(result.content, [
    { type: 'text', text: '你好，我可以帮你写代码。' },
  ]);
});

test('convertOpenAISSEToAnthropicSSE emits text event sequence', async () => {
  const stream = createSSEStream([
    'data: {"id":"chatcmpl_1","model":"demo","choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"id":"chatcmpl_1","model":"demo","choices":[{"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]);

  const output = await readStreamText(convertOpenAISSEToAnthropicSSE(stream));
  const payloads = parseSSEPayloads(output);

  assert.match(output, /event: message_start/);
  assert.match(output, /event: content_block_delta/);
  assert.deepEqual(payloads.map(item => item.type), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  assert.equal(payloads[2].delta.text, 'Hello');
  assert.equal(payloads[4].delta.stop_reason, 'end_turn');
});

test('convertOpenAISSEToAnthropicSSE maps streaming tool calls', async () => {
  const stream = createSSEStream([
    'data: {"id":"chatcmpl_2","model":"demo","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup"}}]}}]}\n\n',
    'data: {"id":"chatcmpl_2","model":"demo","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}\n\n',
    'data: {"id":"chatcmpl_2","model":"demo","choices":[{"finish_reason":"tool_calls"}]}\n\n',
  ]);

  const output = await readStreamText(convertOpenAISSEToAnthropicSSE(stream));
  const payloads = parseSSEPayloads(output);
  const start = payloads.find(item => item.type === 'content_block_start');
  const delta = payloads.find(item => item.type === 'content_block_delta');
  const messageDelta = payloads.find(item => item.type === 'message_delta');

  assert.equal(start.content_block.type, 'tool_use');
  assert.equal(start.content_block.name, 'lookup');
  assert.equal(delta.delta.type, 'input_json_delta');
  assert.equal(delta.delta.partial_json, '{"city":"Paris"}');
  assert.equal(messageDelta.delta.stop_reason, 'tool_use');
});

test('convertOpenAISSEToAnthropicSSE ignores reasoning and keeps visible content streaming', async () => {
  const stream = createSSEStream([
    'data: {"id":"chatcmpl_reasoning_content","model":"demo","choices":[{"delta":{"content":"我可以帮你"}}]}\n\n',
    'data: {"id":"chatcmpl_reasoning_content","model":"demo","choices":[{"delta":{"reasoning_content":"internal reasoning"}}]}\n\n',
    'data: {"id":"chatcmpl_reasoning_content","model":"demo","choices":[{"delta":{"content":"写代码。"}}]}\n\n',
    'data: {"id":"chatcmpl_reasoning_content","model":"demo","choices":[{"finish_reason":"stop"}]}\n\n',
  ]);

  const output = await readStreamText(convertOpenAISSEToAnthropicSSE(stream));
  const payloads = parseSSEPayloads(output);
  const starts = payloads.filter(item => item.type === 'content_block_start');
  const deltas = payloads.filter(item => item.type === 'content_block_delta');

  assert.deepEqual(starts.map(item => item.content_block.type), ['text']);
  assert.deepEqual(deltas.map(item => item.delta.text), ['我可以帮你', '写代码。']);
  assert.equal(deltas.some(item => item.delta.text?.includes('internal reasoning')), false);
});

test('createAnthropicSSEPingEvent emits Anthropic ping payload', () => {
  const text = new TextDecoder().decode(createAnthropicSSEPingEvent());
  assert.equal(text, 'event: ping\ndata: {"type":"ping"}\n\n');
});
