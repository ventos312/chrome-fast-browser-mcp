import { getClient } from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";

export const navigateToolDef = {
  name: "navigate",
  description:
    "Navigate to a URL and return the page content as an accessibility tree. " +
    "Returns numbered element refs you can pass to click/type.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "URL to navigate to",
      },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle"],
        description: "When to consider navigation done (default: load)",
      },
    },
    required: ["url"],
  },
};

export async function handleNavigate(args: {
  url: string;
  waitUntil?: string;
}): Promise<string> {
  const client = await getClient();

  // Navigate
  await client.Page.navigate({ url: args.url });

  // Wait for load
  if (args.waitUntil === "networkidle") {
    // Wait for network idle: no requests for 500ms
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const reset = () => {
        clearTimeout(timer);
        timer = setTimeout(resolve, 500);
      };
      client.Network.enable();
      client.on("Network.requestWillBeSent", reset);
      client.on("Network.loadingFinished", reset);
      client.on("Network.loadingFailed", reset);
      timer = setTimeout(resolve, 500);
      // Fallback timeout
      setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, 10000);
    });
  } else {
    await client.Page.loadEventFired();
  }

  // Small delay for dynamic content
  await new Promise((r) => setTimeout(r, 200));

  return getAccessibilityTree();
}
