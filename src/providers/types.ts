import { AnalysisResponse } from '../schema';

// One turn of a conversation; the last message is the user's newest question
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number;
  costUsd?: number;
}

export interface TextResult {
  text: string;
  // The model that actually produced the output (a Claude fallback can differ from the one requested)
  model: string;
  usage: Usage;
}

export interface AnalysisResult {
  data: AnalysisResponse;
  model: string;
  usage: Usage;
}

export interface Provider {
  // signal stops generation early, e.g. when the worker that asked for it disconnects
  streamText(
    model: string,
    messages: ChatMessage[],
    onToken: (token: string) => Promise<void>,
    signal?: AbortSignal
  ): Promise<TextResult>;
  analyze(model: string, text: string, signal?: AbortSignal): Promise<AnalysisResult>;
}
