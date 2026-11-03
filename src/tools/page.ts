import { getClient } from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";

export const getPageToolDef = {
  name: "get_page",
  description:
    "Get current page content as an accessibility tree (default) or HTML. " +
    "Returns numbered element refs you can pass to click/type.",
  inputSchema: {
    type: "object" as const,
    properties: {
      format: {
        type: "string",
        enum: ["accessibility", "html"],
        description: "Output format (default: accessibility)",
      },
    },
  },
};

export const screenshotToolDef = {
  name: "screenshot",
  description:
    "Capture a screenshot of the current page. Only use when visual layout matters — " +
    "prefer get_page for most tasks.",
  inputSchema: {
    type: "object" as const,
    properties: {
      format: {
        type: "string",
        enum: ["png", "jpeg"],
        description: "Image format (default: png)",
      },
      quality: {
        type: "number",
        description: "JPEG quality 0-100 (default: 80)",
      },
      fullPage: {
        type: "boolean",
        description: "Capture full scrollable page (default: false)",
      },
    },
  },
};

export const evaluateToolDef = {
  name: "evaluate",
  description:
    "Execute JavaScript in the page and return the result. " +
    "The expression is wrapped in an async IIFE if it contains await.",
  inputSchema: {
    type: "object" as const,
    properties: {
      expression: {
        type: "string",
        description: "JavaScript expression to evaluate",
      },
    },
    required: ["expression"],
  },
};

export async function handleGetPage(args: { format?: string }): Promise<string> {
  if (args.format === "html") {
    const client = await getClient();
    const { result } = await client.Runtime.evaluate({
      expression: "document.documentElement.outerHTML",
    });
    return result.value;
  }
  return getAccessibilityTree();
}

const MAX_DIMENSION = 7680; // Claude API limit is 8000px, leave margin

export async function handleScreenshot(args: {
  format?: string;
  quality?: number;
  fullPage?: boolean;
}): Promise<{ data: string; mimeType: string }> {
  const client = await getClient();
  const format = args.format || "png";
  const params: any = {
    format,
    captureBeyondViewport: args.fullPage ?? false,
  };
  if (format === "jpeg") {
    params.quality = args.quality ?? 80;
  }

  // For fullPage screenshots, check dimensions and downscale if needed
  if (args.fullPage) {
    const metrics = await client.Page.getLayoutMetrics();
    const contentWidth = Math.ceil(metrics.contentSize.width);
    const contentHeight = Math.ceil(metrics.contentSize.height);

    if (contentWidth > MAX_DIMENSION || contentHeight > MAX_DIMENSION) {
      const scale = Math.min(
        MAX_DIMENSION / contentWidth,
        MAX_DIMENSION / contentHeight,
        1
      );
      params.clip = {
        x: 0,
        y: 0,
        width: contentWidth,
        height: contentHeight,
        scale,
      };
    }
  }

  const { data } = await client.Page.captureScreenshot(params);
  return {
    data,
    mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
  };
}

export async function handleEvaluate(args: {
  expression: string;
}): Promise<string> {
  const client = await getClient();

  let expr = args.expression;
  if (expr.includes("await")) {
    expr = `(async () => { ${expr} })()`;
  }

  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
  });

  if (exceptionDetails) {
    const msg =
      exceptionDetails.exception?.description ||
      exceptionDetails.text ||
      "Evaluation failed";
    throw new Error(msg);
  }

  if (result.type === "undefined") return "undefined";
  if (result.value !== undefined) {
    return typeof result.value === "string"
      ? result.value
      : JSON.stringify(result.value, null, 2);
  }
  return result.description || String(result.value);
}
