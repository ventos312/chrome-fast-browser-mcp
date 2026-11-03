import { z } from "zod";
import { addNote, getClient } from "../cdp.js";
import { getPageUpdate } from "../utils/accessibility.js";
import { sleep, waitForNetworkIdle } from "../utils/waits.js";

export const waitToolDef = {
  name: "wait",
  description:
    "Wait for a condition, then return the updated page content: an element matching a CSS " +
    "selector, a piece of text appearing on the page, the network going quiet, or a fixed time.",
  schema: {
    selector: z
      .string()
      .optional()
      .describe("CSS selector; resolves once a matching element exists"),
    text: z
      .string()
      .optional()
      .describe("Text; resolves once it appears in the page's visible text"),
    networkIdle: z
      .boolean()
      .optional()
      .describe("Resolve once there has been no network activity for 500 ms"),
    time: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Fixed wait in ms (use instead of a condition)"),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum wait for selector/text/networkIdle in ms (default: 5000)"),
  },
};

const MAX_FIXED_WAIT_MS = 120_000;

export async function handleWait(args: {
  selector?: string;
  text?: string;
  networkIdle?: boolean;
  time?: number;
  timeout?: number;
}): Promise<string> {
  const client = await getClient();
  const timeout = args.timeout ?? 5000;

  if (args.time) {
    await sleep(Math.min(args.time, MAX_FIXED_WAIT_MS));
  }

  if (args.networkIdle) {
    const idle = await waitForNetworkIdle(client, 500, timeout);
    if (!idle) {
      addNote(`The network did not go idle within ${timeout} ms; the page may still be loading data.`);
    }
  }

  if (args.selector || args.text) {
    const expression = `(() => {
      const selector = ${JSON.stringify(args.selector ?? "")};
      const text = ${JSON.stringify(args.text ?? "")};
      const selectorOk = !selector || !!document.querySelector(selector);
      const textOk = !text || (!!document.body && document.body.innerText.includes(text));
      return selectorOk && textOk;
    })()`;
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        const { result, exceptionDetails } = await client.Runtime.evaluate({
          expression,
          returnByValue: true,
        });
        if (exceptionDetails) {
          // An invalid selector will never match; say so now instead of after the timeout.
          throw new Error(
            `Invalid wait condition: ${exceptionDetails.exception?.description || exceptionDetails.text}`
          );
        }
        if (result.value) break;
      } catch (err: any) {
        if (/Invalid wait condition/.test(err.message)) throw err;
        // The page is navigating and its JavaScript context went away; keep polling.
      }
      if (Date.now() >= deadline) {
        const what = [
          args.selector && `selector "${args.selector}"`,
          args.text && `text "${args.text}"`,
        ]
          .filter(Boolean)
          .join(" and ");
        throw new Error(`Timeout: ${what} not found within ${timeout} ms`);
      }
      await sleep(100);
    }
  }

  return getPageUpdate();
}
