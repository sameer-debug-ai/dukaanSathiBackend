import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../config/env';
import { ParsedBatchSchema } from './intentSchema';
import { buildUserMessage, SYSTEM_PROMPT } from './prompt';
import { AiProviderError, type AiProvider, type ParseRequest } from './provider';

/** Claude via the official SDK, using structured outputs so the reply is schema-shaped JSON. */
export class ClaudeProvider implements AiProvider {
  readonly name = 'claude';
  private client: Anthropic | null = null;

  isAvailable(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  private getClient(): Anthropic {
    // Voice confirmations are interactive, so fail fast rather than wait minutes.
    this.client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
    return this.client;
  }

  async parseCommand(req: ParseRequest): Promise<unknown> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: buildUserMessage(req.text, req.context, req.todayIst, req.history) },
    ];
    if (req.previousError) {
      messages.push({
        role: 'user',
        content: `Your previous output was invalid (${req.previousError}). Return one JSON object that matches the schema exactly.`,
      });
    }

    try {
      const response = await this.getClient().messages.parse({
        model: env.AI_MODEL,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages,
        output_config: { format: zodOutputFormat(ParsedBatchSchema), effort: 'low' },
      });

      if (response.stop_reason === 'refusal') throw new AiProviderError('The AI declined this command', false);
      if (response.stop_reason === 'max_tokens') throw new AiProviderError('AI response was cut off', true);
      if (response.parsed_output) return response.parsed_output;

      // Fall back to raw text so the caller's validation can report what went wrong.
      const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '';
      try {
        return JSON.parse(text);
      } catch {
        throw new AiProviderError('AI did not return valid JSON', true);
      }
    } catch (err) {
      if (err instanceof AiProviderError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new AiProviderError('Invalid ANTHROPIC_API_KEY', false);
      if (err instanceof Anthropic.RateLimitError) throw new AiProviderError('AI rate limit reached', false);
      if (err instanceof Anthropic.BadRequestError) throw new AiProviderError(`AI request rejected: ${err.message}`, false);
      if (err instanceof Anthropic.APIError) throw new AiProviderError(`AI service error ${err.status ?? ''}`.trim(), false);
      throw new AiProviderError(err instanceof Error ? err.message : 'AI request failed', false);
    }
  }
}
