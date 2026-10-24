/**
 * AI provider abstraction: the rest of the app only depends on this interface,
 * so Claude can be swapped for another model or a local parser.
 */
export interface ShopContext {
  /** "Name (alias1, alias2)" strings. */
  customers: string[];
  suppliers: string[];
  /** "Name [unit] (aliases)" strings. */
  products: string[];
}

export interface ParseRequest {
  text: string;
  context: ShopContext;
  todayIst: string;
  /** Set on the retry after invalid output, describing what was wrong. */
  previousError?: string;
}

export interface AiProvider {
  readonly name: string;
  /** True when the provider is configured (e.g. API key present). */
  isAvailable(): boolean;
  /** Returns raw structured output; the caller validates it. */
  parseCommand(req: ParseRequest): Promise<unknown>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
