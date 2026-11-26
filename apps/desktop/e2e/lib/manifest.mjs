// Every end-to-end script, what it needs, and which changes it answers for (e2e/run.mjs).
// A new script gets a line here; a test (scripts/e2e-select.test.mjs) keeps the list and the folder equal.
//
// covers:     paths from the repository's root: what ends in "/" is a folder, the rest a file or its start.
// foreground: why it cannot run behind the person's work. Only run when asked for (--foreground, or by name).
// manual:     what it needs that a run cannot assume. Only run by name.

const renderer = "apps/desktop/src/renderer/src/";
const main = "apps/desktop/src/main/";
const client = "packages/client/src/";
const core = "crates/finx-core/src/";
const server = "crates/finx-server/src/";

export const scripts = {
  appearance: { covers: [`${renderer}appearance`, `${renderer}main.tsx`, `${renderer}styles/tokens.css`, `${renderer}settings/Settings`, `${main}preferences`, "apps/desktop/src/preload/index.ts"] },
  "bot-external": {
    covers: [
      `${renderer}bots/BotSheet`,
      `${renderer}bots/BotPage`,
      `${renderer}bots/BotList`,
      `${renderer}composer/Composer`,
      `${renderer}composer/attachments`,
      `${renderer}session/scope`,
      `${renderer}session/content`,
      `${server}bots`,
      `${server}server`,
      "crates/finx-a2a/src/",
      "tools/a2a-fake/server.mjs",
    ],
  },
  "bot-failure": { covers: [`${renderer}bots/Messages`, `${renderer}session/Failure`] },
  "bot-messages": { covers: [`${renderer}bots/Messages`, `${renderer}bots/BotPage`, `${renderer}bots/useBotSession`, `${renderer}bots/actions`, `${client}botChat`] },
  "bot-mode": { manual: "a real model: DEEPSEEK_API_KEY", covers: [] },
  "bot-panels": { covers: [`${renderer}bots/BotPanel`, `${renderer}bots/BotList`, `${renderer}bots/BotPage`, `${renderer}bots/Avatar`, `${renderer}bots/actions`, `${client}bots`, `${server}bots`, `${core}bot.rs`] },
  "bot-permission": { covers: [`${renderer}bots/BotPanel`, `${core}bot.rs`, `${server}bots`] },
  "bot-routines": { covers: [`${renderer}bots/RoutinesPanel`, `${renderer}bots/Process`, `${main}routines`, `${client}routines`, `${core}routine.rs`, `${server}routines`, `${server}schedule`] },
  "bot-setup": { covers: [`${renderer}bots/BotSheet`, `${renderer}bots/ModelRows`, `${client}bots`, `${server}bots`] },
  "bot-turn": { covers: [`${renderer}bots/useBotSession`, `${core}bot.rs`, `${core}agents/`] },
  "browser-annotations": { foreground: "a click inside the browser panel brings the app forward", covers: [`${renderer}session/Browser`, "apps/desktop/src/preload/browser", "apps/desktop/src/shared/annotations"] },
  "browser-handoff": { covers: [`${renderer}session/browserPanel`, `${main}browser/`, "crates/finx-browser/", `${core}browser`] },
  "browser-pdf-translate": {
    covers: [
      `${renderer}session/BrowserPdfView`,
      `${renderer}docs/PdfTranslationPane`,
      `${renderer}docs/pdfBlocks`,
      `${renderer}docs/PdfView`,
      `${main}browser/translate`,
      "apps/desktop/src/shared/translation",
      `${server}models`,
    ],
  },
  "browser-script": { covers: [`${renderer}session/Approval`, `${core}site_policy`, "crates/finx-browser/"] },
  "browser-quiet": { foreground: "checks which window really has the keyboard", covers: [`${main}browser/pages`, "crates/finx-browser/"] },
  "browser-quit": { covers: [`${main}browser/pages`, `${main}index`, `${main}windows`] },
  "browser-translate": {
    covers: [
      `${renderer}session/Browser`,
      `${main}browser/translate`,
      `${main}browser/pages`,
      "apps/desktop/src/preload/browser-translate",
      "apps/desktop/src/shared/translation",
      `${server}models`,
    ],
  },
  chatgpt: { covers: [`${renderer}settings/ChatGptConnection`, "crates/finx-connections/", `${server}connections`] },
  "computer-use": { covers: [`${renderer}settings/DesktopSettings`, `${renderer}desktopControl`, "crates/finx-desktop/", `${core}desktop.rs`, `${main}desktop`] },
  "connector-login": { covers: [`${core}connectors/`, "crates/finx-connections/"] },
  "content-actions": { covers: [`${renderer}session/content`, `${renderer}session/Code`, `${renderer}session/Chat`, `${renderer}session/Markdown`, `${renderer}session/markdown/`, `${main}files`, `${main}ipc`, `${core}prompts/`] },
  conversation: { covers: [`${renderer}session/Chat`, `${renderer}session/Steps`, `${renderer}session/useSession`, `${renderer}session/SessionPage`, `${renderer}session/useVirtualRows`, `${renderer}session/virtual`, `${renderer}session/useRowState`, `${client}steps`, `${client}history`] },
  customize: { covers: [`${renderer}customize/`, `${server}customize`, `${core}mcp/`, `${core}skills/`, "crates/finx-mcp/"] },
  "deck-edit": { covers: [`${renderer}session/DeckEditActions`, `${renderer}docs/pptx/deckEdit`, `${core}deck`, "crates/finx-docs/src/deck/", `${server}decks`] },
  "desktop-approval": { covers: [`${renderer}session/Approval`, `${renderer}settings/DesktopSettings`, "crates/finx-desktop/", `${core}desktop.rs`] },
  "desktop-opaque": { foreground: "moves the pointer and types into another app", covers: ["crates/finx-desktop/", "apps/desktop/e2e/fixtures/"] },
  dingtalk: { covers: [`${renderer}customize/`, `${core}connectors/`, `${server}customize`] },
  "doc-links": { covers: [`${renderer}files/`, `${renderer}docs/`, `${main}docs`, `${main}doc-tokens`] },
  document: { covers: [`${renderer}docs/`, `${main}docs`, `${main}doc-tokens`, "crates/finx-docs/", `${core}docs.rs`, `${server}docs`] },
  "first-run": { covers: [`${renderer}onboarding/`] },
  "file-panel": { covers: [`${renderer}files/`, `${main}files`, `${client}files`, `${core}files.rs`, `${server}files`] },
  "home-browser": { covers: [`${renderer}session/NewTabPage`, `${renderer}settings/BuiltInBrowser`, `${main}browser/pages`, `${main}browser/menu`] },
  markdown: { covers: [`${renderer}session/Markdown`, `${renderer}session/markdown/`, `${renderer}session/content`] },
  "message-quote": { covers: [`${renderer}session/Chat`, `${renderer}session/SelectionBar`, `${renderer}pageMenu`, `${renderer}session/Markdown`, `${renderer}session/contentMenus`, `${renderer}session/quote`, `${renderer}session/Dock`, `${renderer}composer/`, `${client}steps`, `${client}session`] },
  "model-names": { covers: ["apps/desktop/src/shared/model-names", `${renderer}store`, "crates/finx-connections/src/qwenwork", `${core}models.rs`] },
  "model-channels": { covers: [`${renderer}settings/ModelConnections`, `${renderer}settings/ProviderConnections`, `${renderer}settings/ManageModels`, `${renderer}settings/LocalApplicationConnection`, `${renderer}composer/`, `${client}models`, `${core}models.rs`, `${server}models`, "crates/finx-llm/"] },
  notifications: { covers: [`${main}notify`, `${main}notifier`, `${client}alerts`] },
  "paste-drop": { foreground: "uses the system clipboard", covers: [`${renderer}composer/`, `${main}clipboard`] },
  "pptx-editor": { foreground: "opens a window of its own, which the background mode does not reach", covers: [`${renderer}docs/pptx/`] },
  "pptx-panel": { covers: [`${renderer}docs/pptx/`] },
  resend: { covers: [`${renderer}composer/`, `${renderer}session/Dock`, `${renderer}session/Queue`, `${core}history.rs`] },
  "send-modes": { covers: [`${renderer}composer/`, `${renderer}session/Dock`, `${renderer}session/Queue`, `${core}kernel.rs`, `${core}task.rs`] },
  "session-browser": { covers: [`${renderer}session/Browser`, `${renderer}session/browserPanel`, `${renderer}session/SidePanels`, `${main}browser/pages`] },
  stress: { covers: [`${renderer}sidebar/`, `${renderer}bots/BotList`, `${renderer}bots/Avatar`, `${renderer}store`, `${renderer}MainWindow`, `${renderer}commands`, `${renderer}search/`, `${client}sessions`, `${client}bots`, `${client}mock/stress`] },
  "stale-model": { covers: [`${renderer}settings/ModelConnections`, `${renderer}settings/ManageModels`, `${core}models.rs`, `${server}models`, `${server}connections`] },
  "subagent-approval": { covers: [`${renderer}session/Approval`, `${renderer}session/Agents`, `${core}agents/`, `${core}approval.rs`] },
  "system-browser": { foreground: "drives a real Chrome window", covers: [`${renderer}settings/BrowserSettings`, `${main}browser/system`, `${main}browser/host`, `${main}browser/extension`] },
  "word-ai": { covers: [`${renderer}docs/docx/`, `${renderer}session/DocxEditActions`, `${main}docx/`, `${core}word.rs`, `${core}approval.rs`, "crates/finx-word/", "crates/finx-docs/src/word.rs", `${server}words`, `${server}docx_host`] },
  "word-drag": { covers: [`${renderer}docs/docx/`] },
  "word-pages": { manual: "screenshots of a supplied DOCX for a person to judge", covers: [] },
  "word-look": { manual: "screenshots for a person to judge, not a check", covers: [] },
  "word-drag": { covers: [`${renderer}docs/docx/`, `${renderer}files/`] },
  "word-pages": { manual: "screenshots every page of a .docx for comparing with Word, not a check", covers: [] },
  "word-editor": { covers: [`${renderer}docs/docx/`, `${renderer}files/`, `${main}docx/`, "crates/finx-word/", "crates/finx-docs/src/word.rs", `${server}words`, `${server}docx_host`] },
  "word-pdf": { covers: [`${renderer}docs/docx/`, "crates/finx-word/src/render.rs", "crates/finx-docs/src/word.rs", `${server}words`, "crates/finx-core/src/word.rs"] },
  "toolbar-probe": { manual: "a temporary diagnostic, not a check", covers: [] },
  "web-search": { covers: [`${renderer}settings/SearchSettings`, `${renderer}session/SearchResults`, `${core}web_search/`, `${server}web_search`] },
  "your-browser": { foreground: "drives a real Chrome window", covers: [`${renderer}session/Yours`, `${main}browser/system`, `${main}browser/host`, `${server}browser_host`, `${server}browser_status`] },
};

// A change nothing above answers for may touch anything: the app, a kernel and a conversation, at least.
export const smoke = ["conversation", "send-modes", "stale-model"];

// What no running app can show. Nothing to verify:
export const nothing = [/^docs\//, /\.md$/, /^assets\//, /^site\//, /^examples\//, /^crates\/finx-(bench|eval)\//];
// Unit tests and the type check are the check, plus a look when it is what people see:
export const unitOnly = [/\.test\.[cm]?[jt]sx?$/, /\.css$/, /^apps\/desktop\/src\/locales\//, /^packages\/client\/src\/mock\//, /^apps\/desktop\/e2e\/(run\.mjs|lib\/)/, /^apps\/desktop\/scripts\//, /\.github\//];
// Changes that show on screen without a behaviour to run: reminded of, not run.
export const toLookAt = [/\.css$/, /^apps\/desktop\/src\/locales\//];
