/**
 * OpenProxy - 协议转换
 * 
 * Anthropic ↔ OpenAI 格式互转
 */

function joinTextBlocks(content) {
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function normalizeAnthropicTextContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return joinTextBlocks(content);
  }

  return '';
}

function convertAnthropicImageBlockToOpenAIContentPart(block) {
  const source = block?.source;
  if (!source || typeof source !== 'object') {
    return null;
  }

  if (source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
    const mediaType = source.media_type || source.mediaType || 'image/png';
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${source.data}`,
      },
    };
  }

  if (source.type === 'url' && typeof source.url === 'string' && source.url.length > 0) {
    return {
      type: 'image_url',
      image_url: {
        url: source.url,
      },
    };
  }

  return null;
}

function convertAnthropicContentBlocksToOpenAIContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : '';
  }

  const parts = [];

  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({
        type: 'text',
        text: block.text,
      });
      continue;
    }

    if (block.type === 'image') {
      const imagePart = convertAnthropicImageBlockToOpenAIContentPart(block);
      if (imagePart) {
        parts.push(imagePart);
      }
    }
  }

  if (parts.length === 0) {
    return '';
  }

  const hasNonTextPart = parts.some((part) => part.type !== 'text');
  if (!hasNonTextPart) {
    return parts.map((part) => part.text).join('\n');
  }

  return parts;
}

function convertAnthropicToolResultContentToOpenAIContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const structured = convertAnthropicContentBlocksToOpenAIContent(content);
    if (Array.isArray(structured)) {
      return structured;
    }

    if (typeof structured === 'string' && structured.length > 0) {
      return structured;
    }

    return JSON.stringify(content);
  }

  return JSON.stringify(content ?? {});
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      type: 'object',
      properties: {},
      additionalProperties: false,
    };
  }

  return {
    additionalProperties: false,
    ...schema,
    type: schema.type || 'object',
    properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
  };
}

const TOOL_ARGUMENT_GUIDANCE = [
  'Tool call compatibility note:',
  'When you call a tool, you must provide valid JSON arguments that satisfy the tool schema.',
  'Do not emit empty objects for tools with required fields.',
  'For example, Bash requires {"command":"..."}.',
].join('\n');

function convertAnthropicToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) {
    return undefined;
  }

  const converted = tools
    .filter(tool => tool && typeof tool === 'object')
    .map((tool) => {
      const parameters = normalizeJsonSchema(tool.input_schema || tool.inputSchema);
      const requiredFields = Array.isArray(parameters.required) ? parameters.required : [];
      const requiredHint = requiredFields.length > 0
        ? ` Required fields: ${requiredFields.join(', ')}.`
        : '';

      return {
        type: 'function',
        function: {
          name: tool.name || '',
          description: `${tool.description || ''}${requiredHint}`.trim(),
          parameters,
        },
      };
    });

  return converted.length > 0 ? converted : undefined;
}

function convertAnthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return undefined;
  }

  if (toolChoice.type === 'auto') {
    return 'auto';
  }

  if (toolChoice.type === 'any') {
    return 'required';
  }

  if (toolChoice.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    };
  }

  return undefined;
}

/**
 * 将 Anthropic 请求转换为 OpenAI 格式
 */
export function convertAnthropicToOpenAI(anthropicRequest, config) {
  const messages = [];
  const systemSegments = [];
  
  if (anthropicRequest.system) {
    const normalizedSystem = normalizeAnthropicTextContent(anthropicRequest.system);
    if (normalizedSystem) {
      systemSegments.push(normalizedSystem);
    }
  }
  
  for (const msg of anthropicRequest.messages || []) {
    if (msg?.role === 'system') {
      const normalizedSystem = normalizeAnthropicTextContent(msg.content);
      if (normalizedSystem) {
        systemSegments.push(normalizedSystem);
      }
      continue;
    }

    if (Array.isArray(msg.content)) {
      const textContent = joinTextBlocks(msg.content);
      const openAIContent = convertAnthropicContentBlocksToOpenAIContent(msg.content);
      const toolUses = msg.content.filter(block => block?.type === 'tool_use');
      const toolResults = msg.content.filter(block => block?.type === 'tool_result');

      if (msg.role === 'assistant' && toolUses.length > 0) {
        messages.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolUses.map((block, index) => ({
            id: block.id || `toolu_${index}`,
            type: 'function',
            function: {
              name: block.name || '',
              arguments: JSON.stringify(block.input || {})
            }
          }))
        });
        continue;
      }

      if (msg.role === 'user' && toolResults.length > 0) {
        if (textContent) {
          messages.push({
            role: 'user',
            content: textContent
          });
        }

        for (const block of toolResults) {
          messages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id || '',
            content: convertAnthropicToolResultContentToOpenAIContent(block.content)
          });
        }
        continue;
      }

      messages.push({
        role: msg.role,
        content: openAIContent
      });
    } else {
      messages.push({
        role: msg.role,
        content: msg.content
      });
    }
  }

  if (systemSegments.length > 0) {
    messages.unshift({
      role: 'system',
      content: systemSegments.join('\n\n'),
    });
  }
  
  const openaiRequest = {
    model: anthropicRequest.model,
    messages: messages,
    max_tokens: anthropicRequest.max_tokens,
    stream: anthropicRequest.stream || false
  };

  const tools = convertAnthropicToolsToOpenAI(anthropicRequest.tools);
  if (tools) {
    openaiRequest.tools = tools;
  };

  const toolChoice = convertAnthropicToolChoiceToOpenAI(anthropicRequest.tool_choice);
  if (toolChoice) {
    openaiRequest.tool_choice = toolChoice;
  }

  return openaiRequest;
}

/**
 * 将 OpenAI 响应转换为 Anthropic 格式
 */
export function convertOpenAIResponse(openaiResponse, isStream) {
  if (isStream) {
    throw new Error('Streaming responses must be handled via SSE conversion');
  }

  const message = openaiResponse.choices[0]?.message || {};
  const content = [];

  if (typeof message.content === 'string' && message.content.length > 0) {
    content.push({
      type: 'text',
      text: message.content
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      content.push({
        type: 'tool_use',
        id: toolCall.id || '',
        name: toolCall.function?.name || '',
        input: safeParseJson(toolCall.function?.arguments)
      });
    }
  }

  const finishReason = openaiResponse.choices[0]?.finish_reason;
  
  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    content,
    model: openaiResponse.model,
    stop_reason: finishReason === 'tool_calls' ? 'tool_use' : finishReason === 'stop' ? 'end_turn' : 'max_tokens',
    stop_sequence: null,
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0
    }
  };
}

/**
 * 转换 OpenAI SSE 流为 Anthropic SSE 流
 *
 * OpenAI:  data: {"id":"...","choices":[{"delta":{"content":"..."}}]}
 * Anthropic: data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"..."}}
 *
 * Anthropic 事件序:
 *   message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
 */
export function convertOpenAISSEToAnthropicSSE(openaiStream, options = {}) {
  const reader = openaiStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let started = false;
  let activeBlockType = null;
  let activeBlockIndex = null;
  let finished = false;
  let hasTextBlock = false;
  const sseLogger = options.sseLogger || null;

  function emit(controller, data) {
    sseLogger?.onEvent(data);
    controller.enqueue(new TextEncoder().encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`));
  }

  function ensureMessageStart(controller, openaiEvent = {}) {
    if (started) {
      return;
    }

    emit(controller, {
      type: 'message_start',
      message: {
        id: openaiEvent.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        content: [],
        model: openaiEvent.model || '',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    });
    started = true;
  }

  function ensureTextBlock(controller) {
    if (activeBlockType === 'text') {
      return;
    }

    closeActiveBlock(controller);
    emit(controller, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    });
    activeBlockType = 'text';
    activeBlockIndex = 0;
    hasTextBlock = true;
  }

  function ensureToolBlock(controller, toolCall = {}) {
    const toolBlockIndex = hasTextBlock ? (Number.isInteger(toolCall?.index) ? toolCall.index + 1 : 1) : (Number.isInteger(toolCall?.index) ? toolCall.index : 0);

    if (activeBlockType === 'tool_use' && activeBlockIndex === toolBlockIndex) {
      return;
    }

    closeActiveBlock(controller);
    emit(controller, {
      type: 'content_block_start',
      index: toolBlockIndex,
      content_block: {
        type: 'tool_use',
        id: toolCall.id || '',
        name: toolCall.function?.name || '',
        input: {}
      }
    });
    activeBlockType = 'tool_use';
    activeBlockIndex = toolBlockIndex;
  }

  function closeActiveBlock(controller) {
    if (!activeBlockType) {
      return;
    }

    emit(controller, { type: 'content_block_stop', index: activeBlockIndex ?? 0 });
    activeBlockType = null;
    activeBlockIndex = null;
  }

  function emitEndSequence(controller, stopReason) {
    if (finished) {
      return;
    }

    finished = true;
    closeActiveBlock(controller);
    emit(controller, {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 }
    });
    emit(controller, { type: 'message_stop' });
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        ensureMessageStart(controller);

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            emitEndSequence(controller, 'end_turn');
            sseLogger?.onComplete();
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            const jsonStr = line.slice(6).trim();
            sseLogger?.onUpstreamEvent(jsonStr);
            if (jsonStr === '[DONE]') {
              emitEndSequence(controller, 'end_turn');
              sseLogger?.onComplete();
              controller.close();
              return;
            }

            try {
              const openaiEvent = JSON.parse(jsonStr);

              ensureMessageStart(controller, openaiEvent);

              const choice = openaiEvent.choices?.[0];

              // finish_reason → content_block_stop + message_delta + message_stop
              if (choice?.finish_reason) {
                emitEndSequence(controller, choice.finish_reason === 'stop' ? 'end_turn' : 'tool_use');
                sseLogger?.onComplete();
                controller.close();
                return;
              }

              const delta = choice?.delta;
              if (!delta) continue;

              if (typeof delta.content === 'string' && delta.content.length > 0) {
                ensureTextBlock(controller);
                emit(controller, {
                  type: 'content_block_delta',
                  index: activeBlockIndex ?? 0,
                  delta: { type: 'text_delta', text: delta.content }
                });
              }

              if (Array.isArray(delta.tool_calls)) {
                for (const toolCall of delta.tool_calls) {
                  if (!toolCall) continue;

                  if (toolCall.id || toolCall.function?.name) {
                    ensureToolBlock(controller, toolCall);
                  }

                  if (toolCall.function?.arguments) {
                    ensureToolBlock(controller, toolCall);
                    emit(controller, {
                      type: 'content_block_delta',
                      index: activeBlockIndex ?? 0,
                      delta: {
                        type: 'input_json_delta',
                        partial_json: toolCall.function.arguments
                      }
                    });
                  }
                }
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return stream;
}

export function createAnthropicSSEPingEvent() {
  return new TextEncoder().encode('event: ping\ndata: {"type":"ping"}\n\n');
}

function safeParseJson(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return {};
  }

  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
