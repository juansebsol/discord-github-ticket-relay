/**
 * Claude API access for triage, through Anthropic's official SDK. One client per call,
 * because each workspace brings its own key. Retries are handled by the triage queue
 * (with backoff), so the SDK's own retries are off.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { FetchLike } from '../lib/http.js';
import { MISSING_ITEMS, PRIORITIES, type PauseReason } from './settings.js';

/** The answer Claude must return. Ranges are checked after parsing (see normalizeVerdict). */
export const VerdictSchema = z.object({
  priority: z.enum(PRIORITIES),
  priority_confidence: z.number().int(),
  /** Every candidate that is the same problem, with a confidence for each. */
  duplicates: z.array(z.object({ number: z.number().int(), confidence: z.number().int() })),
  spam: z.boolean(),
  spam_confidence: z.number().int(),
  needs_info: z.boolean(),
  needs_info_confidence: z.number().int(),
  no_action: z.boolean(),
  no_action_confidence: z.number().int(),
  not_dev_issue: z.boolean(),
  not_dev_issue_confidence: z.number().int(),
  /** For needs_info: what's missing, chosen from a fixed list. */
  missing: z.array(z.enum(MISSING_ITEMS)),
  reason: z.string(),
});
export type AiVerdict = z.infer<typeof VerdictSchema>;

/**
 * The verdict as stored: Claude's answer plus the original the code chose among its matches
 * (duplicate_of), so older results and the rest of triage keep working with one number.
 */
export interface Verdict extends AiVerdict {
  duplicate_of: number | null;
  duplicate_confidence: number;
  /** The newer copy that led to the original, when a chain was followed. */
  duplicate_via?: number | null;
  /** The original is closed: never closed automatically, only suggested. */
  duplicate_closed?: boolean;
  /** Other matches. */
  duplicate_others?: number[];
}

export interface ModelOption {
  id: string;
  name: string;
  deprecated: boolean;
}

export interface Classification {
  verdict: AiVerdict;
  inputTokens: number;
  outputTokens: number;
}

/** A failure the queue knows how to handle: pause the workspace, retry later, or skip the ticket. */
export class TriageAiError extends Error {
  constructor(
    readonly action: 'pause' | 'retry' | 'skip',
    message: string,
    readonly pauseReason: PauseReason | null = null,
  ) {
    super(message);
    this.name = 'TriageAiError';
  }
}

/** Maps SDK errors to queue actions, using the SDK's typed error classes. */
export function classifyAiError(err: unknown): TriageAiError {
  if (err instanceof TriageAiError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new TriageAiError('pause', 'Claude rejected the API key.', 'key_invalid');
  }
  if (err instanceof Anthropic.APIError && (err.status === 402 || err.type === 'billing_error')) {
    return new TriageAiError('pause', 'The Anthropic account is out of credits.', 'credits');
  }
  if (err instanceof Anthropic.NotFoundError) return new TriageAiError('pause', 'The model isn’t available to this API key.', 'model_unavailable');
  if (err instanceof Anthropic.BadRequestError) return new TriageAiError('pause', err.message.replace(/^\d+\s*/, '').slice(0, 300), 'rejected');
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new TriageAiError('retry', err instanceof Anthropic.RateLimitError ? 'Claude rate limit' : 'Claude was unavailable');
  }
  if (err instanceof Anthropic.APIError && err.status !== undefined && err.status >= 500) return new TriageAiError('retry', 'Claude was unavailable');
  if (err instanceof Anthropic.AnthropicError) return new TriageAiError('skip', 'Claude’s answer couldn’t be read.');
  return new TriageAiError('retry', (err as Error)?.message?.slice(0, 200) || 'Unexpected error');
}

export class TriageAi {
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private client(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      maxRetries: 0,
      timeout: 60_000,
      fetch: (input, init) => this.fetchImpl(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init),
    });
  }

  /** Models this key can use that support structured output, newest first. */
  async listModels(apiKey: string): Promise<ModelOption[]> {
    const out: ModelOption[] = [];
    for await (const m of this.client(apiKey).models.list({ limit: 100 })) {
      const caps = m.capabilities as Record<string, { supported?: boolean }> | null;
      if (m.lifecycle === 'retired' || caps?.structured_outputs?.supported === false) continue;
      out.push({ id: m.id, name: m.display_name, deprecated: m.lifecycle === 'deprecated' });
    }
    return out;
  }

  async classify(apiKey: string, model: string, system: string, user: string): Promise<Classification> {
    try {
      const response = await this.client(apiKey).messages.parse({
        model,
        max_tokens: 8000,
        // The system prompt is the same for every ticket in a workspace, so cache it.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(VerdictSchema) },
      });
      if (response.stop_reason === 'refusal') throw new TriageAiError('skip', 'Claude declined to classify this ticket.');
      if (response.stop_reason === 'max_tokens') throw new TriageAiError('skip', 'Claude’s answer was cut off.');
      if (!response.parsed_output) throw new TriageAiError('skip', 'Claude’s answer couldn’t be read.');
      return { verdict: response.parsed_output, inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens };
    } catch (err) {
      throw classifyAiError(err);
    }
  }
}

/**
 * Clamps confidences to 0–100 and keeps only matches that are among the candidates Claude was
 * shown (once each, most confident first). The original is chosen afterwards (see chooseOriginal).
 */
export function normalizeVerdict(v: AiVerdict, candidateNumbers: Set<number>): Verdict {
  const c = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const seen = new Set<number>();
  const duplicates = (v.duplicates ?? [])
    .map((d) => ({ number: d.number, confidence: c(d.confidence) }))
    .filter((d) => candidateNumbers.has(d.number) && !seen.has(d.number) && seen.add(d.number))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
  return {
    ...v,
    priority_confidence: c(v.priority_confidence),
    duplicates,
    duplicate_of: duplicates[0]?.number ?? null,
    duplicate_confidence: duplicates[0]?.confidence ?? 0,
    spam_confidence: c(v.spam_confidence),
    needs_info_confidence: c(v.needs_info_confidence),
    no_action_confidence: c(v.no_action_confidence),
    not_dev_issue_confidence: c(v.not_dev_issue_confidence),
    missing: v.needs_info ? [...new Set(v.missing)] : [],
    reason: v.reason.replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}
