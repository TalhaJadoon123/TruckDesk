/**
 * Groq client for the free tier.
 *
 * Groq exposes an OpenAI-compatible chat completions API with no SDK
 * requirement, so this talks to it over `fetch`. That keeps the dependency
 * count at zero, makes the whole thing trivially mockable in tests, and means
 * it runs unmodified on Cloudflare Workers (which has fetch but a restricted
 * Node surface).
 *
 * Free tier notes: the no-auth path returns a deterministic canned response so
 * the broker email parser is fully usable during local development and in CI.
 * With `GROQ_API_KEY` set, real inference runs.
 */

export interface GroqMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqOptions {
  /** Model id. llama-3.3-70b-versatile is fast and free-tier eligible. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Server-side JSON mode, when the model supports it. */
  jsonMode?: boolean;
  timeoutMs?: number;
  /** Retries on 429/5xx. Free tiers rate limit aggressively. */
  retries?: number;
  apiKey?: string;
  baseUrl?: string;
  /** Injected transport, used by tests and by the API to add a deadline. */
  fetchImpl?: typeof fetch;
  /** When true, never touch the network. Returns the offline canned answer. */
  offline?: boolean;
}

export interface GroqUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GroqResult {
  content: string;
  model: string;
  usage: GroqUsage;
  /** ms, measured. */
  latencyMs: number;
  finishReason: string | null;
  /** True when the answer came from the offline canned response. */
  offline: boolean;
}

export class GroqError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, message: string, code = 'groq_error') {
    super(`Groq ${status}: ${message}`);
    this.name = 'GroqError';
    this.status = status;
    this.code = code;
    this.retryable = status === 429 || status >= 500;
  }
}

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export class GroqClient {
  private readonly options: Required<Omit<GroqOptions, 'fetchImpl'>> & { fetchImpl?: typeof fetch };

  constructor(options: GroqOptions = {}) {
    this.options = {
      model: options.model ?? DEFAULT_MODEL,
      temperature: options.temperature ?? 0.1,
      maxTokens: options.maxTokens ?? 1024,
      jsonMode: options.jsonMode ?? true,
      timeoutMs: options.timeoutMs ?? 20_000,
      retries: options.retries ?? 2,
      apiKey: options.apiKey ?? '',
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      offline: options.offline ?? false,
      fetchImpl: options.fetchImpl,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** True when this client will produce real model output. */
  isLive(): boolean {
    return this.isConfigured() && !this.options.offline;
  }

  async chat(messages: GroqMessage[], signal?: AbortSignal): Promise<GroqResult> {
    const started = Date.now();

    // No key: return the canned response so the feature still works offline.
    if (!this.isLive()) {
      return {
        content: offlineCannedResponse(messages),
        model: `${this.options.model} (offline)`,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: Date.now() - started,
        finishReason: 'stop',
        offline: true,
      };
    }

    const body = {
      model: this.options.model,
      messages,
      temperature: this.options.temperature,
      max_tokens: this.options.maxTokens,
      ...(this.options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    };

    let lastError: GroqError | null = null;
    for (let attempt = 0; attempt <= this.options.retries; attempt += 1) {
      try {
        return await this.once(body, started, signal);
      } catch (error) {
        if (error instanceof GroqError) {
          lastError = error;
          if (!error.retryable || attempt === this.options.retries) throw error;
        } else {
          throw error;
        }
        // Back off: free-tier 429s are short, so a short linear wait works.
        await delay(300 * (attempt + 1));
      }
    }

    throw lastError ?? new GroqError(500, 'Groq request failed for an unknown reason');
  }

  private async once(
    body: unknown,
    started: number,
    outerSignal?: AbortSignal,
  ): Promise<GroqResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    // Chain an external signal onto the internal timeout.
    const onAbort = () => controller.abort();
    outerSignal?.addEventListener('abort', onAbort);

    try {
      const response = await fetchImpl(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new GroqError(response.status, text.slice(0, 300));
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };

      const choice = payload.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== 'string') {
        throw new GroqError(502, 'Groq response had no message content');
      }

      return {
        content,
        model: this.options.model,
        usage: {
          promptTokens: payload.usage?.prompt_tokens ?? 0,
          completionTokens: payload.usage?.completion_tokens ?? 0,
          totalTokens: payload.usage?.total_tokens ?? 0,
        },
        latencyMs: Date.now() - started,
        finishReason: choice?.finish_reason ?? null,
        offline: false,
      };
    } catch (error) {
      if (error instanceof GroqError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new GroqError(0, message, error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network');
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * With no API key the client still has to answer, so this reads the load out of
 * the prompt heuristically. It is intentionally simple: the production path is
 * a real model, and this exists so local dev, CI and the demo do not need one.
 */
function offlineCannedResponse(messages: GroqMessage[]): string {
  const email = messages.filter((message) => message.role === 'user').map((m) => m.content).join('\n');
  return JSON.stringify(extractHeuristically(email));
}

/** Loose extraction used only on the offline path. */
export function extractHeuristically(text: string): Record<string, unknown> {
  const originMatch = /(?:origin|pickup(?:\s+at)?|from|collect)\s*[:\-]\s*([^\n,;]+(?:,\s*[A-Z]{2})?(?:\s+\d{5})?)/i.exec(text);
  const destinationMatch = /(?:destination|deliver(?:y)?(?:\s+at)?|to|drop)\s*[:\-]\s*([^\n,;]+(?:,\s*[A-Z]{2})?(?:\s+\d{5})?)/i.exec(text);

  const rateMatch = /\$?\s*([\d,]+(?:\.\d{2})?)\s*(?:flat|all in|total)?/i.exec(text);
  const milesMatch = /([\d,]{2,5})\s*(?:miles|mi\b)/i.exec(text);
  const weightMatch = /([\d,]{3,6})\s*(?:lbs|lb|pounds)/i.exec(text);

  return {
    broker: /from\s*:\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? null,
    origin: originMatch?.[1]?.trim() ?? null,
    destination: destinationMatch?.[1]?.trim() ?? null,
    rate: rateMatch ? rateMatch[1] : null,
    miles: milesMatch ? milesMatch[1] : null,
    weightLbs: weightMatch ? weightMatch[1] : null,
    pickupDate: /(pickup|load)\s*(?:date)?\s*[:\-]\s*([^\n]+)/i.exec(text)?.[2]?.trim() ?? null,
    deliveryDate: /(delivery|deliver)\s*(?:date)?\s*[:\-]\s*([^\n]+)/i.exec(text)?.[2]?.trim() ?? null,
  };
}

export const GROQ_DEFAULT_MODEL = DEFAULT_MODEL;
export const GROQ_BASE_URL = DEFAULT_BASE_URL;