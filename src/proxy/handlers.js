import crypto from 'node:crypto';
import { writeProxyError } from './errors.js';
import {
  logAnthropicRequestDiagnostics,
  logRequestSummary,
  logStreamingDecision,
  logUpstreamRequestShape,
} from './logging.js';
import { MODEL_SOURCE_CUSTOM, parseGatewayModelId } from './backend.js';
import { fetchModelsResponse } from './models-service.js';
import { redactOpenAIChatRequest } from './privacy-filter.js';
import {
  forwardAnthropicNative,
  forwardAnthropicNativeStream,
  forwardAnthropicViaOpenAI,
  forwardAnthropicViaOpenAIStream,
  forwardOpenAIStreamToUpstream,
  forwardToUpstream,
} from './upstream.js';
export function shouldUseStreamingResponse(body, acceptHeader) {
  if (body?.stream === true) {
    return true;
  }

  return typeof acceptHeader === 'string' && acceptHeader.includes('text/event-stream');
}

function logPrivacyResult(label, result, config) {
  if (!config?.privacy?.logHits || !result?.hit) {
    return;
  }

  const summary = Object.entries(result.summary || {})
    .map(([type, count]) => `${type}=${count}`)
    .join(' ');
  console.log(`[Privacy] ${label} redacted ${result.count} entities${summary ? `: ${summary}` : ''}`);
}

export function createAnthropicMessagesHandler(config) {
  return async (req, res) => {
    try {
      const body = req.body;
      const parsedModel = parseGatewayModelId(body?.model)
      const forceDiagnostics = typeof req.headers['x-claude-code-session-id'] === 'string';
      const requestId = crypto.randomUUID();
      const sessionId = typeof req.headers['x-claude-code-session-id'] === 'string'
        ? req.headers['x-claude-code-session-id']
        : null;
      logRequestSummary('Anthropic', req);
      logAnthropicRequestDiagnostics(body, forceDiagnostics);
      logUpstreamRequestShape('Anthropic', body, forceDiagnostics);

      const shouldStream = shouldUseStreamingResponse(body, req.headers.accept);
      logStreamingDecision('Anthropic', {
        bodyStream: body?.stream,
        acceptHeader: req.headers.accept,
        shouldStream,
      });

      const useNative = parsedModel.source === MODEL_SOURCE_CUSTOM;
      console.log(`[Anthropic] routing=${useNative ? 'native' : 'bridge'} source=${parsedModel.source}`);

      if (shouldStream) {
        const streamForwarder = useNative ? forwardAnthropicNativeStream : forwardAnthropicViaOpenAIStream;
        return await streamForwarder(body, config, res, {
          forceDiagnostics,
          requestId,
          sessionId,
          parsedModel,
        });
      }

      const forwarder = useNative ? forwardAnthropicNative : forwardAnthropicViaOpenAI;
      const response = await forwarder(body, config, {
        forceDiagnostics,
        requestId,
        sessionId,
        parsedModel,
      });
      res.json(response);
    } catch (error) {
      console.error('[Anthropic Handler] request failed:', error)
      writeProxyError(res, error);
    }
  };
}

export function createOpenAIChatHandler(config) {
  return async (req, res) => {
    try {
      parseGatewayModelId(req.body?.model)
      const privacy = redactOpenAIChatRequest(req.body, config);
      const body = privacy.body;
      logPrivacyResult('OpenAI', privacy, config);
      const requestId = crypto.randomUUID();
      logRequestSummary('OpenAI', req);
      const shouldStream = shouldUseStreamingResponse(body, req.headers.accept);
      logStreamingDecision('OpenAI', {
        bodyStream: body?.stream,
        acceptHeader: req.headers.accept,
        shouldStream,
      });
      const nextBody = shouldStream ? { ...body, stream: true } : body;

      if (shouldStream) {
        return await forwardOpenAIStreamToUpstream(nextBody, config, res, {
          routeType: 'openai',
          requestId,
          sessionId: null,
        });
      }

      const response = await forwardToUpstream(nextBody, config, {
        routeType: 'openai',
        requestId,
        sessionId: null,
      });
      res.json(response);
    } catch (error) {
      console.error('[OpenAI Handler] request failed:', error)
      writeProxyError(res, error);
    }
  };
}

export function createModelsHandler(config) {
  return async (req, res) => {
    try {
      const models = await fetchModelsResponse(config);
      res.json(models);
    } catch (error) {
      console.error('[Models Handler] request failed:', error)
      writeProxyError(res, error);
    }
  };
}
