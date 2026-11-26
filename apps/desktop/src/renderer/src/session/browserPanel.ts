// The browser panel comes out by itself with a conversation's first page. Once the person puts
// it away in a conversation it stays away there, whatever the agent does and however often they
// come back, until they bring it out again (browser-design §8.3.4).

const putAway = new Set<string>();

export const browserPutAway = (session: string) => putAway.has(session);
export const putBrowserAway = (session: string) => void putAway.add(session);
export const bringBrowserBack = (session: string) => void putAway.delete(session);

export type SidePanelLayout = {
  files: boolean;
  browser: boolean;
  filesMax: boolean;
  browserMax: boolean;
  max: boolean;
  dual: boolean;
};

/**
 * Which side panels are open beside a conversation. The file panel and the browser can stay open
 * side by side (e.g. clicking a link in a Markdown file opens the page without closing the file);
 * maximizing one temporarily yields the whole window to it without closing the other.
 */
export function sidePanelLayout(input: {
  files: boolean;
  filesMax: boolean;
  browser: boolean;
  browserMax: boolean;
  hasView: boolean;
  hasTabs: boolean;
  held: boolean;
}): SidePanelLayout {
  const files = input.files && !input.held && input.hasView;
  const browser = input.browser && input.hasTabs && !input.held;
  const filesMax = files && input.filesMax;
  const browserMax = browser && input.browserMax && !filesMax;
  const max = filesMax || browserMax;
  const dual = files && browser && !max;
  return { files, browser, filesMax, browserMax, max, dual };
}
