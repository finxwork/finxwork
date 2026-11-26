import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTranslationPrompt,
  parseTranslationResponse,
  TabTranslator,
  TranslationCache,
} from "./translate.ts";

describe("browser translate coordinator", () => {
  it("evicts least recently used entries in TranslationCache and isolates languages", () => {
    const cache = new TranslationCache(2);
    cache.set("zh-CN", "one", "一");
    cache.set("zh-CN", "two", "二");
    // Touch "one" so "two" becomes the oldest entry.
    assert.equal(cache.get("zh-CN", "one"), "一");
    assert.equal(cache.get("en", "one"), undefined);
    cache.set("zh-CN", "three", "三");
    assert.equal(cache.get("zh-CN", "two"), undefined);
    assert.equal(cache.get("zh-CN", "one"), "一");
    assert.equal(cache.get("zh-CN", "three"), "三");
  });

  it("builds <t> prompts and escapes closing </t> tags inside source text", () => {
    const { system, prompt } = buildTranslationPrompt("zh-CN", "Docs", [
      { id: "0", text: 'He said "hello" and </t> here' },
    ]);
    assert.match(system, /Simplified Chinese/);
    assert.match(prompt, /Page title: Docs/);
    assert.match(prompt, /<t id="0">He said "hello" and <\\\/t> here<\/t>/);
  });

  it("parses <t> responses with unescaped quotes, backslashes, angle brackets, and newlines", () => {
    const reply = [
      '<t id="0">"I\'ve never seen a market like this before," said Xu Shendi.</t>',
      '<t id="1">公式: a < b && c > d\n路径: C:\\Users\\demo</t>',
      "<t id='2'>单引号属性也能解析</t>",
      '<t id="extra">ignored</t>',
    ].join("\n");

    assert.deepEqual(parseTranslationResponse(reply, ["0", "1", "2"]), {
      "0": '"I\'ve never seen a market like this before," said Xu Shendi.',
      "1": "公式: a < b && c > d\n路径: C:\\Users\\demo",
      "2": "单引号属性也能解析",
    });
  });

  it("recovers completed blocks from truncated responses and supports JSON fallback", () => {
    assert.deepEqual(
      parseTranslationResponse('<t id="0">第一段</t>\n<t id="1">未写完的段落...', ["0", "1"]),
      { "0": "第一段" },
    );
    assert.deepEqual(
      parseTranslationResponse('```json\n{"translations":{"0":"你好","extra":"ignored"}}\n```', ["0"]),
      { "0": "你好" },
    );
    assert.deepEqual(
      parseTranslationResponse('Result: {"0":"直出对象"}', ["0"]),
      { "0": "直出对象" },
    );
    assert.throws(() => parseTranslationResponse("not structured at all", ["0"]));
  });

  it("reuses cache on partial hits and only sends missing blocks to the model", async () => {
    let calls = 0;
    const translator = new TabTranslator(async (params) => {
      calls++;
      const out: string[] = [];
      for (const m of params.prompt.matchAll(/<t id="([^"]+)">([\s\S]*?)<\/t>/g)) {
        out.push(`<t id="${m[1]}">[ZH] ${m[2]}</t>`);
      }
      return { text: out.join("\n"), model: "mock/model" };
    });

    const first = await translator.translateBatch("tab-1", "zh-CN", "Title", [
      { id: "0", text: "Hello" },
      { id: "1", text: "World" },
    ]);
    assert.deepEqual(first.translations, { "0": "[ZH] Hello", "1": "[ZH] World" });
    assert.equal(calls, 1);

    const second = await translator.translateBatch("tab-1", "zh-CN", "Title", [
      { id: "a", text: "Hello" },
      { id: "b", text: "New paragraph" },
    ]);
    assert.deepEqual(second.translations, { a: "[ZH] Hello", b: "[ZH] New paragraph" });
    assert.equal(calls, 2);

    // Full cache hit makes no model call.
    const third = await translator.translateBatch("tab-1", "zh-CN", "Title", [{ id: "x", text: "World" }]);
    assert.deepEqual(third.translations, { x: "[ZH] World" });
    assert.equal(calls, 2);
  });

  it("keeps tabs isolated when cancelling one tab while another continues", async () => {
    const translator = new TabTranslator(async (params, signal) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 40);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("Aborted"));
        });
      });
      return { text: '<t id="0">译文</t>', model: "mock/model" };
    });

    const tab1 = translator.translateBatch("tab-1", "zh-CN", "T", [{ id: "0", text: "Cancel me" }]);
    const tab2 = translator.translateBatch("tab-2", "zh-CN", "T", [{ id: "0", text: "Keep me" }]);

    translator.cancel("tab-1");
    await assert.rejects(tab1);
    assert.deepEqual((await tab2).translations, { "0": "译文" });
  });

  it("enforces per-tab concurrency limits and aborts in-flight batches on cancel", async () => {
    let running = 0;
    let peak = 0;
    let aborted = 0;

    const translator = new TabTranslator(
      async (_params, signal) => {
        running++;
        peak = Math.max(peak, running);
        return await new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted++;
            running--;
            reject(new Error("Aborted"));
          });
          setTimeout(() => {
            running--;
            resolve({ text: '<t id="0">译文</t>', model: "mock/model" });
          }, 5000);
        });
      },
      { maxConcurrency: 2 },
    );

    const p1 = translator.translateBatch("tab-1", "zh-CN", "T", [{ id: "0", text: "A" }]);
    const p2 = translator.translateBatch("tab-1", "zh-CN", "T", [{ id: "0", text: "B" }]);
    const p3 = translator.translateBatch("tab-1", "zh-CN", "T", [{ id: "0", text: "C" }]);

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(peak, 2);
    assert.equal(running, 2);

    translator.cancel("tab-1");
    await assert.rejects(p1);
    await assert.rejects(p2);
    await assert.rejects(p3);
    assert.equal(aborted, 2);
  });
});
