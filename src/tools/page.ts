import { z } from "zod";
import { activateTarget, getActiveTargetId, getClient } from "../cdp.js";
import { getAccessibilityTree, type SnapshotFormat } from "../utils/accessibility.js";
import { sleep, withTimeout } from "../utils/waits.js";

export const getPageToolDef = {
  name: "get_page",
  description:
    "Get the current page content. The default is an accessibility tree with the page text and " +
    'numbered element refs you can pass to click/type; "interactive" leaves out the text lines for a ' +
    'compact view; "dom" reads the DOM directly (for pages whose accessibility tree is hidden by a ' +
    'modal); "html" returns the raw HTML. Long pages are cut at an output limit; continue with offset.',
  schema: {
    format: z
      .enum(["accessibility", "interactive", "dom", "html"])
      .optional()
      .describe("Output format (default: accessibility)"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Skip this many content lines; use the value a truncated snapshot suggests to continue"),
    expandMenus: z
      .boolean()
      .optional()
      .describe("List every link inside long navigation menus, which are shortened by default"),
  },
};

export const screenshotToolDef = {
  name: "screenshot",
  description:
    "Capture a screenshot of the current page as an image. Only use when visual layout matters; " +
    "prefer get_page for most tasks.",
  schema: {
    format: z.enum(["png", "jpeg"]).optional().describe("Image format (default: png)"),
    quality: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("JPEG quality 0-100 (default: 80); ignored for png"),
    fullPage: z
      .boolean()
      .optional()
      .describe("Capture the whole scrollable page instead of just the viewport (default: false)"),
  },
};

export const evaluateToolDef = {
  name: "evaluate",
  description:
    "Run JavaScript in the page and return the result as text (objects as JSON). Supports top-level " +
    "await, several statements, and the DevTools console helpers $ and $$. Stops after 30 s.",
  schema: {
    expression: z
      .string()
      .describe("JavaScript to evaluate; the value of the last expression is returned"),
  },
};

export async function handleGetPage(args: {
  format?: string;
  offset?: number;
  expandMenus?: boolean;
}): Promise<string> {
  if (args.format === "html") {
    const client = await getClient();
    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: "document.documentElement.outerHTML",
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(describeException(exceptionDetails));
    return String(result.value ?? "");
  }
  return getAccessibilityTree({
    format: (args.format as SnapshotFormat) || "accessibility",
    offset: args.offset,
    expandMenus: args.expandMenus,
  });
}

const MAX_DIMENSION = 7680; // the Claude API rejects images over 8000px on a side

export async function handleScreenshot(args: {
  format?: string;
  quality?: number;
  fullPage?: boolean;
}): Promise<{ data: string; mimeType: string }> {
  const client = await getClient();
  const format = args.format || "png";

  // Chrome does not paint tabs that are hidden, so a screenshot of a background
  // tab stalls or comes back stale. Bring the tab to the front first.
  const { result: visibility } = await client.Runtime.evaluate({
    expression: "document.visibilityState",
    returnByValue: true,
  });
  const targetId = getActiveTargetId();
  if (visibility?.value === "hidden" && targetId) {
    await activateTarget(targetId).catch(() => {});
    await sleep(150);
  }

  const params: Record<string, unknown> = {
    format,
    captureBeyondViewport: args.fullPage ?? false,
  };
  if (format === "jpeg") {
    params.quality = Math.round(Math.min(100, Math.max(0, args.quality ?? 80)));
  }

  if (args.fullPage) {
    // captureBeyondViewport on its own still returns just the viewport; the
    // whole page needs an explicit clip of the content size. Scale it down
    // when it would exceed what the API accepts.
    const metrics = await client.Page.getLayoutMetrics();
    const size = metrics.cssContentSize ?? metrics.contentSize;
    const width = Math.max(1, Math.ceil(size.width));
    const height = Math.max(1, Math.ceil(size.height));
    const scale = Math.min(1, MAX_DIMENSION / width, MAX_DIMENSION / height);
    params.clip = { x: 0, y: 0, width, height, scale };
  }

  const { data } = await client.Page.captureScreenshot(params);
  return {
    data,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}

const EVAL_TIMEOUT_MS = 30_000;

function describeException(details: any): string {
  return (
    details?.exception?.description ||
    details?.exception?.value ||
    details?.text ||
    "Evaluation failed"
  );
}

// Turn an in-page object into readable JSON: DOM nodes become their HTML (or a
// short <tag#id.class> inside collections), Maps and Sets become objects and
// arrays, cycles are cut, and very large output is truncated.
const SERIALIZE = `function() {
  const MAX = 200000;
  const describeNode = (n) => {
    if (n.nodeType !== 1) return n.nodeName;
    let s = n.tagName.toLowerCase();
    if (n.id) s += "#" + n.id;
    const cls = typeof n.className === "string" ? n.className.trim() : "";
    if (cls) s += "." + cls.split(/\\s+/).join(".");
    return "<" + s + ">";
  };
  if (typeof Node !== "undefined" && this instanceof Node) {
    const html = this.nodeType === 1 ? this.outerHTML : this.nodeName;
    return html.length > 2000 ? html.slice(0, 2000) + "…" : html;
  }
  const isCollection =
    (typeof NodeList !== "undefined" && this instanceof NodeList) ||
    (typeof HTMLCollection !== "undefined" && this instanceof HTMLCollection);
  const root = isCollection ? Array.from(this) : this;
  const seen = new WeakSet();
  const text = JSON.stringify(root, function (key, value) {
    if (typeof value === "bigint") return value.toString() + "n";
    if (typeof value === "function") return "[Function" + (value.name ? " " + value.name : "") + "]";
    if (typeof value === "symbol") return value.toString();
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Set) return Array.from(value);
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (typeof Node !== "undefined" && value instanceof Node) return describeNode(value);
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  }, 2);
  if (text === undefined) return String(root);
  return text.length > MAX ? text.slice(0, MAX) + "\\n… [output truncated]" : text;
}`;

/** Render a CDP RemoteObject as text for the agent. */
async function formatRemoteObject(client: any, result: any): Promise<string> {
  if (result.type === "undefined") return "undefined";
  if (result.unserializableValue) return String(result.unserializableValue);
  if (result.type !== "object" && result.type !== "function") {
    if (result.value !== undefined) {
      return typeof result.value === "string" ? result.value : JSON.stringify(result.value);
    }
    return result.description ?? String(result.value);
  }
  if (result.type === "function") return result.description ?? "function";
  if (result.subtype === "null") return "null";
  if (result.subtype === "error") return result.description ?? "Error";
  if (!result.objectId) return result.description ?? "[object]";
  try {
    const { result: serialized, exceptionDetails } = await client.Runtime.callFunctionOn({
      objectId: result.objectId,
      functionDeclaration: SERIALIZE,
      returnByValue: true,
    });
    if (!exceptionDetails && typeof serialized?.value === "string") return serialized.value;
  } catch {
    /* fall through to the description */
  }
  return result.description ?? "[object]";
}

export async function handleEvaluate(args: { expression: string }): Promise<string> {
  const client = await getClient();
  const objectGroup = "chrome-fast-evaluate";
  const timeoutMessage = `evaluate did not finish within ${EVAL_TIMEOUT_MS / 1000} s (a promise that never settles?)`;

  // Results come back by reference: REPL mode does not settle a promise that
  // the expression evaluates to, so it has to be awaited in a second step, and
  // objects are serialized in the page to get readable output for DOM nodes,
  // Maps and cyclic structures.
  const run = (expression: string, replMode: boolean): Promise<any> =>
    withTimeout<any>(
      client.Runtime.evaluate({
        expression,
        awaitPromise: true,
        returnByValue: false,
        // REPL mode is what the DevTools console uses: top-level await just
        // works and let/const can be declared again on the next call.
        replMode,
        includeCommandLineAPI: true,
        timeout: EVAL_TIMEOUT_MS,
        objectGroup,
      }),
      EVAL_TIMEOUT_MS + 1000,
      timeoutMessage
    );

  try {
    let { result, exceptionDetails } = await run(args.expression, true);

    // Scripts written for the previous version used `return` inside an implicit
    // async function; keep those working.
    if (exceptionDetails && /Illegal return statement/.test(describeException(exceptionDetails))) {
      ({ result, exceptionDetails } = await run(`(async () => { ${args.expression} })()`, false));
    }
    if (exceptionDetails) throw new Error(describeException(exceptionDetails));

    if (result.subtype === "promise" && result.objectId) {
      const awaited = await withTimeout<any>(
        client.Runtime.awaitPromise({ promiseObjectId: result.objectId, returnByValue: false }),
        EVAL_TIMEOUT_MS,
        timeoutMessage
      );
      if (awaited.exceptionDetails) throw new Error(describeException(awaited.exceptionDetails));
      result = awaited.result;
    }

    return await formatRemoteObject(client, result);
  } finally {
    client.Runtime.releaseObjectGroup({ objectGroup }).catch(() => {});
  }
}
