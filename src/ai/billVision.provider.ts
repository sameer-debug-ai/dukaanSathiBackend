import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../config/env';
import { BILL_SCAN_PROMPT, BillScanOutputSchema } from './billScan';
import { AiProviderError } from './provider';

export type BillImageType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface BillScanRequest {
  image: Buffer;
  contentType: BillImageType;
  todayIst: string;
  /** Set on the retry after invalid output. */
  previousError?: string;
}

/** Reads a bill photo into BillScanOutputSchema-shaped JSON (validated by the caller). */
export interface BillVisionProvider {
  readonly name: string;
  isAvailable(): boolean;
  scan(req: BillScanRequest): Promise<unknown>;
}

/** Claude vision via the official SDK, with structured output. Model: AI_VISION_MODEL, else AI_MODEL. */
export class ClaudeBillVision implements BillVisionProvider {
  readonly name = 'claude';
  private client: Anthropic | null = null;

  isAvailable(): boolean {
    return Boolean(env.ANTHROPIC_API_KEY);
  }

  private getClient(): Anthropic {
    // A photo takes longer than a voice command; still bounded so the screen never hangs.
    this.client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
    return this.client;
  }

  async scan(req: BillScanRequest): Promise<unknown> {
    const content: Anthropic.ContentBlockParam[] = [
      { type: 'image', source: { type: 'base64', media_type: req.contentType, data: req.image.toString('base64') } },
      { type: 'text', text: `Today (Asia/Kolkata): ${req.todayIst}. Read this purchase bill.` },
    ];
    if (req.previousError) {
      content.push({ type: 'text', text: `Your previous output was invalid (${req.previousError}). Return one JSON object that matches the schema exactly.` });
    }
    try {
      const response = await this.getClient().messages.parse({
        model: env.AI_VISION_MODEL || env.AI_MODEL,
        max_tokens: 8000,
        system: BILL_SCAN_PROMPT,
        messages: [{ role: 'user', content }],
        output_config: { format: zodOutputFormat(BillScanOutputSchema) },
      });
      if (response.stop_reason === 'refusal') throw new AiProviderError('The AI declined to read this photo', false);
      if (response.stop_reason === 'max_tokens') throw new AiProviderError('Bill was too long to read in one go', true);
      if (response.parsed_output) return response.parsed_output;
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
