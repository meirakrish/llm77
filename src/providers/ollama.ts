import { UnrecoverableError } from 'bullmq';
import { GenerateResponse } from 'ollama';
import { z } from 'zod';
import { ollama } from '../config';
import { AnalysisResponseSchema } from '../schema';
import { Provider, Usage } from './types';

// JSON Schema handed to Ollama so the grammar layer enforces the exact response structure
const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(AnalysisResponseSchema);

// Extract token usage and throughput statistics from an Ollama response
function usageOf(response: GenerateResponse): Usage {
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
  async streamText(model, prompt, onToken) {
    const parts = await ollama.generate({ model, prompt, stream: true });

    let text = '';
    let finalPart: GenerateResponse | undefined;
    for await (const part of parts) {
      text += part.response;
      if (part.response) await onToken(part.response);
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
