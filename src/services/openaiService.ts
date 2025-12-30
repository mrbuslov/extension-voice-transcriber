import { StorageService } from './storageService';

export class OpenAIService {
  private readonly baseUrl = 'https://api.openai.com/v1';

  constructor(private readonly storage: StorageService) {}

  async cleanupText(rawText: string, model: string = 'gpt-4o-mini'): Promise<string> {
    const apiKey = await this.storage.getApiKey();

    if (!apiKey) {
      throw new Error('OpenAI API key required for text cleanup');
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
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
            content: `You are a text cleanup assistant. Clean up the following transcribed speech:

1. Remove filler words and verbal tics (um, uh, like, you know, I mean, so, basically, etc.)
2. Remove repeated words and stutters
3. Fix punctuation and capitalization
4. Split into logical paragraphs
5. Keep the original meaning and tone intact
6. Output ONLY plain text - no markdown, no headers, no bullet points

Return only the cleaned text, nothing else.`,
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
