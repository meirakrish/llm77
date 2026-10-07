import { UnrecoverableError } from 'bullmq';
import { ChatResponse, GenerateResponse } from 'ollama';
import { z } from 'zod';
import { config } from '../config';
import { inlineDocuments } from '../chat';
import { ollama } from '../ollama-client';
import { AnalysisResponseSchema } from '../schema';
import { ChatMessage, Provider, Usage } from './types';

// JSON Schema handed to Ollama so the grammar layer enforces the exact response structure
const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(AnalysisResponseSchema);
// Far more than the schema's limits allow; a backstop so a runaway generation can't occupy the GPU indefinitely
const ANALYSIS_MAX_TOKENS = 1024;

// Ollama's usual context window. Prompts that don't fit are cut, so a long attached document would lose its start.
const DEFAULT_CONTEXT_TOKENS = 4096;
// Room left for the answer
const ANSWER_TOKENS = 1024;

// A context window big enough for the prompt (estimated at 3 characters per token), or undefined for Ollama's default
export function contextFor(messages: ChatMessage[]): number | undefined {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  const needed = Math.ceil(chars / 3) + ANSWER_TOKENS;
  if (needed <= DEFAULT_CONTEXT_TOKENS) return undefined;
  return Math.min(Math.ceil(needed / 1024) * 1024, Math.max(config.maxContextTokens, DEFAULT_CONTEXT_TOKENS));
}

// Extract token usage and throughput statistics from an Ollama response
function usageOf(response: GenerateResponse | ChatResponse): Usage {
  const completionTokens = response.eval_count || 0;
  // eval_duration is in nanoseconds
  const generationDurationSec = (response.eval_duration || 1) / 1_000_000_000;
  return {
    promptTokens: response.prompt_eval_count || 0,
    completionTokens,
    tokensPerSecond: parseFloat((completionTokens / generationDurationSec).toFixed(2))
  };
}

export const ollamaProvider: Provider = {
  async streamText(model, messages, onToken, signal) {
    const prompt = messages.map(inlineDocuments);
    const numCtx = contextFor(prompt);
    // The chat endpoint applies the model's own conversation template to the turns
    const parts = await ollama.chat({
      model,
      messages: prompt.map(({ role, content, images }) => ({ role, content, ...(images ? { images } : {}) })),
      stream: true,
      ...(numCtx ? { options: { num_ctx: numCtx } } : {})
    });
    signal?.addEventListener('abort', () => parts.abort(), { once: true });

    let text = '';
    let finalPart: ChatResponse | undefined;
    for await (const part of parts) {
      const token = part.message.content;
      text += token;
      if (token) await onToken(token);
      if (part.done) finalPart = part;
    }

    // The final chunk carries Ollama's token and timing statistics
    return { text, model, usage: usageOf(finalPart!) };
  },

  async analyze(model, text, signal) {
    const prompt = `You are an AI data extraction engine. Analyze the log message below and return a JSON object that strictly adheres to this structure.
CRITICAL: You must output ONLY valid JSON. Do not include markdown wraps like \`\`\`json. Do not alter the key names.

Expected JSON Structure:
{
  "summary": "1-sentence summary string",
  "category": "Support" | "Billing" | "Feature Request" | "Spam",
  "urgency": "Low" | "Medium" | "High",
  "actionItems": ["action item 1", "action item 2"]
}

Log Message:
"${text}"`;
    const numCtx = contextFor([{ role: 'user', content: prompt }]);
    // Streamed so the request can be aborted when the job is cancelled
    const parts = await ollama.generate({
      model,
      prompt,
      format: ANALYSIS_JSON_SCHEMA,
      stream: true,
      options: { temperature: 0.0, num_predict: ANALYSIS_MAX_TOKENS, ...(numCtx ? { num_ctx: numCtx } : {}) }
    });
    // Also covers a cancel that arrived while the request was starting
    if (signal?.aborted) parts.abort();
    else signal?.addEventListener('abort', () => parts.abort(), { once: true });

    let output = '';
    let finalPart: GenerateResponse | undefined;
    for await (const part of parts) {
      output += part.response;
      if (part.done) finalPart = part;
    }
    if (finalPart?.done_reason === 'length') {
      throw new UnrecoverableError(`Data extraction layout violation: the model produced ${ANALYSIS_MAX_TOKENS} tokens without finishing.`);
    }

    // Parse and validate the output payload; only these failures are schema violations
    try {
      return { data: AnalysisResponseSchema.parse(JSON.parse(output)), model, usage: usageOf(finalPart!) };
    } catch (error: any) {
      // Generation runs at temperature 0, so a retry would produce the same invalid output
      throw new UnrecoverableError(`Data extraction layout violation: ${error.message}`);
    }
  }
};
