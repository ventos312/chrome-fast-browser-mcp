import { getClient, takeNotes } from "../cdp.js";
import { sleep } from "./waits.js";

interface AXValue {
  type?: string;
  value?: any;
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

/**
 * "accessibility": interactive elements, landmarks, headings and the page text.
 * "interactive": the same without the text lines, for a compact view.
 */
export type SnapshotFormat = "accessibility" | "interactive";

/** Content lines per snapshot before the rest is omitted, so a huge page cannot flood the context window. */
const MAX_LINES = Math.max(50, parseInt(process.env.CHROME_FAST_MAX_LINES || "", 10) || 2000);
const MAX_TEXT = 1000;
const MAX_VALUE = 200;

// Map ref numbers to backend DOM node IDs for click/type targeting
const refMap = new Map<number, number>();

export function getRefMap(): Map<number, number> {
  return refMap;
}

// Containers that add structure but carry no information of their own
const skipRoles = new Set([
  "none",
  "generic",
  "InlineTextBox",
  "LineBreak",
  "paragraph",
  "group",
  "list",
  "listitem",
  "Section",
  "LabelText",
  "Legend",
]);

// Roles that are always interactive / worth numbering
const interactiveRoles = new Set([
  "link",
  "button",
  "textbox",
  "combobox",
  "searchbox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "treeitem",
]);

const collapse = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + "…" : s);

/**
 * A text node whose text is already part of a named ancestor (a link's label,
 * a heading, a button) would be printed twice; detect that case.
 */
function coveredByAncestor(node: AXNode, text: string, byId: Map<string, AXNode>): boolean {
  let parentId = node.parentId;
  for (let depth = 0; parentId && depth < 8; depth++) {
    const parent = byId.get(parentId);
    if (!parent) return false;
    const role = parent.role?.value;
    if (role === "RootWebArea" || role === "WebArea") return false;
    const name = collapse(parent.name?.value);
    if (name) return name.includes(text);
    parentId = parent.parentId;
  }
  return false;
}

/** Chrome reports checked/pressed as the strings "true"/"false"/"mixed", so a plain truthiness test would mark everything checked. */
function describeStates(node: AXNode): string {
  const states: string[] = [];
  for (const prop of node.properties ?? []) {
    const val = prop.value?.value;
    switch (prop.name) {
      case "focused":
        if (val === true) states.push("focused");
        break;
      case "checked":
      case "pressed":
        if (val === true || val === "true") states.push(prop.name);
        else if (val === "mixed") states.push("mixed");
        break;
      case "disabled":
      case "selected":
      case "required":
      case "readonly":
        if (val === true) states.push(prop.name);
        break;
      case "expanded":
        if (val === true) states.push("expanded");
        else if (val === false) states.push("collapsed");
        break;
      case "invalid":
        if (val && val !== "false") states.push("invalid");
        break;
      case "level":
        if (typeof val === "number") states.push(`level=${val}`);
        break;
      case "autocomplete":
        if (val && val !== "none") states.push("autocomplete");
        break;
    }
  }
  return states.length > 0 ? " " + states.join(" ") : "";
}

/** Current value of form controls (text typed so far, selected option, slider position). */
function describeValue(node: AXNode): string {
  const raw = node.value?.value;
  if (raw === undefined || raw === null || raw === "") return "";
  const text = collapse(raw);
  if (!text || text === collapse(node.name?.value)) return "";
  return ` value="${clip(text, MAX_VALUE)}"`;
}

export async function getAccessibilityTree(format: SnapshotFormat = "accessibility"): Promise<string> {
  const client = await getClient();

  let nodes: AXNode[] = [];
  let meta: { title?: string; url?: string } = {};
  // Right after a navigation the document may be mid-swap; retry briefly
  // instead of failing the whole tool call.
  for (let attempt = 0; ; attempt++) {
    try {
      const [ax, info] = await Promise.all([
        client.Accessibility.getFullAXTree(),
        client.Runtime.evaluate({
          expression: "({ title: document.title, url: location.href })",
          returnByValue: true,
        }),
      ]);
      nodes = ax.nodes;
      meta = info.result?.value ?? {};
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await sleep(150);
    }
  }

  const byId = new Map<string, AXNode>(nodes.map((n) => [n.nodeId, n]));
  refMap.clear();
  let refCounter = 0;
  const lines: string[] = [];

  for (const note of takeNotes()) lines.push(`Note: ${note}`);
  if (lines.length) lines.push("");

  lines.push(`Page: ${meta.title || "(untitled)"}`);
  lines.push(`URL: ${meta.url || ""}`);
  lines.push("");

  const headerLines = lines.length;
  let omitted = 0;
  const emit = (line: string) => {
    if (lines.length - headerLines < MAX_LINES) lines.push(line);
    else omitted++;
  };

  for (const node of nodes) {
    if (node.ignored) continue;
    const role = node.role?.value;
    if (!role) continue;
    if (role === "WebArea" || role === "RootWebArea") continue;

    if (role === "StaticText") {
      if (format === "interactive") continue;
      const text = collapse(node.name?.value);
      if (!text || coveredByAncestor(node, text, byId)) continue;
      emit(`text "${clip(text, MAX_TEXT)}"`);
      continue;
    }

    if (skipRoles.has(role)) continue;

    const name = collapse(node.name?.value);
    const isInteractive = interactiveRoles.has(role);

    // Skip non-interactive nodes with no name
    if (!isInteractive && !name) continue;

    const label =
      `${role}${name ? ` "${clip(name, MAX_TEXT)}"` : ""}` + describeValue(node) + describeStates(node);

    if (node.backendDOMNodeId) {
      refCounter++;
      refMap.set(refCounter, node.backendDOMNodeId);
      emit(`[${refCounter}] ${label}`);
    } else {
      emit(label);
    }
  }

  if (refCounter === 0) {
    lines.push("(no interactive elements found)");
  }
  if (omitted > 0) {
    lines.push(
      `… ${omitted} more lines omitted (limit CHROME_FAST_MAX_LINES=${MAX_LINES}). ` +
        `Use evaluate, or get_page with format "html", to read a specific part of the page.`
    );
  }

  return lines.join("\n");
}
