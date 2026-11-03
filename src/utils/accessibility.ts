import { getClient } from "../cdp.js";

interface AXNode {
  nodeId: string;
  role: { value: string };
  name?: { value: string };
  properties?: Array<{ name: string; value: { value: any } }>;
  children?: AXNode[];
  backendDOMNodeId?: number;
}

// Map ref numbers to backend DOM node IDs for click/type targeting
const refMap = new Map<number, number>();

export function getRefMap(): Map<number, number> {
  return refMap;
}

export async function getAccessibilityTree(): Promise<string> {
  const client = await getClient();
  const { nodes } = await client.Accessibility.getFullAXTree();

  refMap.clear();
  let refCounter = 0;
  const lines: string[] = [];

  // Get page title and URL
  const { result: titleResult } = await client.Runtime.evaluate({
    expression: "document.title",
  });
  const { result: urlResult } = await client.Runtime.evaluate({
    expression: "window.location.href",
  });
  lines.push(`Page: ${titleResult.value || "(untitled)"}`);
  lines.push(`URL: ${urlResult.value || ""}`);
  lines.push("");

  // Skip roles that add noise without value
  const skipRoles = new Set([
    "none",
    "generic",
    "InlineTextBox",
    "LineBreak",
    "StaticText",
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

  for (const node of nodes) {
    const role = node.role?.value;
    if (!role || skipRoles.has(role)) continue;
    if (role === "WebArea" || role === "RootWebArea") continue;

    const name = node.name?.value || "";
    const isInteractive = interactiveRoles.has(role);

    // Skip non-interactive nodes with no name
    if (!isInteractive && !name) continue;

    // Build state string from properties
    const states: string[] = [];
    if (node.properties) {
      for (const prop of node.properties) {
        const val = prop.value?.value;
        if (prop.name === "focused" && val) states.push("focused");
        if (prop.name === "checked" && val) states.push("checked");
        if (prop.name === "disabled" && val) states.push("disabled");
        if (prop.name === "expanded" && val === true) states.push("expanded");
        if (prop.name === "expanded" && val === false)
          states.push("collapsed");
        if (prop.name === "selected" && val) states.push("selected");
        if (prop.name === "required" && val) states.push("required");
        if (prop.name === "autocomplete" && val && val !== "none")
          states.push("autocomplete");
      }
    }

    const stateStr = states.length > 0 ? " " + states.join(" ") : "";

    if (isInteractive && node.backendDOMNodeId) {
      refCounter++;
      refMap.set(refCounter, node.backendDOMNodeId);
      lines.push(
        `[${refCounter}] ${role}${name ? ` "${name}"` : ""}${stateStr}`
      );
    } else if (name) {
      // Non-interactive but named elements (headings, images, etc.)
      if (node.backendDOMNodeId) {
        refCounter++;
        refMap.set(refCounter, node.backendDOMNodeId);
        lines.push(
          `[${refCounter}] ${role}${name ? ` "${name}"` : ""}${stateStr}`
        );
      } else {
        lines.push(`${role}${name ? ` "${name}"` : ""}${stateStr}`);
      }
    }
  }

  if (refCounter === 0) {
    lines.push("(no interactive elements found)");
  }

  return lines.join("\n");
}
