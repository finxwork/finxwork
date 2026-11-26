import assert from "node:assert/strict";
import { test } from "node:test";
import { sidePanelLayout } from "./browserPanel.ts";

test("file panel and browser stay open side by side when both are active", () => {
  assert.deepEqual(
    sidePanelLayout({ files: true, filesMax: false, browser: true, browserMax: false, hasView: true, hasTabs: true, held: false }),
    { files: true, browser: true, filesMax: false, browserMax: false, max: false, dual: true },
  );
});

test("browser stays hidden when it has no tabs, leaving file panel alone", () => {
  assert.deepEqual(
    sidePanelLayout({ files: true, filesMax: false, browser: true, browserMax: false, hasView: true, hasTabs: false, held: false }),
    { files: true, browser: false, filesMax: false, browserMax: false, max: false, dual: false },
  );
});

test("maximizing one panel leaves dual mode without closing the other", () => {
  assert.deepEqual(
    sidePanelLayout({ files: true, filesMax: true, browser: true, browserMax: false, hasView: true, hasTabs: true, held: false }),
    { files: true, browser: true, filesMax: true, browserMax: false, max: true, dual: false },
  );
  assert.deepEqual(
    sidePanelLayout({ files: true, filesMax: false, browser: true, browserMax: true, hasView: true, hasTabs: true, held: false }),
    { files: true, browser: true, filesMax: false, browserMax: true, max: true, dual: false },
  );
  // If both flags are somehow set, filesMax wins cleanly so only one panel maximizes.
  assert.deepEqual(
    sidePanelLayout({ files: true, filesMax: true, browser: true, browserMax: true, hasView: true, hasTabs: true, held: false }),
    { files: true, browser: true, filesMax: true, browserMax: false, max: true, dual: false },
  );
});

test("held hides both side panels", () => {
  assert.deepEqual(
    sidePanelLayout({ files: true, filesMax: false, browser: true, browserMax: false, hasView: true, hasTabs: true, held: true }),
    { files: false, browser: false, filesMax: false, browserMax: false, max: false, dual: false },
  );
});
