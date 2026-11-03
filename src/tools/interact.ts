import { getClient } from "../cdp.js";
import { getAccessibilityTree } from "../utils/accessibility.js";
import { resolveElement, getElementCenter } from "../utils/selectors.js";

export const clickToolDef = {
  name: "click",
  description:
    "Click an element by ref number (from get_page/navigate) or CSS selector. " +
    "Returns updated page content after click.",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: 'Ref number (e.g. "3") or CSS selector',
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Mouse button (default: left)",
      },
    },
    required: ["selector"],
  },
};

export const typeToolDef = {
  name: "type",
  description:
    "Type text into an element. First focuses the element, then dispatches text input. " +
    "Returns updated page content.",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description: 'Ref number (e.g. "3") or CSS selector',
      },
      text: {
        type: "string",
        description: "Text to type",
      },
      clear: {
        type: "boolean",
        description: "Clear existing content first (default: false)",
      },
      pressEnter: {
        type: "boolean",
        description: "Press Enter after typing (default: false)",
      },
    },
    required: ["selector", "text"],
  },
};

export const scrollToolDef = {
  name: "scroll",
  description: "Scroll the page or scroll an element into view.",
  inputSchema: {
    type: "object" as const,
    properties: {
      selector: {
        type: "string",
        description:
          'Element ref or CSS selector to scroll into view. If omitted, scrolls the page.',
      },
      direction: {
        type: "string",
        enum: ["up", "down"],
        description: "Scroll direction when no selector (default: down)",
      },
      amount: {
        type: "number",
        description: "Pixels to scroll (default: 500)",
      },
    },
  },
};

export const fillFormToolDef = {
  name: "fill_form",
  description:
    "Fill multiple form fields in one call. Each field is specified as a selector+value pair. " +
    "Much faster than calling type multiple times. Returns updated page.",
  inputSchema: {
    type: "object" as const,
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            selector: {
              type: "string",
              description: 'Ref number or CSS selector',
            },
            value: {
              type: "string",
              description: "Value to fill in",
            },
          },
          required: ["selector", "value"],
        },
        description: "Array of {selector, value} pairs",
      },
      submit: {
        type: "boolean",
        description: "Submit the form after filling (default: false)",
      },
    },
    required: ["fields"],
  },
};

export async function handleClick(args: {
  selector: string;
  button?: string;
}): Promise<string> {
  const client = await getClient();
  const { x, y } = await getElementCenter(args.selector);

  const button = args.button || "left";
  const buttonNum = button === "right" ? 2 : button === "middle" ? 1 : 0;

  await client.Input.dispatchMouseEvent({
    type: "mousePressed",
    x,
    y,
    button,
    buttons: buttonNum,
    clickCount: 1,
  });
  await client.Input.dispatchMouseEvent({
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: buttonNum,
    clickCount: 1,
  });

  // Wait a bit for navigation or UI updates
  await new Promise((r) => setTimeout(r, 300));

  return getAccessibilityTree();
}

export async function handleType(args: {
  selector: string;
  text: string;
  clear?: boolean;
  pressEnter?: boolean;
}): Promise<string> {
  const client = await getClient();
  const resolved = await resolveElement(args.selector);

  // Focus the element
  await client.DOM.focus({ backendNodeId: resolved.backendNodeId });

  // Clear if requested
  if (args.clear) {
    await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: `function() { this.value = ''; this.dispatchEvent(new Event('input', {bubbles: true})); }`,
    });
  }

  // Use insertText for the whole string at once (fast)
  await client.Input.insertText({ text: args.text });

  if (args.pressEnter) {
    await client.Input.dispatchKeyEvent({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await client.Input.dispatchKeyEvent({
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  await new Promise((r) => setTimeout(r, 100));
  return getAccessibilityTree();
}

export async function handleScroll(args: {
  selector?: string;
  direction?: string;
  amount?: number;
}): Promise<string> {
  const client = await getClient();

  if (args.selector) {
    const resolved = await resolveElement(args.selector);
    await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: `function() { this.scrollIntoView({behavior: 'smooth', block: 'center'}); }`,
    });
  } else {
    const amount = args.amount ?? 500;
    const delta = args.direction === "up" ? -amount : amount;
    await client.Runtime.evaluate({
      expression: `window.scrollBy({top: ${delta}, behavior: 'smooth'})`,
    });
  }

  await new Promise((r) => setTimeout(r, 200));
  return getAccessibilityTree();
}

export async function handleFillForm(args: {
  fields: Array<{ selector: string; value: string }>;
  submit?: boolean;
}): Promise<string> {
  const client = await getClient();

  for (const field of args.fields) {
    const resolved = await resolveElement(field.selector);
    await client.DOM.focus({ backendNodeId: resolved.backendNodeId });

    // Clear and set value
    await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: `function(val) {
        this.value = val;
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
      }`,
      arguments: [{ value: field.value }],
    });
  }

  if (args.submit) {
    // Find and submit the form containing the last field
    const lastField = args.fields[args.fields.length - 1];
    const resolved = await resolveElement(lastField.selector);
    await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: `function() {
        const form = this.closest('form');
        if (form) form.submit();
        else this.form?.submit();
      }`,
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  return getAccessibilityTree();
}
