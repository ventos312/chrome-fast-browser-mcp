import { z } from "zod";
import {
  listTargets,
  newTarget,
  connectToTarget,
  closeTab,
  getActiveTargetId,
  getClient,
} from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";
import { handleNavigate } from "./navigate.js";

export const tabsToolDef = {
  name: "tabs",
  description:
    "List all open browser tabs with their target IDs, titles and URLs. The tab chrome-fast is " +
    "attached to is marked (active).",
  schema: {},
};

export const tabNewToolDef = {
  name: "tab_new",
  description: "Open a new tab, attach to it and optionally navigate it to a URL. Returns the page content.",
  schema: {
    url: z.string().optional().describe("URL to open (default: a blank tab)"),
  },
};

export const tabSwitchToolDef = {
  name: "tab_switch",
  description:
    "Attach to another tab by its target ID (from the tabs tool) and bring it to the front. " +
    "Returns its page content.",
  schema: {
    targetId: z.string().describe("Target ID of the tab to switch to"),
  },
};

export const tabCloseToolDef = {
  name: "tab_close",
  description:
    "Close a tab by its target ID, or the current tab if omitted. When the current tab is closed, " +
    "attaches to another open tab.",
  schema: {
    targetId: z.string().optional().describe("Target ID of the tab to close (default: current tab)"),
    force: z
      .boolean()
      .optional()
      .describe(
        "Close the tab even if it has unsaved changes that it asks to confirm (default: false, which keeps it open and reports that)"
      ),
  },
};

const pageTargets = (targets: any[]) => targets.filter((t) => t.type === "page");

export async function handleTabs(): Promise<string> {
  // Attach to a tab first so the listing can say which one tools act on.
  await getClient();
  const pages = pageTargets(await listTargets());
  const activeId = getActiveTargetId();

  if (pages.length === 0) return "No tabs open.";

  const lines = pages.map((t) => {
    const active = t.id === activeId ? " (active)" : "";
    return `[${t.id}]${active} ${t.title || "(untitled)"}\n  ${t.url}`;
  });

  return lines.join("\n\n");
}

export async function handleTabNew(args: { url?: string }): Promise<string> {
  // Create the tab blank and navigate it ourselves, so the load is tracked
  // properly instead of racing a page that may already have finished loading.
  const target = await newTarget("about:blank");
  await connectToTarget(target.id);
  if (args.url) return handleNavigate({ url: args.url });
  return getAccessibilityTree();
}

export async function handleTabSwitch(args: { targetId: string }): Promise<string> {
  await connectToTarget(args.targetId);
  return getAccessibilityTree();
}

export async function handleTabClose(args: { targetId?: string; force?: boolean }): Promise<string> {
  const current = getActiveTargetId();
  const targetId = args.targetId || current;
  if (!targetId) {
    throw new Error("No tab is attached, so there is no current tab to close. Pass a targetId from the tabs tool.");
  }

  const pages = pageTargets(await listTargets());
  if (!pages.some((t) => t.id === targetId)) {
    throw new Error(`No tab with target ID "${targetId}". Use the tabs tool to list open tabs.`);
  }

  const closedCurrent = targetId === current;
  const remaining = pages.filter((t) => t.id !== targetId);

  if ((await closeTab(targetId, !!args.force)) === "kept") return notClosed(closedCurrent);

  // Closing a tab that is not the current one must not change which tab the
  // other tools act on.
  if (!closedCurrent) return "Tab closed. Still attached to the current tab.";
  if (remaining.length === 0) {
    return "Tab closed. No tabs remain open; Chrome may have exited. The next tool call reconnects or relaunches it.";
  }

  const now = pageTargets(await listTargets());
  const next = now.find((t) => t.id !== targetId) ?? remaining[0];
  await connectToTarget(next.id);
  return `Tab closed. Switched to: ${next.title || next.url}\n\n` + (await getAccessibilityTree());
}

function notClosed(wasCurrent: boolean): string {
  return (
    "The tab was not closed: it has unsaved changes and asked to confirm. Save them first, or " +
    (wasCurrent
      ? "repeat with force: true to close it anyway."
      : "switch to it with tab_switch and close it with force: true.")
  );
}
