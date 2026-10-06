import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { UnrecoverableError } from 'bullmq';
import { ClaudeInfo } from '../events';
import { AnalysisResponseSchema } from '../schema';
import { Provider, Usage } from './types';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Opus 5.5 always thinks, at an adjustable effort (default medium); low is plenty for short Q&A and
// classification, and faster and cheaper. Haiku 4.5 rejects the effort parameter.
// Fallbacks re-run a request on another model server-side if Opus's safety classifiers decline it.
const MODEL_SETTINGS: Record<string, { effort?: Effort; fallbacks?: boolean }> = {
  'claude-opus-5-5': { effort: 'low', fallbacks: true },
  'claude-haiku-4-5': {}
};

// USD per million tokens [input, output], including models a fallback may hand the request to
const PRICING: Record<string, [number, number]> = {
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-haiku-4-5': [1, 5]
};

const MAX_TOKENS = 16000;

// Created on first use; credentials come from ANTHROPIC_API_KEY (or an `ant auth login` profile)
let client: Anthropic | undefined;
const getClient = () => (client ??= new Anthropic());

function requestOptions(model: string) {
  const settings = MODEL_SETTINGS[model] ?? {};
  return {
    ...(settings.fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    ...(settings.effort ? { output_config: { effort: settings.effort } } : {})
  };
}

function usageOf(message: Anthropic.Beta.BetaMessage, durationMs: number): Usage {
  const { input_tokens, output_tokens } = message.usage;
  // Priced by the model that served the request; approximate if a fallback ran partway through
  const price = PRICING[message.model];
  return {
    promptTokens: input_tokens,
    completionTokens: output_tokens,
    // Claude doesn't report generation time, so this is measured over the whole request
    tokensPerSecond: parseFloat((output_tokens / Math.max(durationMs / 1000, 0.001)).toFixed(2)),
    ...(price ? { costUsd: (input_tokens * price[0] + output_tokens * price[1]) / 1_000_000 } : {})
  };
}

function checkStopReason(message: Anthropic.Beta.BetaMessage) {
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category;
    throw new UnrecoverableError(`Claude declined this request${category ? ` (${category})` : ''}.`);
  }
}

// Turn configuration and request errors into permanent failures; leave transient ones retryable
function describeError(error: unknown): Error {
  if (error instanceof Anthropic.AuthenticationError) {
    return new UnrecoverableError('Claude authentication failed. Check ANTHROPIC_API_KEY on the worker.');
  }
  if (
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.NotFoundError
  ) {
    return new UnrecoverableError(`Claude API error ${error.status}: ${error.message}`);
  }
  // Rate limits, server errors and connection problems (already retried by the SDK) stay retryable
  if (error instanceof Anthropic.APIError) return error;
  // Anything else from the SDK is a setup problem
  if (error instanceof Anthropic.AnthropicError) return new UnrecoverableError(`Claude is not configured: ${error.message}`);
  // With no credentials at all the SDK throws a plain Error (no typed class), so its message is all there is to match
  if (error instanceof Error && error.message.startsWith('Could not resolve authentication method')) {
    return new UnrecoverableError('No Claude credentials on the worker. Set ANTHROPIC_API_KEY (or run `ant auth login`).');
  }
  return error as Error;
}

async function withErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw describeError(error);
  }
}

export const claudeProvider: Provider = {
  streamText(model, messages, onToken, signal) {
    return withErrors(async () => {
      const started = Date.now();
      const stream = getClient().beta.messages.stream(
        {
          model,
          max_tokens: MAX_TOKENS,
          messages,
          ...requestOptions(model)
        },
        { signal }
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') await onToken(event.delta.text);
      }

      const message = await stream.finalMessage();
      checkStopReason(message);
      const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      return { text, model: message.model, usage: usageOf(message, Date.now() - started) };
    });
  },

  analyze(model, text, signal) {
    return withErrors(async () => {
      const started = Date.now();
      const options = requestOptions(model);
      const message = await getClient().beta.messages.parse(
        {
          model,
          max_tokens: MAX_TOKENS,
          messages: [
            {
              role: 'user',
              content: `Analyze the customer message or log entry below for an internal support team. Summarize it in one sentence, pick the best category and urgency, and list concrete action items for the team (an empty list if none are needed).

<message>
${text}
</message>`
            }
          ],
          ...options,
          output_config: { ...('output_config' in options ? options.output_config : {}), format: betaZodOutputFormat(AnalysisResponseSchema) }
        },
        { signal }
      );

      checkStopReason(message);
      if (!message.parsed_output) {
        throw new UnrecoverableError(`Data extraction layout violation: Claude returned no parseable output (stop reason: ${message.stop_reason}).`);
      }
      return { data: message.parsed_output, model: message.model, usage: usageOf(message, Date.now() - started) };
    });
  }
};

// Which of the requested Claude models the configured credentials can use
export async function checkClaudeModels(models: string[]): Promise<ClaudeInfo> {
  const results = await Promise.allSettled(models.map((id) => getClient().models.retrieve(id)));
  const available = results.flatMap((result, i) => {
    if (result.status !== 'fulfilled') return [];
    const price = PRICING[models[i]];
    return [{ id: models[i], name: result.value.display_name, ...(price ? { inputPrice: price[0], outputPrice: price[1] } : {}) }];
  });
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  return {
    available: available.length > 0,
    models: available,
    ...(failure ? { error: describeError(failure.reason).message } : {})
  };
}
