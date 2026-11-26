import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractPageParagraphs, type PdfTextItem } from "./pdfBlocks.ts";

function span(str: string, x: number, y: number, width: number, fontSize = 11): PdfTextItem {
  return { str, transform: [fontSize, 0, 0, fontSize, x, y], width, height: fontSize };
}

describe("PDF geometric paragraph extraction", () => {
  it("groups single-column title + paragraphs, filters headers/footers, and rejoins hyphenated wraps", () => {
    const items: PdfTextItem[] = [
      // Running header & footer (should be filtered)
      span("2/3/22, 9:31 PM", 50, 765, 80, 8),
      span("The Bitter Lesson", 360, 765, 80, 8),
      span("http://www.incompleteideas.net/IncIdeas/BitterLesson.html", 50, 20, 260, 8),
      span("1/2", 540, 20, 15, 8),

      // Heading
      span("The Bitter Lesson", 50, 700, 180, 18),

      // Paragraph 1 (3 lines with a hyphenated wrap)
      span("The biggest lesson that can be read from 70 years of AI compu-", 50, 660, 480, 11),
      span("tation research is that general methods leverage scale.", 50, 645, 460, 11),

      // Paragraph 2 (separated by clear vertical paragraph gap)
      span("In computer chess, search beat hand-crafted rules.", 50, 610, 420, 11),
    ];

    const paras = extractPageParagraphs(items, 1, 612, 792);
    assert.equal(paras.length, 3);
    assert.equal(paras[0].kind, "heading");
    assert.equal(paras[0].text, "The Bitter Lesson");
    assert.equal(paras[1].kind, "body");
    assert.equal(
      paras[1].text,
      "The biggest lesson that can be read from 70 years of AI computation research is that general methods leverage scale.",
    );
    assert.equal(paras[1].rects.length, 2);
    assert.equal(paras[2].text, "In computer chess, search beat hand-crafted rules.");
  });

  it("reads two-column academic papers in top -> left column -> right column order", () => {
    const items: PdfTextItem[] = [
      // Full-width title spanning both columns
      span("Attention Is All You Need", 140, 720, 320, 18),

      // Left column (x: 50..280)
      span("Left column line one about sequence models.", 50, 670, 220, 10),
      span("Left column line two continues the thought.", 50, 656, 220, 10),
      span("Left column line three finishes paragraph.", 50, 642, 220, 10),
      span("Left column second paragraph starts here.", 50, 615, 210, 10),

      // Right column (x: 330..560)
      span("Right column line one introduces attention.", 330, 670, 220, 10),
      span("Right column line two explains scaling.", 330, 656, 220, 10),
      span("Right column line three shows results.", 330, 642, 220, 10),
      span("Right column second paragraph concludes.", 330, 615, 210, 10),
    ];

    const paras = extractPageParagraphs(items, 1, 612, 792);
    assert.equal(paras[0].text, "Attention Is All You Need");
    assert.match(paras[1].text, /^Left column line one/);
    assert.match(paras[2].text, /^Left column second paragraph/);
    assert.match(paras[3].text, /^Right column line one/);
    assert.match(paras[4].text, /^Right column second paragraph/);
  });

  it("never misclassifies word-fragmented single-column PDFs (e.g. medRxiv/LaTeX) as two-column", () => {
    // Each line is split into multiple short word/kerning spans across left & right halves of the page.
    const items: PdfTextItem[] = [
      // Title split into 4 fragments across x=110..500
      span("Seven replicated", 110, 720, 120, 15),
      span("genomic", 235, 720, 60, 15),
      span("associations of", 300, 720, 100, 15),
      span("myalgic", 405, 720, 65, 15),
      // Body lines split into left & right fragments with normal word spacing (~4pt)
      span("Myalgic Encephalomyelitis", 80, 660, 130, 10),
      span("is a debilitating", 214, 660, 80, 10),
      span("female-biased disease", 298, 660, 110, 10),
      span("with no biomarkers.", 412, 660, 105, 10),

      span("To investigate its", 80, 646, 100, 10),
      span("biological basis,", 184, 646, 95, 10),
      span("we used TarGene", 283, 646, 95, 10),
      span("in the UK Biobank.", 382, 646, 110, 10),

      span("Fine-mapping at one", 80, 632, 115, 10),
      span("replicated locus", 199, 632, 88, 10),
      span("resolved a credible", 291, 632, 100, 10),
      span("set with CLYBL.", 395, 632, 95, 10),

      span("Other replicated loci", 80, 618, 110, 10),
      span("contained BICD1,", 194, 618, 95, 10),
      span("GRIN2A, CSMD1", 293, 618, 95, 10),
      span("and RORA genes.", 392, 618, 100, 10),
    ];

    const paras = extractPageParagraphs(items, 1, 612, 792);
    assert.equal(paras.length, 2);
    assert.equal(paras[0].text, "Seven replicated genomic associations of myalgic");
    assert.match(paras[1].text, /^Myalgic Encephalomyelitis is a debilitating female-biased disease with no biomarkers\./);
    assert.match(paras[1].text, /and RORA genes\.$/);
  });

  it("filters rotated side watermarks and isolated micro-labels", () => {
    const items: PdfTextItem[] = [
      // 90-degree rotated arXiv/medRxiv side watermark
      { str: "arXiv:2609.12345v2 [cs.AI]", transform: [0, 12, -12, 0, 18, 400], width: 160, height: 12 },
      // Normal body paragraph (11pt)
      span("Main body text discussing experimental results clearly.", 60, 680, 420, 11),
      span("Second line of the same experimental discussion.", 60, 665, 400, 11),
      // Isolated tiny chart axis label (6pt < 11 * 0.65)
      span("Fig. 1a", 60, 500, 30, 6),
    ];

    const paras = extractPageParagraphs(items, 1, 612, 792);
    assert.equal(paras.length, 1);
    assert.match(paras[0].text, /^Main body text/);
  });

  it("returns empty array for scanned/image-only pages with no text items", () => {
    assert.deepEqual(extractPageParagraphs([], 1, 612, 792), []);
    assert.deepEqual(extractPageParagraphs([span("1", 300, 20, 8, 9)], 1, 612, 792), []);
  });
});
