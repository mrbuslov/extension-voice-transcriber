import { StorageService } from './storageService';

export class OpenAIService {
  constructor(private readonly storage: StorageService) {}

  async cleanupText(rawText: string, model: string, provider: 'openai' | 'openrouter' | 'local'): Promise<string> {
    const apiKey = await this.storage.getApiKey();

    if (!apiKey) {
      throw new Error(`${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} API key required for text cleanup`);
    }

    const baseUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1';

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You are a speech-to-text post-processor. Your ONLY task is to clean up transcribed speech and output the result.

Rules:
1. Remove filler words (um, uh, like, you know, I mean, so, basically, etc.)
2. Remove repeated words and stutters
3. Fix punctuation and capitalization
4. Split into logical paragraphs if needed
5. Preserve the original meaning and tone exactly
6. Output ONLY plain text - no markdown, no headers, no bullet points

CRITICAL: Output ONLY the cleaned transcription. Do NOT add any greetings, confirmations, explanations, or meta-commentary. Do NOT say "Here is..." or "I've cleaned..." - just output the text directly.`,
          },
          {
            role: 'user',
            content: rawText,
          },
        ],
        temperature: 0.3,
        max_tokens: Math.ceil(rawText.length * 1.5) + 500,
      }),
    });

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
      const errorMessage =
        errorData.error?.message || `Cleanup failed with status ${response.status}`;
      throw new Error(errorMessage);
    }

    const result = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return result.choices[0].message.content;
  }
}
