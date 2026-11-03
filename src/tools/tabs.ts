import {
  listTargets,
  newTarget,
  connectToTarget,
  closeTarget,
  getActiveTargetId,
} from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";

export const tabsToolDef = {
  name: "tabs",
  description: "List all open browser tabs with their IDs, titles, and URLs.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export const tabNewToolDef = {
  name: "tab_new",
  description: "Open a new browser tab. Returns the page content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "URL to open (default: about:blank)",
      },
    },
  },
};

export const tabSwitchToolDef = {
  name: "tab_switch",
  description:
    "Switch to a different tab by its target ID (from the tabs tool). Returns page content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      targetId: {
        type: "string",
        description: "Target ID of the tab to switch to",
      },
    },
    required: ["targetId"],
  },
};

export const tabCloseToolDef = {
  name: "tab_close",
  description: "Close a tab by its target ID. If omitted, closes the current tab.",
  inputSchema: {
    type: "object" as const,
    properties: {
      targetId: {
        type: "string",
        description: "Target ID of the tab to close (default: current tab)",
      },
    },
  },
};

export async function handleTabs(): Promise<string> {
  const targets = await listTargets();
  const activeId = getActiveTargetId();
  const pages = targets.filter((t: any) => t.type === "page");

  if (pages.length === 0) return "No tabs open.";

  const lines = pages.map((t: any) => {
    const active = t.id === activeId ? " (active)" : "";
    return `[${t.id}]${active} ${t.title || "(untitled)"}\n  ${t.url}`;
  });

  return lines.join("\n\n");
}

export async function handleTabNew(args: { url?: string }): Promise<string> {
  const url = args.url || "about:blank";
  const target = await newTarget(url);
  await connectToTarget(target.id);

  // Wait for page load
  if (url !== "about:blank") {
    const client = await import("../cdp.js").then((m) => m.getClient());
    await client.Page.loadEventFired();
    await new Promise((r) => setTimeout(r, 200));
  }

  return getAccessibilityTree();
}

export async function handleTabSwitch(args: {
  targetId: string;
}): Promise<string> {
  await connectToTarget(args.targetId);
  await new Promise((r) => setTimeout(r, 200));
  return getAccessibilityTree();
}

export async function handleTabClose(args: {
  targetId?: string;
}): Promise<string> {
  const targetId = args.targetId || getActiveTargetId();
  if (!targetId) throw new Error("No active tab to close");

  await closeTarget(targetId);

  // Switch to another tab if available
  const targets = await listTargets();
  const pages = targets.filter((t: any) => t.type === "page");
  if (pages.length > 0) {
    await connectToTarget(pages[0].id);
    return `Tab closed. Switched to: ${pages[0].title || pages[0].url}\n\n` +
      await getAccessibilityTree();
  }
  return "Tab closed. No remaining tabs.";
}
