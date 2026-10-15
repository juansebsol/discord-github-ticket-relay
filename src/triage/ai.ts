/**
 * Claude API access for triage, through Anthropic's official SDK. One client per call,
 * because each workspace brings its own key. Retries are handled by the triage queue
 * (with backoff), so the SDK's own retries are off.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { FetchLike } from '../lib/http.js';
import { MISSING_ITEMS, PRIORITIES, type LabelGroup, type PauseReason } from './settings.js';

const int = () => z.number().int();

/** What the answer can name: the workspace's label groups and apps (Claude can only choose from these). */
export interface VerdictContext {
  groups: LabelGroup[];
  apps: string[];
}

/**
 * The answer Claude must return, in this order (reason first, so it reasons before deciding).
 * Built per workspace. Label options and app names are listed in each field's description
 * rather than as enums: the SDK only passes enums on as hints, and a strict check would throw
 * away the whole answer for one stray label. normalizeVerdict drops anything not listed.
 */
export function verdictSchema(ctx: VerdictContext) {
  const appName = z.string().describe(ctx.apps.length ? `One of these app names: ${ctx.apps.join(', ')}` : 'An app name');
  const labels = z.object(Object.fromEntries(ctx.groups.map((g) => [g.id, z.object({
    options: z.array(z.string().describe(`One of: ${g.options.map((o) => o.label).join(', ')}`)),
    confidence: int(),
  })])));
  return z.object({
    reason: z.string(),
    summary: z.string(),
    spam: z.boolean(),
    spam_confidence: int(),
    no_action: z.boolean(),
    no_action_confidence: int(),
    not_dev_issue: z.boolean(),
    not_dev_issue_confidence: int(),
    /** Every candidate in the same repository that is the same problem, with a confidence for each. */
    duplicates: z.array(z.object({ number: int(), confidence: int() })),
    regression_of: int().nullable(),
    regression_confidence: int(),
    needs_info: z.boolean(),
    needs_info_confidence: int(),
    /** For needs_info: what's missing, chosen from a fixed list. */
    missing: z.array(z.enum(MISSING_ITEMS)),
    parts: z.array(z.string()),
    parts_confidence: int(),
    related: z.array(z.string()),
    related_confidence: int(),
    shared: z.boolean(),
    shared_confidence: int(),
    shared_apps: z.array(appName),
    shared_issue: z.string().nullable(),
    right_app: appName.nullable(),
    right_app_confidence: int(),
    version: z.string().nullable(),
    labels,
    priority: z.enum(PRIORITIES),
    priority_confidence: int(),
  });
}

/** The answer with no label groups or apps (types and tests). */
export const VerdictSchema = verdictSchema({ groups: [], apps: [] });

export type AiVerdict = Omit<z.infer<typeof VerdictSchema>, 'labels' | 'shared_apps' | 'right_app'> & {
  labels: Record<string, { options: string[]; confidence: number }>;
  shared_apps: string[];
  right_app: string | null;
};

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
    /** For rate limits: how long Claude asked to wait. */
    readonly retryAfterSeconds: number | null = null,
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
  if (err instanceof Anthropic.RateLimitError) {
    const wait = Number((err.headers as Headers | undefined)?.get?.('retry-after'));
    return new TriageAiError('retry', 'Claude rate limit', null, Number.isFinite(wait) && wait > 0 ? Math.min(wait, 600) : 30);
  }
  if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
    return new TriageAiError('retry', 'Claude was unavailable');
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

  async classify(apiKey: string, model: string, system: string, user: string, schema: ReturnType<typeof verdictSchema> = VerdictSchema): Promise<Classification> {
    try {
      const response = await this.client(apiKey).messages.parse({
        model,
        max_tokens: 8000,
        // The system prompt is the same for every ticket in a workspace, so cache it.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
        output_config: { format: zodOutputFormat(schema) },
      });
      if (response.stop_reason === 'refusal') throw new TriageAiError('skip', 'Claude declined to classify this ticket.');
      if (response.stop_reason === 'max_tokens') throw new TriageAiError('skip', 'Claude’s answer was cut off.');
      if (!response.parsed_output) throw new TriageAiError('skip', 'Claude’s answer couldn’t be read.');
      return { verdict: response.parsed_output as AiVerdict, inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0), outputTokens: response.usage.output_tokens };
    } catch (err) {
      throw classifyAiError(err);
    }
  }
}

/** What Claude was shown, to check every reference in its answer against. */
export interface NormalizeContext {
  /** Candidates in the ticket's own repository, by number. */
  sameRepo: Map<number, { state: 'open' | 'closed' }>;
  /** Every candidate's ref ("owner/repo#number"). */
  refs: Set<string>;
  apps: string[];
  groups: LabelGroup[];
}

/**
 * Clamps confidences to 0–100 and keeps only what Claude was actually shown: duplicates from
 * the ticket's repository (once each, most confident first), a regression of a closed issue,
 * related issues and labels from the defined options. The original is chosen afterwards
 * (see chooseOriginal).
 */
export function normalizeVerdict(v: AiVerdict, ctx: NormalizeContext | Set<number>): Verdict {
  const x: NormalizeContext = ctx instanceof Set
    ? { sameRepo: new Map([...ctx].map((n) => [n, { state: 'open' as const }])), refs: new Set(), apps: [], groups: [] }
    : ctx;
  const c = (n: number) => Math.max(0, Math.min(100, Math.round(n ?? 0)));
  const text = (s: unknown, max: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const seen = new Set<number>();
  const regression = v.regression_of !== null && v.regression_of !== undefined && x.sameRepo.get(v.regression_of)?.state === 'closed' ? v.regression_of : null;
  const duplicates = (v.duplicates ?? [])
    .map((d) => ({ number: d.number, confidence: c(d.confidence) }))
    .filter((d) => x.sameRepo.has(d.number) && d.number !== regression && !seen.has(d.number) && seen.add(d.number))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 10);
  const related = [...new Set((v.related ?? []).filter((r) => x.refs.has(r)))].slice(0, 3);
  const parts = (v.parts ?? []).map((p) => text(p, 160)).filter(Boolean).slice(0, 6);
  const labels: Verdict['labels'] = {};
  for (const g of x.groups) {
    const allowed = new Set(g.options.map((o) => o.label));
    const picked = [...new Set((v.labels?.[g.id]?.options ?? []).filter((o) => allowed.has(o)))];
    labels[g.id] = { options: picked.slice(0, g.pick === 'one' ? 1 : g.pick === 'two' ? 2 : picked.length), confidence: c(v.labels?.[g.id]?.confidence ?? 0) };
  }
  const apps = new Set(x.apps);
  return {
    ...v,
    summary: text(v.summary, 200),
    priority_confidence: c(v.priority_confidence),
    duplicates,
    duplicate_of: duplicates[0]?.number ?? null,
    duplicate_confidence: duplicates[0]?.confidence ?? 0,
    regression_of: regression,
    regression_confidence: regression === null ? 0 : c(v.regression_confidence),
    spam_confidence: c(v.spam_confidence),
    needs_info_confidence: c(v.needs_info_confidence),
    no_action_confidence: c(v.no_action_confidence),
    not_dev_issue_confidence: c(v.not_dev_issue_confidence),
    missing: v.needs_info ? [...new Set(v.missing ?? [])] : [],
    parts: parts.length >= 2 ? parts : [],
    parts_confidence: parts.length >= 2 ? c(v.parts_confidence) : 0,
    related,
    related_confidence: related.length ? c(v.related_confidence) : 0,
    shared: Boolean(v.shared),
    shared_confidence: c(v.shared_confidence),
    shared_apps: [...new Set((v.shared_apps ?? []).filter((a) => apps.has(a)))],
    shared_issue: v.shared_issue && x.refs.has(v.shared_issue) ? v.shared_issue : null,
    right_app: v.right_app && apps.has(v.right_app) ? v.right_app : null,
    right_app_confidence: v.right_app && apps.has(v.right_app) ? c(v.right_app_confidence) : 0,
    version: v.version ? text(v.version, 40) || null : null,
    labels,
    reason: text(v.reason, 600),
  };
}
