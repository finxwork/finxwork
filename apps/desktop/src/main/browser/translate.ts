import type { ModelsCompleteParams, ModelsCompleteResult } from "@finx/protocol";
import type { TranslationBatchResult, TranslationBlock } from "../../shared/translation";

export type CompleteFn = (params: ModelsCompleteParams, signal?: AbortSignal) => Promise<ModelsCompleteResult>;

/** Bounded in-memory LRU cache keyed by `${targetLanguage}\0${text}`. */
export class TranslationCache {
  private readonly map = new Map<string, string>();
  private readonly maxEntries: number;

  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
  }

  private key(targetLanguage: string, text: string): string {
    return `${targetLanguage}\0${text}`;
  }

  get(targetLanguage: string, text: string): string | undefined {
    const k = this.key(targetLanguage, text);
    const hit = this.map.get(k);
    if (hit === undefined) return undefined;
    // Refresh recency for LRU ordering.
    this.map.delete(k);
    this.map.set(k, hit);
    return hit;
  }

  set(targetLanguage: string, text: string, translated: string): void {
    const k = this.key(targetLanguage, text);
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, translated);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

function languageName(code: string): string {
  const lower = code.toLowerCase();
  if (lower.startsWith("zh")) return "Simplified Chinese (简体中文)";
  if (lower.startsWith("en")) return "English";
  return code;
}

function escapeTagText(text: string): string {
  return text.replace(/<\/t>/gi, "<\\/t>");
}

export function buildTranslationPrompt(
  targetLanguage: string,
  pageTitle: string,
  items: TranslationBlock[],
): { system: string; prompt: string } {
  const lang = languageName(targetLanguage);
  const system = [
    `You are a concise, accurate web page translator. Translate each <t id="..."> block into ${lang}.`,
    `Reply ONLY with matching <t id="...">translated text</t> blocks in the same order, with no commentary or markdown fences.`,
    `Preserve proper nouns, inline code, quotes, numbers, and symbols naturally. If a block is already in ${lang}, return it unchanged.`,
  ].join("\n");

  const lines = [];
  if (pageTitle.trim()) lines.push(`Page title: ${pageTitle.trim().slice(0, 200)}`);
  for (const item of items) {
    lines.push(`<t id="${item.id}">${escapeTagText(item.text)}</t>`);
  }
  return { system, prompt: lines.join("\n") };
}

/**
 * Extracts translations from `<t id="...">...</t>` blocks (immune to unescaped quotes/newlines
 * in news articles), falling back to JSON if a model replies with JSON.
 */
export function parseTranslationResponse(raw: string, expectedIds: string[]): Record<string, string> {
  const allowed = new Set(expectedIds);
  const out: Record<string, string> = {};

  const tagRe = /<t\s+id=["']?([^"'\s>]+)["']?\s*>([\s\S]*?)<\/t>/gi;
  let match: RegExpExecArray | null;
  let matchedTag = false;
  while ((match = tagRe.exec(raw)) !== null) {
    matchedTag = true;
    const id = match[1];
    const value = match[2].trim();
    if (allowed.has(id) && value.length > 0) {
      out[id] = value;
    }
  }
  if (matchedTag) return out;

  // Fallback: JSON response (`{"translations":{"id":"..."}}` or `{"id":"..."}`).
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("Invalid translation response");
    parsed = JSON.parse(candidate.slice(start, end + 1));
  }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid translation response");
  const record = parsed as Record<string, unknown>;
  const source =
    record.translations && typeof record.translations === "object"
      ? (record.translations as Record<string, unknown>)
      : record;
  for (const [id, value] of Object.entries(source)) {
    if (allowed.has(id) && typeof value === "string" && value.trim().length > 0) {
      out[id] = value.trim();
    }
  }
  return out;
}

type TabState = {
  generation: number;
  active: number;
  queue: Array<() => void>;
  controllers: Set<AbortController>;
};

/**
 * Coordinates per-tab concurrency limiting, cancellation, and LRU caching for browser translation.
 */
export class TabTranslator {
  private readonly cache: TranslationCache;
  private readonly complete: CompleteFn;
  private readonly maxConcurrency: number;
  private readonly tabs = new Map<string, TabState>();

  constructor(complete: CompleteFn, options?: { maxEntries?: number; maxConcurrency?: number }) {
    this.complete = complete;
    this.cache = new TranslationCache(options?.maxEntries ?? 2000);
    this.maxConcurrency = options?.maxConcurrency ?? 2;
  }

  private state(targetId: string): TabState {
    let s = this.tabs.get(targetId);
    if (!s) {
      s = { generation: 0, active: 0, queue: [], controllers: new Set() };
      this.tabs.set(targetId, s);
    }
    return s;
  }

  /** Cancels all in-flight and queued translation batches for a tab. */
  cancel(targetId: string): void {
    const s = this.tabs.get(targetId);
    if (!s) return;
    s.generation++;
    for (const c of s.controllers) c.abort();
    s.controllers.clear();
    const queued = s.queue.splice(0);
    for (const wake of queued) wake();
  }

  /** Removes per-tab bookkeeping when a tab closes. */
  dispose(targetId: string): void {
    this.cancel(targetId);
    this.tabs.delete(targetId);
  }

  async translateBatch(
    targetId: string,
    targetLanguage: string,
    pageTitle: string,
    items: TranslationBlock[],
  ): Promise<TranslationBatchResult> {
    const translations: Record<string, string> = {};
    const missing: TranslationBlock[] = [];

    for (const item of items) {
      const hit = this.cache.get(targetLanguage, item.text);
      if (hit !== undefined) translations[item.id] = hit;
      else missing.push(item);
    }

    if (missing.length === 0) return { translations };

    const s = this.state(targetId);
    const gen = s.generation;

    // Wait for a concurrency slot on this tab.
    while (s.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => s.queue.push(resolve));
      if (s.generation !== gen) throw new Error("Translation cancelled");
    }

    s.active++;
    const controller = new AbortController();
    s.controllers.add(controller);
    try {
      const { system, prompt } = buildTranslationPrompt(targetLanguage, pageTitle, missing);
      const reply = await this.complete({ system, prompt, max_tokens: 4096 }, controller.signal);
      if (s.generation !== gen) throw new Error("Translation cancelled");

      const parsed = parseTranslationResponse(
        reply.text,
        missing.map((m) => m.id),
      );
      for (const item of missing) {
        const value = parsed[item.id];
        if (value) {
          this.cache.set(targetLanguage, item.text, value);
          translations[item.id] = value;
        }
      }
      return { translations };
    } finally {
      s.controllers.delete(controller);
      s.active--;
      const next = s.queue.shift();
      if (next) next();
    }
  }
}
