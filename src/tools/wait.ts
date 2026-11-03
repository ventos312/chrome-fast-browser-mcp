import { getClient } from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";

export const waitToolDef = {
  name: "wait",
  description:
    "Wait for a condition: CSS selector to appear, network idle, or fixed time. " +
    "Returns updated page content when done.",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: "CSS selector to wait for",
      },
      timeout: {
        type: "number",
        description: "Max wait time in ms (default: 5000)",
      },
      time: {
        type: "number",
        description: "Fixed wait time in ms (use instead of selector)",
      },
      networkIdle: {
        type: "boolean",
        description: "Wait for no network requests for 500ms",
      },
    },
  },
};

export async function handleWait(args: {
  selector?: string;
  timeout?: number;
  time?: number;
  networkIdle?: boolean;
}): Promise<string> {
  const client = await getClient();
  const timeout = args.timeout ?? 5000;

  if (args.time) {
    await new Promise((r) => setTimeout(r, args.time));
    return getAccessibilityTree();
  }

  if (args.networkIdle) {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(resolve, 500);
      };
      client.on("Network.requestWillBeSent", reset);
      client.on("Network.loadingFinished", reset);
      client.on("Network.loadingFailed", reset);
      timer = setTimeout(resolve, 500);
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, timeout);
    });
    return getAccessibilityTree();
  }

  if (args.selector) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
      const { result } = await client.Runtime.evaluate({
        expression: `!!document.querySelector(${JSON.stringify(args.selector)})`,
      });
      if (result.value) {
        return getAccessibilityTree();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Timeout: selector "${args.selector}" not found within ${timeout}ms`
    );
  }

  // Default: just return current state
  return getAccessibilityTree();
}
