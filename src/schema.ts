import { z } from 'zod';

// Define a strict schema for your backend logic. The length limits also bound generation: Ollama's grammar
// enforces them, so a model stuck repeating itself still has to close the JSON.
export const AnalysisResponseSchema = z.object({
  summary: z.string().max(300).describe('A concise 1-sentence summary of the input text.'),
  category: z.enum(['Support', 'Billing', 'Feature Request', 'Spam']),
  urgency: z.enum(['Low', 'Medium', 'High']),
  actionItems: z.array(z.string().max(200)).max(5).describe('List of clear concrete tasks required by the internal team.'),
});

// Create a TypeScript type inferred directly from the Zod Schema
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;

