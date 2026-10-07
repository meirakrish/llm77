import { AnalysisResponse } from '../schema';

// A file attached to a question, as the text extracted from it
export interface AttachedDocument {
  name: string;
  text: string;
}

// One turn of a conversation; the last message is the user's newest question
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  // Only on user turns: base64-encoded images for vision models, and documents whose text goes into the prompt
  images?: string[];
  documents?: AttachedDocument[];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  tokensPerSecond: number;
}

export interface TextResult {
  text: string;
  // The model that produced the output
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
