import { addNote, getClient, getDocumentEpoch, takeNotes, type CDPClient } from "../cdp.js";
import { sleep } from "./waits.js";

interface AXValue {
  type?: string;
  value?: any;
}

interface AXNode {
  nodeId: string;
  ignored?: boolean;
  ignoredReasons?: Array<{ name: string; value?: AXValue }>;
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
 * "dom": the same information read from the DOM instead of the accessibility
 *        tree, for pages whose tree is hidden by a modal or inert content.
 */
export type SnapshotFormat = "accessibility" | "interactive" | "dom";

export interface SnapshotOptions {
  format?: SnapshotFormat;
  /** Skip this many content lines (continuation of a truncated snapshot). */
  offset?: number;
  /** List every link in long navigation menus instead of the first few. */
  expandMenus?: boolean;
}

/** What a ref points at: a backend DOM node id, or "xpath:…" for snapshots built from the DOM. */
export type RefTarget = number | string;

/** Characters of page content per snapshot before the rest is omitted. */
const MAX_CHARS = Math.max(2000, parseInt(process.env.CHROME_FAST_MAX_CHARS || "", 10) || 20_000);
const MAX_TEXT = 1000;
const MAX_VALUE = 200;
/** Navigation menus with more links than this show only the first MENU_SHOW. */
const MENU_COLLAPSE_AT = 25;
const MENU_SHOW = 10;
/** Pages this small are always returned in full after an action; a change report would not be shorter. */
const SMALL_PAGE_CHARS = 1500;
const MAX_CHANGE_LINES = 150;

// ---------------------------------------------------------------------------
// Refs. They are stable for the life of a document: an element keeps its
// number across snapshots, so a change report can mention a few lines without
// renumbering everything the agent has already seen.
// ---------------------------------------------------------------------------

let refEpoch = -1;
let nextRef = 0;
const refByTarget = new Map<RefTarget, number>();
const refMap = new Map<number, RefTarget>();

export function getRefMap(): Map<number, RefTarget> {
  return refMap;
}

function syncEpoch(): number {
  const epoch = getDocumentEpoch();
  if (epoch !== refEpoch) {
    refEpoch = epoch;
    nextRef = 0;
    refByTarget.clear();
    refMap.clear();
    lastSnapshot = null;
  }
  return epoch;
}

function refFor(target: RefTarget): number {
  let ref = refByTarget.get(target);
  if (ref === undefined) {
    ref = ++nextRef;
    refByTarget.set(target, ref);
    refMap.set(ref, target);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Snapshot state shared between calls
// ---------------------------------------------------------------------------

export interface Snapshot {
  epoch: number;
  format: SnapshotFormat;
  title: string;
  url: string;
  body: string[];
  refs: number;
}

let lastSnapshot: Snapshot | null = null;

/** The snapshot that change reports compare against (used by batch to report relative to the pre-batch page). */
export function getSnapshotBaseline(): Snapshot | null {
  return lastSnapshot;
}

export function restoreSnapshotBaseline(snapshot: Snapshot | null): void {
  lastSnapshot = snapshot;
}

let suppressDepth = 0;

/** Run `fn` with page output switched off: snapshots return "" and notes are kept for the next real one. */
export async function suppressSnapshots<T>(fn: () => Promise<T>): Promise<T> {
  suppressDepth++;
  try {
    return await fn();
  } finally {
    suppressDepth--;
  }
}

// ---------------------------------------------------------------------------
// Accessibility-tree snapshot
// ---------------------------------------------------------------------------

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

const optionRoles = new Set(["option", "menuitem", "menuitemcheckbox", "menuitemradio"]);

/** Reasons that mean "hidden from assistive technology on purpose", not "uninteresting". */
const hiddenReasons = new Set([
  "activeModalDialog",
  "inertElement",
  "inertSubtree",
  "ariaHiddenElement",
  "ariaHiddenSubtree",
]);

const collapse = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + "…" : s);

function propertyValue(node: AXNode, name: string): any {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

/**
 * A text node whose text is already part of a named ancestor (a link's label,
 * a heading, a button) would be printed twice; detect that case.
 */
function coveredByAncestor(node: AXNode, text: string, byId: Map<string, AXNode>): boolean {
  // The text of a <label> repeats the name of the control it labels.
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  if (parent?.role?.value === "LabelText") {
    for (const id of parent.childIds ?? []) {
      const sibling = byId.get(id);
      if (sibling && sibling !== node && collapse(sibling.name?.value).includes(text)) return true;
    }
  }
  let parentId = node.parentId;
  for (let depth = 0; parentId && depth < 8; depth++) {
    const ancestor = byId.get(parentId);
    if (!ancestor) return false;
    const role = ancestor.role?.value;
    if (role === "RootWebArea" || role === "WebArea") return false;
    // A field's value is a text node of the field; it is already on the field's own line.
    const value = collapse(ancestor.value?.value);
    if (value && value.includes(text)) return true;
    const name = collapse(ancestor.name?.value);
    if (name) return name.includes(text);
    parentId = ancestor.parentId;
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

/** Depth-first (document) order of a flat node list, via parent/child links. */
function documentOrder(nodes: AXNode[], byId: Map<string, AXNode>): AXNode[] {
  const ordered: AXNode[] = [];
  const seen = new Set<string>();
  const visit = (node: AXNode) => {
    if (seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    ordered.push(node);
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child);
    }
  };
  for (const node of nodes) if (!node.parentId || !byId.has(node.parentId)) visit(node);
  for (const node of nodes) visit(node); // anything not reachable from a root
  return ordered;
}

async function fetchTree(client: CDPClient): Promise<{ nodes: AXNode[]; title: string; url: string }> {
  // Right after a navigation the document may be mid-swap and the tree empty
  // or unavailable; retry briefly instead of failing the whole tool call.
  for (let attempt = 0; ; attempt++) {
    try {
      const [ax, info] = await Promise.all([
        client.Accessibility.getFullAXTree(),
        client.Runtime.evaluate({
          expression: "({ title: document.title, url: location.href })",
          returnByValue: true,
        }),
      ]);
      const nodes: AXNode[] = ax.nodes ?? [];
      const meta = info.result?.value ?? {};
      if (nodes.length > 1 || attempt >= 1) return { nodes, title: meta.title || "", url: meta.url || "" };
    } catch (err) {
      if (attempt >= 2) throw err;
    }
    await sleep(150);
  }
}

interface AXBuild {
  snapshot: Snapshot;
  /** Nodes hidden on purpose (modal, inert, aria-hidden). */
  hidden: number;
}

async function buildFromAXTree(
  client: CDPClient,
  format: "accessibility" | "interactive",
  expandMenus: boolean
): Promise<AXBuild> {
  const { nodes: rawNodes, title, url } = await fetchTree(client);
  const epoch = syncEpoch();
  const byId = new Map<string, AXNode>(rawNodes.map((n) => [n.nodeId, n]));
  // Chrome returns the tree breadth-first, which puts a page's form fields far
  // below the headings they belong to. Re-order depth-first so lines follow
  // the document.
  const nodes = documentOrder(rawNodes, byId);

  const descendants = (node: AXNode): string[] => {
    const out: string[] = [];
    const stack = [...(node.childIds ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      out.push(id);
      const child = byId.get(id);
      if (child?.childIds) stack.push(...child.childIds);
    }
    return out;
  };

  const body: string[] = [];
  let refs = 0;
  let hidden = 0;
  const skip = new Set<string>();
  let menu: { ids: Set<string>; name: string; shown: number; hidden: number } | null = null;
  const closeMenu = () => {
    if (menu && menu.hidden > 0) {
      body.push(
        `… ${menu.hidden} more links in navigation "${menu.name}" not shown (get_page with expandMenus: true lists them)`
      );
    }
    menu = null;
  };

  for (const node of nodes) {
    if (menu && !menu.ids.has(node.nodeId)) closeMenu();
    if (skip.has(node.nodeId)) continue;
    if (node.ignored) {
      if (node.ignoredReasons?.some((r) => hiddenReasons.has(r.name))) hidden++;
      continue;
    }
    const role = node.role?.value;
    if (!role || role === "WebArea" || role === "RootWebArea") continue;

    if (role === "StaticText") {
      if (format === "interactive") continue;
      const text = collapse(node.name?.value);
      if (!text || coveredByAncestor(node, text, byId)) continue;
      body.push(`text "${clip(text, MAX_TEXT)}"`);
      continue;
    }

    if (skipRoles.has(role)) continue;

    const name = collapse(node.name?.value);
    const isInteractive = interactiveRoles.has(role);

    // Skip non-interactive nodes with no name
    if (!isInteractive && !name) continue;

    let suffix = "";
    if (role === "combobox" && propertyValue(node, "expanded") !== true) {
      // The option list of a closed select is noise, sometimes hundreds of
      // lines; show the selected value and a count instead.
      const inside = descendants(node);
      for (const id of inside) skip.add(id);
      const count = inside.filter((id) => optionRoles.has(byId.get(id)?.role?.value)).length;
      if (count > 0) suffix = ` (${count} options)`;
    }

    if (role === "navigation" && !expandMenus && !menu) {
      const inside = descendants(node);
      const links = inside.filter((id) => {
        const d = byId.get(id);
        return !!d && !d.ignored && interactiveRoles.has(d.role?.value);
      }).length;
      if (links > MENU_COLLAPSE_AT) menu = { ids: new Set(inside), name: name || "menu", shown: 0, hidden: 0 };
    }

    if (menu && isInteractive && menu.ids.has(node.nodeId)) {
      if (menu.shown >= MENU_SHOW) {
        menu.hidden++;
        continue;
      }
      menu.shown++;
    }

    const label =
      `${role}${name ? ` "${clip(name, MAX_TEXT)}"` : ""}` +
      describeValue(node) +
      describeStates(node) +
      suffix;

    if (node.backendDOMNodeId) {
      refs++;
      body.push(`[${refFor(node.backendDOMNodeId)}] ${label}`);
    } else {
      body.push(label);
    }
  }
  closeMenu();

  return { snapshot: { epoch, format, title, url, body, refs }, hidden };
}

// ---------------------------------------------------------------------------
// DOM snapshot: the same picture read straight from the DOM. Used when a modal
// or inert content leaves the accessibility tree empty, and on request.
// ---------------------------------------------------------------------------

interface DomEntry {
  kind: "text" | "node";
  text?: string;
  role?: string;
  name?: string;
  value?: string;
  level?: number;
  options?: number;
  states?: string[];
  xpath?: string;
}

const DOM_SNAPSHOT = `(() => {
  const MAX_ENTRIES = 4000;
  const entries = [];
  const collapse = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    if (typeof el.checkVisibility === "function") return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    return el.getClientRects().length > 0;
  };
  const xpathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      let index = 1;
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) index++;
      parts.unshift(n.tagName.toLowerCase() + "[" + index + "]");
    }
    return "/html/" + parts.join("/");
  };
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return collapse(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const text = collapse(by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" "));
      if (text) return text;
    }
    if (el.labels && el.labels.length) {
      const text = collapse(Array.from(el.labels).map((l) => l.innerText).join(" "));
      if (text) return text;
    }
    for (const attr of ["placeholder", "title", "alt"]) {
      const v = el.getAttribute(attr);
      if (v) return collapse(v);
    }
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type) && el.value) return collapse(el.value);
    if (el.tagName === "IMG" || el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA") return "";
    return collapse(el.innerText).slice(0, 300);
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.split(/\\s+/)[0];
    const tag = el.tagName;
    if (tag === "A") return el.hasAttribute("href") ? "link" : null;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const t = (el.type || "text").toLowerCase();
      if (t === "hidden") return null;
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      if (t === "range") return "slider";
      if (t === "number") return "spinbutton";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "IMG") return el.alt ? "image" : null;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return "textbox";
    if (el.hasAttribute("onclick")) return "button";
    return null;
  };
  const namedRoles = new Set(["link", "button", "textbox", "combobox", "listbox", "checkbox", "radio", "searchbox", "spinbutton", "slider"]);
  const labelled = "a[href],button,summary,label,select,option,textarea,h1,h2,h3,h4,h5,h6,[role=button],[role=link],[role=heading],[role=menuitem],[role=tab],[role=option]";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType !== 1) return NodeFilter.FILTER_ACCEPT;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "HEAD"].includes(n.tagName)) return NodeFilter.FILTER_REJECT;
      return visible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n && entries.length < MAX_ENTRIES; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      if (n.parentElement && n.parentElement.closest(labelled)) continue;
      const text = collapse(n.nodeValue);
      if (text) entries.push({ kind: "text", text: text.slice(0, 1000) });
      continue;
    }
    const role = roleOf(n);
    if (!role) continue;
    const name = nameOf(n);
    if (!name && !namedRoles.has(role)) continue;
    const entry = { kind: "node", role, name, xpath: xpathOf(n), states: [] };
    if (role === "heading") entry.level = parseInt(n.tagName[1], 10) || parseInt(n.getAttribute("aria-level") || "0", 10) || undefined;
    if (n.tagName === "SELECT") {
      entry.value = n.selectedOptions[0] ? collapse(n.selectedOptions[0].text) : "";
      entry.options = n.options.length;
    } else if ((n.tagName === "INPUT" || n.tagName === "TEXTAREA") && !["checkbox", "radio", "button", "submit", "reset", "image", "password"].includes(n.type)) {
      entry.value = String(n.value).slice(0, 200);
    } else if (n.isContentEditable) {
      entry.value = collapse(n.innerText).slice(0, 200);
    }
    if (n.tagName === "INPUT" && (n.type === "checkbox" || n.type === "radio")) {
      if (n.checked) entry.states.push("checked");
    } else if (n.getAttribute("aria-checked") === "true") {
      entry.states.push("checked");
    }
    if (n.disabled || n.getAttribute("aria-disabled") === "true") entry.states.push("disabled");
    if (n.required) entry.states.push("required");
    const expanded = n.getAttribute("aria-expanded");
    if (expanded === "true") entry.states.push("expanded");
    else if (expanded === "false") entry.states.push("collapsed");
    if (document.activeElement === n) entry.states.push("focused");
    entries.push(entry);
  }
  return { title: document.title, url: location.href, entries };
})()`;

async function buildFromDOM(client: CDPClient): Promise<Snapshot> {
  const epoch = syncEpoch();
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression: DOM_SNAPSHOT,
    returnByValue: true,
  });
  if (exceptionDetails) {
    throw new Error(
      `Could not read the page DOM: ${exceptionDetails.exception?.description || exceptionDetails.text}`
    );
  }
  const data = (result?.value ?? { title: "", url: "", entries: [] }) as {
    title: string;
    url: string;
    entries: DomEntry[];
  };
  const body: string[] = [];
  let refs = 0;
  for (const entry of data.entries) {
    if (entry.kind === "text") {
      body.push(`text "${clip(entry.text ?? "", MAX_TEXT)}"`);
      continue;
    }
    const value = entry.value ? ` value="${clip(collapse(entry.value), MAX_VALUE)}"` : "";
    const level = entry.level ? ` level=${entry.level}` : "";
    const states = entry.states?.length ? " " + entry.states.join(" ") : "";
    const options = entry.options ? ` (${entry.options} options)` : "";
    refs++;
    body.push(
      `[${refFor("xpath:" + entry.xpath)}] ${entry.role}${entry.name ? ` "${clip(entry.name, MAX_TEXT)}"` : ""}${value}${level}${states}${options}`
    );
  }
  return { epoch, format: "dom", title: data.title, url: data.url, body, refs };
}

async function build(client: CDPClient, opts: SnapshotOptions): Promise<Snapshot> {
  const format = opts.format ?? "accessibility";
  if (format === "dom") return buildFromDOM(client);

  const { snapshot, hidden } = await buildFromAXTree(client, format, !!opts.expandMenus);

  if (snapshot.refs === 0) {
    // An open modal dialog, or inert / aria-hidden attributes, can hide the
    // whole page from assistive technology; some sites leave such an element
    // in place for good. Read the DOM instead rather than return nothing.
    const dom = await buildFromDOM(client);
    if (dom.body.length > snapshot.body.length) {
      addNote(
        (hidden > 0
          ? `The accessibility tree is empty: ${hidden} element${hidden === 1 ? "" : "s"} hide the page from it (an open aria-modal dialog, or aria-hidden/inert attributes). `
          : "The accessibility tree of this page is empty. ") +
          "This snapshot was built from the DOM instead."
      );
      return dom;
    }
  } else if (hidden >= 20) {
    addNote(
      `${hidden} elements are hidden from the accessibility tree by an open modal dialog or by aria-hidden/inert attributes. ` +
        'If something you need is missing, close the dialog or call get_page with format: "dom".'
    );
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHeader(snapshot: Snapshot): string[] {
  const lines = takeNotes().map((note) => `Note: ${note}`);
  if (lines.length) lines.push("");
  lines.push(`Page: ${clip(snapshot.title || "(untitled)", 300)}`);
  // data: and blob: URLs can carry a whole document; keep the header readable.
  lines.push(`URL: ${clip(snapshot.url, 2000)}`);
  lines.push("");
  return lines;
}

function renderFull(snapshot: Snapshot, offset = 0, header = renderHeader(snapshot)): string {
  const lines = [...header];
  const start = Math.max(0, Math.min(offset, snapshot.body.length));
  if (start > 0) lines.push(`(continuing at line ${start} of ${snapshot.body.length})`);

  let chars = 0;
  let shown = 0;
  for (let i = start; i < snapshot.body.length; i++) {
    const line = snapshot.body[i];
    if (chars + line.length + 1 > MAX_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
    shown++;
  }

  if (snapshot.refs === 0) lines.push("(no interactive elements found)");
  const rest = snapshot.body.length - start - shown;
  if (rest > 0) {
    lines.push(
      `… ${rest} more lines not shown (output limit ${MAX_CHARS} characters, CHROME_FAST_MAX_CHARS). ` +
        `Call get_page with offset: ${start + shown} to continue.`
    );
  }
  return lines.join("\n");
}

/**
 * Lines present in `next` but not in `previous`, and the other way round, as
 * multisets in order. Lines are matched by `key`, so details the caller does
 * not care about (focus moving around) do not show up as changes.
 */
function diffLines(
  previous: string[],
  next: string[],
  key: (line: string) => string = (line) => line
): { added: string[]; removed: string[] } {
  const unmatched = new Map<string, string[]>();
  for (const line of previous) {
    const k = key(line);
    const list = unmatched.get(k);
    if (list) list.push(line);
    else unmatched.set(k, [line]);
  }
  const added: string[] = [];
  for (const line of next) {
    const list = unmatched.get(key(line));
    if (list && list.length > 0) list.pop();
    else added.push(line);
  }
  const removed: string[] = [];
  for (const list of unmatched.values()) removed.push(...list);
  return { added, removed };
}

/** Focus moves on almost every action; it is not a change worth reporting. */
const ignoringFocus = (line: string): string => line.replace(/ focused(?= |$)/, "");

/** The whole page, as returned by navigate, get_page and the tab tools. */
export async function getAccessibilityTree(opts: SnapshotOptions = {}): Promise<string> {
  if (suppressDepth > 0) return "";
  const client = await getClient();
  const snapshot = await build(client, opts);
  if (snapshot.format !== "interactive") lastSnapshot = snapshot;
  return renderFull(snapshot, opts.offset ?? 0);
}

/**
 * What changed since the previous snapshot, as returned after an action.
 * Falls back to the whole page when there is nothing to compare with (a new
 * document), when the page is small, or when most of it changed.
 */
export async function getPageUpdate(): Promise<string> {
  if (suppressDepth > 0) return "";
  const client = await getClient();
  const previous = lastSnapshot;
  const snapshot = await build(client, {});
  lastSnapshot = snapshot;

  if (!previous || previous.epoch !== snapshot.epoch || previous.format !== snapshot.format) {
    return renderFull(snapshot);
  }

  const header = renderHeader(snapshot);
  const { added, removed } = diffLines(previous.body, snapshot.body, ignoringFocus);
  const changes = added.length + removed.length;
  if (changes === 0) {
    header.push(
      `No visible change on the page since the previous snapshot (${snapshot.body.length} lines). Call get_page to see the full page.`
    );
    return header.join("\n");
  }

  const bodyChars = snapshot.body.reduce((n, line) => n + line.length + 1, 0);
  if (bodyChars <= SMALL_PAGE_CHARS || changes > snapshot.body.length / 2) {
    return renderFull(snapshot, 0, header);
  }

  const lines = [...header];
  lines.push(
    `Changes since the previous snapshot (${added.length} added, ${removed.length} removed, ${snapshot.body.length} lines now; call get_page for the full page):`
  );
  for (const line of removed.slice(0, MAX_CHANGE_LINES)) lines.push(`- ${line}`);
  for (const line of added.slice(0, MAX_CHANGE_LINES)) lines.push(`+ ${line}`);
  const omitted = Math.max(0, removed.length - MAX_CHANGE_LINES) + Math.max(0, added.length - MAX_CHANGE_LINES);
  if (omitted > 0) lines.push(`… ${omitted} more changed lines not shown.`);
  return lines.join("\n");
}
