import { UnrecoverableError } from 'bullmq';
import { ChatResponse, GenerateResponse } from 'ollama';
import { z } from 'zod';
import { ollama } from '../ollama-client';
import { AnalysisResponseSchema } from '../schema';
import { Provider, Usage } from './types';

// JSON Schema handed to Ollama so the grammar layer enforces the exact response structure
const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(AnalysisResponseSchema);

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
    // The chat endpoint applies the model's own conversation template to the turns
    const parts = await ollama.chat({ model, messages, stream: true });
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

  async analyze(model, text) {
    const response = await ollama.generate({
      model,
      prompt: `You are an AI data extraction engine. Analyze the log message below and return a JSON object that strictly adheres to this structure.
CRITICAL: You must output ONLY valid JSON. Do not include markdown wraps like \`\`\`json. Do not alter the key names.

Expected JSON Structure:
{
  "summary": "1-sentence summary string",
  "category": "Support" | "Billing" | "Feature Request" | "Spam",
  "urgency": "Low" | "Medium" | "High",
  "actionItems": ["action item 1", "action item 2"]
}

Log Message:
"${text}"`,
      format: ANALYSIS_JSON_SCHEMA,
      stream: false,
      options: { temperature: 0.0 }
    });

    // Parse and validate the output payload; only these failures are schema violations
    try {
      return { data: AnalysisResponseSchema.parse(JSON.parse(response.response)), model, usage: usageOf(response) };
    } catch (error: any) {
      // Generation runs at temperature 0, so a retry would produce the same invalid output
      throw new UnrecoverableError(`Data extraction layout violation: ${error.message}`);
    }
  }
};
