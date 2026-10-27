import { env } from '../config/env';

/**
 * Speech-to-text behind an interface, for phones without browser speech recognition
 * (iOS Safari) or when the shop turns on "High accuracy mode". The default provider talks to any
 * Whisper-compatible `/audio/transcriptions` API (OpenAI, Groq, or a self-hosted server).
 */

export interface TranscribeRequest {
  audio: Buffer;
  /** e.g. "audio/webm", "audio/mp4" (iOS). */
  mimeType: string;
  lang: 'hi' | 'en';
}

export interface SttProvider {
  readonly name: string;
  isAvailable(): boolean;
  transcribe(req: TranscribeRequest): Promise<string>;
}

export class SttError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = 'SttError';
  }
}

/** Largest upload accepted: about a minute of compressed speech, so 30 seconds fits easily. */
export const STT_MAX_BYTES = 1024 * 1024;
export const STT_AUDIO_TYPES = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/x-m4a'];

const DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
  whisper: { baseUrl: 'http://localhost:8000/v1', model: 'whisper-1' },
};

const EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' };

/** Vocabulary hint so Whisper spells shop words the way the parser expects. */
const HINT = 'Kirana dukaan ka hisaab: udhaar, jama, rupay, saman, Sharma ji ke 500 likho, Gupta ji ne 200 diye, cheeni, aata, doodh.';

export class WhisperCompatibleProvider implements SttProvider {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    kind = env.STT_PROVIDER,
    private readonly apiKey = env.STT_API_KEY,
    baseUrl = env.STT_BASE_URL,
    model = env.STT_MODEL,
  ) {
    this.name = kind;
    const d = DEFAULTS[kind] ?? DEFAULTS.openai!;
    this.baseUrl = (baseUrl || d.baseUrl).replace(/\/+$/, '');
    this.model = model || d.model;
  }

  isAvailable(): boolean {
    // A self-hosted server may not need a key; the hosted ones do.
    return this.name !== 'none' && (Boolean(this.apiKey) || this.name === 'whisper');
  }

  async transcribe(req: TranscribeRequest): Promise<string> {
    const type = req.mimeType.split(';')[0]!.trim().toLowerCase();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(req.audio)], { type }), `voice.${EXT[type] ?? 'webm'}`);
    form.append('model', this.model);
    form.append('language', req.lang);
    form.append('response_format', 'json');
    form.append('temperature', '0');
    form.append('prompt', HINT);

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
        body: form,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new SttError(err instanceof Error && err.name === 'TimeoutError' ? 'Speech service timed out' : 'Speech service unreachable', 504);
    }
    if (res.status === 401 || res.status === 403) throw new SttError('Invalid STT_API_KEY', 502);
    if (res.status === 429) throw new SttError('Speech service is busy, please try again', 503);
    if (!res.ok) throw new SttError(`Speech service error ${res.status}`, 502);
    const body = (await res.json().catch(() => ({}))) as { text?: unknown };
    return typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
  }
}

let stt: SttProvider = new WhisperCompatibleProvider();
export const getSttProvider = () => stt;
/** Swap the provider (tests, or another vendor). */
export const setSttProvider = (p: SttProvider) => {
  stt = p;
};
