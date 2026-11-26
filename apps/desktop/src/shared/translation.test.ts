import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkBlocks, isAlreadyTargetLanguage, normalizeText, shouldSkipText } from "./translation.ts";

describe("translation shared helpers", () => {
  it("normalizes whitespace including tabs and newlines", () => {
    assert.equal(normalizeText("  Hello\n\t   world  "), "Hello world");
    assert.equal(normalizeText("\n\r  "), "");
  });

  it("skips empty, single-char, numeric, currency, date, punctuation, email, and URL snippets", () => {
    for (const sample of [
      "",
      "   ",
      "a",
      "中",
      "123,456.78",
      "$99.95",
      "2026-11-22",
      "100%",
      "— • · …",
      "https://example.com/docs/intro",
      "www.bloomberg.com",
      "mailto:hello@example.com",
    ]) {
      assert.equal(shouldSkipText(sample), true, `expected skip: ${JSON.stringify(sample)}`);
    }

    for (const sample of ["Hello world", "中文段落", "AI", "v2 release notes"]) {
      assert.equal(shouldSkipText(sample), false, `expected keep: ${JSON.stringify(sample)}`);
    }
  });

  it("detects paragraphs already in Chinese (zh-CN) while keeping English, Japanese, and Korean", () => {
    assert.equal(isAlreadyTargetLanguage("这是一段已经写成中文的正文内容。", "zh-CN"), true);
    assert.equal(isAlreadyTargetLanguage("使用 TypeScript 编写 Electron 应用非常顺手。", "zh-CN"), true);
    assert.equal(isAlreadyTargetLanguage("API 文档说明", "zh-CN"), true);

    assert.equal(isAlreadyTargetLanguage("This paragraph is written in English.", "zh-CN"), false);
    assert.equal(isAlreadyTargetLanguage("The Bitter Lesson by Rich Sutton", "zh-CN"), false);
    assert.equal(isAlreadyTargetLanguage("これは日本語のテスト文章です。", "zh-CN"), false);
    assert.equal(isAlreadyTargetLanguage("한국어 테스트 문장입니다.", "zh-CN"), false);
  });

  it("detects paragraphs already in English while keeping CJK, Korean, and accented European text", () => {
    assert.equal(isAlreadyTargetLanguage("Plain English documentation paragraph.", "en"), true);
    assert.equal(isAlreadyTargetLanguage("这是一段中文内容。", "en"), false);
    assert.equal(isAlreadyTargetLanguage("これは日本語です。", "en"), false);
    assert.equal(isAlreadyTargetLanguage("한국어 문장입니다.", "en"), false);
    assert.equal(isAlreadyTargetLanguage("Résumé café naïve façade déjà vu", "en"), false);
    assert.equal(isAlreadyTargetLanguage("Über die Straße gehen für größere Pläne", "en"), false);
  });

  it("returns false for unknown target languages rather than skipping", () => {
    assert.equal(isAlreadyTargetLanguage("Hello world", "fr-FR"), false);
  });

  it("chunks blocks by item count and character budget", () => {
    assert.deepEqual(chunkBlocks([]), []);

    const items = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: "x".repeat(40) }));
    const byCount = chunkBlocks(items, 2, 1000);
    assert.deepEqual(byCount.map((b) => b.length), [2, 2, 1]);

    const byChars = chunkBlocks(items, 10, 90);
    assert.deepEqual(byChars.map((b) => b.length), [2, 2, 1]);

    // Single oversized block still makes progress in its own batch.
    const big = chunkBlocks([{ id: "0", text: "a".repeat(5000) }], 12, 2500);
    assert.equal(big.length, 1);
    assert.equal(big[0].length, 1);
  });
});
