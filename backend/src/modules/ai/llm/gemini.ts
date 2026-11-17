import { LlmError, type LlmJsonRequest, type LlmProvider } from './provider.js';

/**
 * Google Gemini adapter (REST, no SDK). Only this file knows the vendor API shape.
 * The key travels in a header, never in the URL, and is never echoed into errors or logs.
 */
export interface GeminiOptions {
  apiKey: string;
  model: string;
  embeddingModel: string;
  /** Output size for embeddings. Must match the vector(n) column in migration 0011. */
  embeddingDimensions: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function createGeminiProvider(opts: GeminiOptions): LlmProvider & Required<Pick<LlmProvider, 'embed'>> {
  const base = opts.baseUrl ?? DEFAULT_BASE;
  const doFetch = opts.fetchImpl ?? fetch;

  async function post(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${base}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': opts.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new LlmError('TIMEOUT', 'LLM request timed out');
      throw new LlmError('UNAVAILABLE', 'LLM request failed');
    }
    if (!res.ok) {
      // Only Google's status name is kept (for example RESOURCE_EXHAUSTED). The body may echo request text, so it is dropped.
      const body = (await res.json().catch(() => null)) as { error?: { status?: unknown } } | null;
      const name = typeof body?.error?.status === 'string' ? ` ${body.error.status}` : '';
      throw new LlmError('UNAVAILABLE', `LLM returned HTTP ${res.status}${name}`);
    }
    return res.json();
  }

  return {
    name: 'gemini',
    model: opts.model,

    async generateJson({ system, user, timeoutMs }: LlmJsonRequest): Promise<string> {
      const data = (await post(
        `models/${opts.model}:generateContent`,
        {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            maxOutputTokens: 1024,
            // Structured extraction and ranking need no hidden reasoning tokens.
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
        timeoutMs,
      )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) throw new LlmError('UNAVAILABLE', 'LLM returned no content');
      return text;
    },

    async embed(texts: string[], kind: 'query' | 'document', timeoutMs: number): Promise<number[][]> {
      if (texts.length === 0) return [];
      const modelRef = `models/${opts.embeddingModel}`;
      const data = (await post(
        `${modelRef}:batchEmbedContents`,
        {
          requests: texts.map((text) => ({
            model: modelRef,
            content: { parts: [{ text }] },
            taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
            outputDimensionality: opts.embeddingDimensions,
          })),
        },
        timeoutMs,
      )) as { embeddings?: { values?: number[] }[] };
      const vectors = (data.embeddings ?? []).map((e) => e.values ?? []);
      if (vectors.length !== texts.length || vectors.some((v) => v.length !== opts.embeddingDimensions)) {
        throw new LlmError('UNAVAILABLE', 'Embedding response had the wrong shape');
      }
      return vectors;
    },
  };
}
