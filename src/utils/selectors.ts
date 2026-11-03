import { getClient } from "../cdp.js";
import { getRefMap } from "./accessibility.js";

export interface ResolvedNode {
  backendNodeId: number;
  objectId: string;
}

/** A selector made only of digits is an element ref from the last snapshot. */
export function isRef(selector: string): boolean {
  return /^\s*\d+\s*$/.test(selector);
}

/**
 * Resolve a ref number or CSS selector to a CDP node.
 * - If `selector` is a number string like "3", look up ref #3 from the AX tree
 * - Otherwise treat it as a CSS selector
 */
export async function resolveElement(selector: string): Promise<ResolvedNode> {
  const client = await getClient();

  if (isRef(selector)) {
    const refNum = parseInt(selector, 10);
    const target = getRefMap().get(refNum);
    if (target === undefined) {
      throw new Error(
        `Ref [${refNum}] not found. Run get_page first to refresh element refs.`
      );
    }
    if (typeof target === "string") {
      // A ref from a snapshot built from the DOM: locate the element by XPath.
      const xpath = target.replace(/^xpath:/, "");
      const { result } = await client.Runtime.evaluate({
        expression: `document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`,
        returnByValue: false,
      });
      if (!result?.objectId) {
        throw new Error(
          `Ref [${refNum}] is stale: that element is no longer in the page. Run get_page to refresh element refs.`
        );
      }
      const { node } = await client.DOM.describeNode({ objectId: result.objectId });
      return { backendNodeId: node.backendNodeId, objectId: result.objectId };
    }
    const backendNodeId = target;
    try {
      const { object } = await client.DOM.resolveNode({ backendNodeId });
      return { backendNodeId, objectId: object.objectId };
    } catch (err: any) {
      throw new Error(
        `Ref [${refNum}] is stale: that element is no longer in the page (${err.message}). ` +
          `Run get_page to refresh element refs.`
      );
    }
  }

  // CSS selector
  const { root } = await client.DOM.getDocument({ depth: 0 });
  let nodeId: number;
  try {
    ({ nodeId } = await client.DOM.querySelector({ nodeId: root.nodeId, selector }));
  } catch (err: any) {
    throw new Error(`Could not query selector "${selector}": ${err.message}`);
  }
  if (!nodeId) {
    throw new Error(`No element found for selector: ${selector}`);
  }
  const [{ node }, { object }] = await Promise.all([
    client.DOM.describeNode({ nodeId }),
    client.DOM.resolveNode({ nodeId }),
  ]);
  return { backendNodeId: node.backendNodeId, objectId: object.objectId };
}

/**
 * Find a point inside the visible part of an element to click on, in CSS pixels
 * relative to the viewport (what Input.dispatchMouseEvent expects).
 */
export async function getClickPoint(resolved: ResolvedNode): Promise<{ x: number; y: number }> {
  const client = await getClient();

  // Scroll the element into the viewport first. Coordinates of an off-screen
  // element would land the click on whatever happens to be at that spot.
  await client.DOM.scrollIntoViewIfNeeded({ backendNodeId: resolved.backendNodeId }).catch(() => {});

  const [{ quads }, metrics] = await Promise.all([
    client.DOM.getContentQuads({ backendNodeId: resolved.backendNodeId }).catch(() => ({ quads: [] })),
    client.Page.getLayoutMetrics(),
  ]);
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;

  // Inline elements wrapping onto several lines have one quad per line; use the
  // first one that is actually visible rather than the centre of the bounding
  // box, which can fall between the lines.
  for (const quad of quads as number[][]) {
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const left = Math.max(0, Math.min(...xs));
    const right = Math.min(viewport.clientWidth, Math.max(...xs));
    const top = Math.max(0, Math.min(...ys));
    const bottom = Math.min(viewport.clientHeight, Math.max(...ys));
    if (right - left >= 1 && bottom - top >= 1) {
      return { x: (left + right) / 2, y: (top + bottom) / 2 };
    }
  }

  throw new Error(
    "Element is not visible: it has no size or lies outside the viewport, so it cannot be clicked. " +
      "Run get_page to refresh refs, or click a different element."
  );
}
