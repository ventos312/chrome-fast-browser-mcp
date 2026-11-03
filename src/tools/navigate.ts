import { z } from "zod";
import { addNote, getClient, getUnloadCancelCount, setForceUnload } from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";
import { sleep, waitForNavigation, type WaitUntil } from "../utils/waits.js";

export const navigateToolDef = {
  name: "navigate",
  description:
    "Navigate the current tab to a URL and return the page content as an accessibility tree " +
    "with numbered element refs you can pass to click/type. If the current page has unsaved " +
    "changes that it asks to confirm, the navigation is cancelled and reported unless force is set.",
  schema: {
    url: z
      .string()
      .describe("URL to open. A bare host such as example.com is treated as https://example.com."),
    waitUntil: z
      .enum(["load", "domcontentloaded", "networkidle"])
      .optional()
      .describe(
        "When navigation counts as done (default: load). networkidle also waits until the network has been quiet for 500 ms."
      ),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Maximum time to wait for the page, in ms (default: 30000). On timeout the content so far is returned with a note."
      ),
    force: z
      .boolean()
      .optional()
      .describe(
        "Leave the current page even if it has unsaved changes that it asks to confirm (default: false)"
      ),
  },
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** Add a scheme when a bare host is passed; leave every URL that already has one alone. */
export function normalizeUrl(input: string): string {
  const url = input.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
  const looksLikeHostPort = /^[\w.-]+:\d+([/?#]|$)/.test(url);
  if (hasScheme && !looksLikeHostPort) return url;
  const host = url.split(/[/?#]/)[0].split(":")[0];
  const local = host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return `${local ? "http" : "https"}://${url}`;
}

export async function handleNavigate(args: {
  url: string;
  waitUntil?: string;
  timeout?: number;
  force?: boolean;
}): Promise<string> {
  const client = await getClient();
  const url = normalizeUrl(args.url);
  const until = (args.waitUntil ?? "load") as WaitUntil;
  const timeoutMs = args.timeout ?? DEFAULT_TIMEOUT_MS;
  const cancelledBefore = getUnloadCancelCount();

  // The beforeunload prompt can open after Page.navigate has returned, so the
  // force setting has to stay in place until the wait is over.
  setForceUnload(!!args.force);
  try {
    const { errorText, frameId, loaderId } = await client.Page.navigate({ url });
    const cancelled = () => getUnloadCancelCount() > cancelledBefore;

    if (errorText && errorText !== "net::ERR_HTTP_RESPONSE_CODE_FAILURE" && !cancelled()) {
      throw new Error(`Navigation to ${url} failed: ${errorText}`);
    }
    if (errorText === "net::ERR_HTTP_RESPONSE_CODE_FAILURE") {
      addNote(`The server answered ${url} with an HTTP error status.`);
    }
    // The page refused to be left; its note is already queued.
    if (cancelled()) return getAccessibilityTree();

    // Without a loaderId the navigation was same-document (only the hash
    // changed); it has already happened and fires no load event.
    if (loaderId) {
      const outcome = await waitForNavigation(client, { frameId, loaderId, until, timeoutMs });
      if (outcome === "timeout") {
        addNote(
          `The page had not reached "${until}" after ${timeoutMs} ms; the content below may be incomplete.`
        );
      }
      if (outcome === "cancelled") return getAccessibilityTree();
    }
  } finally {
    setForceUnload(false);
  }

  // Give scripts a moment to render dynamic content.
  await sleep(200);

  return getAccessibilityTree();
}
