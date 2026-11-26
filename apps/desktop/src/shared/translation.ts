/** Shared types and pure deterministic helpers for embedded-browser immersive translation. */

export type TranslationState = {
  url: string;
  enabled: boolean;
  targetLanguage: string;
};

export type TranslationBlock = {
  id: string;
  text: string;
};

export type TranslationBatchRequest = {
  action: "batch";
  url: string;
  title: string;
  targetLanguage: string;
  items: TranslationBlock[];
};

export type TranslationDisableRequest = {
  action: "disable";
  url: string;
};

export type TranslationRequest = TranslationBatchRequest | TranslationDisableRequest;

export type TranslationBatchResult = {
  translations: Record<string, string>;
  cancelled?: boolean;
};

const URL_ONLY = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const KANA_RE = /[\u3040-\u30ff]/g;
const HANGUL_RE = /[\uac00-\ud7af]/g;
const LATIN_RE = /[A-Za-z]/g;
const LETTER_RE = /\p{L}/gu;

/** Normalize whitespace for matching and deduplication. */
export function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** True when a text snippet is too short or non-linguistic to translate. */
export function shouldSkipText(raw: string): boolean {
  const text = normalizeText(raw);
  if (text.length < 2) return true;
  if (URL_ONLY.test(text)) return true;
  const letters = text.match(LETTER_RE);
  if (!letters || letters.length < 2) return true;
  return false;
}

/**
 * Deterministic script heuristic to skip paragraphs that are already in the target language.
 * Keeps unnecessary tokens off the wire without needing an LLM round-trip.
 */
export function isAlreadyTargetLanguage(raw: string, targetLanguage: string): boolean {
  const text = normalizeText(raw);
  if (!text) return true;
  const letters = text.match(LETTER_RE)?.length ?? 0;
  if (letters === 0) return true;

  const lang = targetLanguage.toLowerCase();
  if (lang.startsWith("zh")) {
    // Japanese text often contains kanji alongside kana; never treat kana-bearing text as Chinese.
    const kana = text.match(KANA_RE)?.length ?? 0;
    if (kana >= 2) return false;
    const cjk = text.match(CJK_RE)?.length ?? 0;
    return cjk / letters >= 0.35 || (cjk >= 6 && cjk / letters >= 0.25);
  }

  if (lang.startsWith("en")) {
    const cjk = text.match(CJK_RE)?.length ?? 0;
    const kana = text.match(KANA_RE)?.length ?? 0;
    const hangul = text.match(HANGUL_RE)?.length ?? 0;
    if (cjk + kana + hangul > 0) return false;
    const latin = text.match(LATIN_RE)?.length ?? 0;
    // Skip pure ASCII Latin text when translating into English; non-ASCII accented text may be
    // French/German/Spanish and is still allowed through.
    return latin / letters >= 0.96;
  }

  return false;
}

/** Split visible blocks into bounded batches for low-latency, bounded-token LLM calls. */
export function chunkBlocks(
  items: TranslationBlock[],
  maxItems = 12,
  maxChars = 2500,
): TranslationBlock[][] {
  const batches: TranslationBlock[][] = [];
  let current: TranslationBlock[] = [];
  let chars = 0;

  for (const item of items) {
    const len = item.text.length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}
