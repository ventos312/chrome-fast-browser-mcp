import { getClient } from "../cdp.js";
import { getRefMap } from "./accessibility.js";

export interface ResolvedNode {
  backendNodeId: number;
  objectId: string;
}

/**
 * Resolve a ref number or CSS selector to a CDP node.
 * - If `selector` is a number string like "3", look up ref #3 from the AX tree
 * - Otherwise treat it as a CSS selector
 */
export async function resolveElement(
  selector: string
): Promise<ResolvedNode> {
  const client = await getClient();

  // Try as ref number first
  const refNum = parseInt(selector, 10);
  if (!isNaN(refNum) && String(refNum) === selector.trim()) {
    const refMap = getRefMap();
    const backendNodeId = refMap.get(refNum);
    if (!backendNodeId) {
      throw new Error(
        `Ref [${refNum}] not found. Run get_page first to refresh element refs.`
      );
    }
    const { object } = await client.DOM.resolveNode({ backendNodeId });
    return { backendNodeId, objectId: object.objectId };
  }

  // CSS selector
  const { root } = await client.DOM.getDocument();
  const { nodeId } = await client.DOM.querySelector({
    nodeId: root.nodeId,
    selector,
  });
  if (!nodeId) {
    throw new Error(`No element found for selector: ${selector}`);
  }
  const { node } = await client.DOM.describeNode({ nodeId });
  const { object } = await client.DOM.resolveNode({ nodeId });
  return { backendNodeId: node.backendNodeId, objectId: object.objectId };
}

/**
 * Get the center coordinates of an element for clicking.
 */
export async function getElementCenter(
  selector: string
): Promise<{ x: number; y: number; resolvedNode: ResolvedNode }> {
  const client = await getClient();
  const resolvedNode = await resolveElement(selector);

  // Get the box model for click coordinates
  const { model } = await client.DOM.getBoxModel({
    backendNodeId: resolvedNode.backendNodeId,
  });

  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4]
  const quad = model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;

  return { x, y, resolvedNode };
}
