import { z } from "zod";
import { addNote, getClient, withUnloadPolicy } from "../cdp.js";
import { getPageUpdate } from "../utils/accessibility.js";
import { resolveElement, getClickPoint } from "../utils/selectors.js";
import { beginSettle, pressKey, sleep } from "../utils/waits.js";

const selectorField = (what: string) =>
  z.string().describe(`${what}: a ref number from get_page/navigate (e.g. "3") or a CSS selector`);

export const clickToolDef = {
  name: "click",
  description:
    "Click an element by ref number (from get_page/navigate) or CSS selector. Scrolls it into view " +
    "first and, if the click starts a navigation, waits for the new page. Returns the updated page " +
    "content. For <select> elements use fill_form instead.",
  schema: {
    selector: selectorField("Element to click"),
    button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default: left)"),
  },
};

export const typeToolDef = {
  name: "type",
  description:
    "Type text into an input, textarea or contenteditable element: focuses it, then inserts the " +
    "text as if typed. Returns the updated page content.",
  schema: {
    selector: selectorField("Element to type into"),
    text: z.string().describe("Text to type"),
    clear: z
      .boolean()
      .optional()
      .describe("Replace the existing content instead of appending to it (default: false)"),
    pressEnter: z
      .boolean()
      .optional()
      .describe("Press Enter after typing, e.g. to submit a form or send a message (default: false)"),
  },
};

export const scrollToolDef = {
  name: "scroll",
  description: "Scroll the page by an amount, or scroll an element into view.",
  schema: {
    selector: selectorField("Element to scroll into view; omit to scroll the page").optional(),
    direction: z
      .enum(["up", "down"])
      .optional()
      .describe("Scroll direction when no selector is given (default: down)"),
    amount: z
      .number()
      .optional()
      .describe("Pixels to scroll when no selector is given (default: 500)"),
  },
};

export const fillFormToolDef = {
  name: "fill_form",
  description:
    "Fill several form fields in one call: text inputs, textareas, selects (by option value or " +
    'label), checkboxes and radios ("true"/"false") and contenteditable elements. Much faster than ' +
    "calling type repeatedly. Returns the updated page.",
  schema: {
    fields: z
      .array(
        z.object({
          selector: selectorField("Field"),
          value: z
            .string()
            .describe(
              'Value to set. Checkboxes/radios take "true" or "false"; selects take an option value or its visible label.'
            ),
        })
      )
      .min(1)
      .describe("Fields to fill, in order"),
    submit: z
      .boolean()
      .optional()
      .describe(
        "Afterwards submit the form containing the last field, as if its submit button were pressed (default: false)"
      ),
  },
};

const BUTTON_MASK: Record<string, number> = { left: 1, right: 2, middle: 4 };

export async function handleClick(args: {
  selector: string;
  button?: string;
}): Promise<string> {
  const client = await getClient();
  const resolved = await resolveElement(args.selector);
  const { x, y } = await getClickPoint(resolved);
  const button = args.button || "left";
  // A click may submit a form or follow a link. If the page then asks to
  // confirm leaving, that is the consequence of the requested action, so the
  // prompt is accepted; navigate and tab_close are the calls that refuse.
  await withUnloadPolicy("accept", async () => {
    const settle = await beginSettle(client);

    // Check that the point lands on the element and not on something covering it
    // (a modal, a cookie banner, a sticky header); otherwise the click would go
    // to the overlay.
    const { result: hit } = await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: `function(x, y) {
        const el = document.elementFromPoint(x, y);
        return !!el && (el === this || this.contains(el));
      }`,
      arguments: [{ value: x }, { value: y }],
      returnByValue: true,
    });

    if (hit?.value || button !== "left") {
      if (!hit?.value) {
        addNote(
          "The element is covered by another element at its position; the click may have hit the overlay instead."
        );
      }
      await client.Input.dispatchMouseEvent({ type: "mouseMoved", x, y, button: "none" });
      await client.Input.dispatchMouseEvent({
        type: "mousePressed",
        x,
        y,
        button,
        buttons: BUTTON_MASK[button],
        clickCount: 1,
      });
      await client.Input.dispatchMouseEvent({
        type: "mouseReleased",
        x,
        y,
        button,
        buttons: 0,
        clickCount: 1,
      });
    } else {
      // Fall back to a DOM click so the intended element still receives it.
      await client.Runtime.callFunctionOn({
        objectId: resolved.objectId,
        functionDeclaration: "function() { this.click(); }",
      });
      addNote(
        "The element was covered by another element at its position, so a DOM click() was dispatched to it instead of a mouse click."
      );
    }

    addNote(await settle.finish());
  });
  return getPageUpdate();
}

// Select the whole content of a field. Works for inputs, textareas and
// contenteditable editors alike; the text inserted next replaces the selection.
const SELECT_ALL = `function() {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    try { this.select(); } catch (e) {}
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(this);
  selection.removeAllRanges();
  selection.addRange(range);
}`;

// Put the caret after the existing content, so typed text is appended. Focus
// alone leaves it at the start of the field.
const CARET_TO_END = `function() {
  if (this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement) {
    try { const end = this.value.length; this.setSelectionRange(end, end); } catch (e) {}
    return;
  }
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(this);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}`;

export async function handleType(args: {
  selector: string;
  text: string;
  clear?: boolean;
  pressEnter?: boolean;
}): Promise<string> {
  const client = await getClient();
  const resolved = await resolveElement(args.selector);

  await client.DOM.scrollIntoViewIfNeeded({ backendNodeId: resolved.backendNodeId }).catch(() => {});
  await client.DOM.focus({ backendNodeId: resolved.backendNodeId });

  if (args.clear) {
    // Replacing a selection (instead of assigning .value) also works for
    // contenteditable editors and fires the input events frameworks rely on.
    await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: SELECT_ALL,
    });
    if (!args.text) await pressKey(client, "Backspace", 8);
  } else {
    await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: CARET_TO_END,
    });
  }

  // Insert the whole string at once (fast)
  if (args.text) await client.Input.insertText({ text: args.text });

  if (args.pressEnter) {
    // Enter may submit the form; a prompt to confirm leaving is then accepted.
    await withUnloadPolicy("accept", async () => {
      const settle = await beginSettle(client);
      // The "\r" text is what makes Chrome deliver a keypress; without it forms
      // are not submitted.
      await pressKey(client, "Enter", 13, "\r");
      addNote(await settle.finish());
    });
  } else {
    await sleep(100);
  }

  return getPageUpdate();
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
      functionDeclaration: `function() { this.scrollIntoView({ behavior: 'instant', block: 'center' }); }`,
    });
  } else {
    const amount = Number(args.amount ?? 500);
    const delta = args.direction === "up" ? -amount : amount;
    await client.Runtime.evaluate({
      expression: `window.scrollBy({ top: ${delta}, behavior: 'instant' })`,
    });
  }

  // Pages that load content lazily render it after the scroll; give them a moment.
  await sleep(200);
  return getPageUpdate();
}

// Set a form control's value the way a user would have, so that frameworks
// notice the change. React in particular tracks the value through the instance
// property, so assigning this.value directly makes it ignore the input event;
// the prototype setter does not have that problem.
const SET_FIELD_VALUE = `function(value) {
  const fire = (type) => this.dispatchEvent(new Event(type, { bubbles: true }));
  const tag = this.tagName;
  if (tag === "INPUT" && (this.type === "checkbox" || this.type === "radio")) {
    const want = !["false", "0", "off", "no", "unchecked", ""].includes(String(value).trim().toLowerCase());
    if (this.checked !== want) this.click();
    return this.type;
  }
  if (tag === "SELECT") {
    const options = Array.from(this.options);
    const needle = String(value).trim();
    const option =
      options.find((o) => o.value === needle) ||
      options.find((o) => o.text.trim() === needle) ||
      options.find((o) => o.text.trim().toLowerCase() === needle.toLowerCase());
    if (!option) {
      throw new Error('no option matches "' + needle + '"; the options are: ' +
        options.map((o) => o.value + " (" + o.text.trim() + ")").join(", "));
    }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(this, option.value);
    fire("input");
    fire("change");
    return "select";
  }
  if (tag === "INPUT" || tag === "TEXTAREA") {
    const proto = tag === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(this, value);
    fire("input");
    fire("change");
    return tag.toLowerCase();
  }
  if (this.isContentEditable) {
    this.textContent = value;
    fire("input");
    return "contenteditable";
  }
  throw new Error("<" + tag.toLowerCase() + "> is not a form field");
}`;

const firstLine = (details: any): string =>
  String(details?.exception?.description || details?.text || "unknown error").split("\n")[0];

export async function handleFillForm(args: {
  fields: Array<{ selector: string; value: string }>;
  submit?: boolean;
}): Promise<string> {
  const client = await getClient();

  for (const field of args.fields) {
    const resolved = await resolveElement(field.selector);
    // Focus first so blur and validation handlers of the previous field run,
    // as they would for a user.
    await client.DOM.focus({ backendNodeId: resolved.backendNodeId }).catch(() => {});
    const { exceptionDetails } = await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      functionDeclaration: SET_FIELD_VALUE,
      arguments: [{ value: field.value }],
      returnByValue: true,
    });
    if (exceptionDetails) {
      throw new Error(`Could not fill "${field.selector}": ${firstLine(exceptionDetails)}`);
    }
  }

  if (args.submit) {
    const last = args.fields[args.fields.length - 1];
    const resolved = await resolveElement(last.selector);
    await withUnloadPolicy("accept", async () => {
    const settle = await beginSettle(client);
    const { result, exceptionDetails } = await client.Runtime.callFunctionOn({
      objectId: resolved.objectId,
      // requestSubmit runs validation and submit handlers like a real submit
      // button would; submit() bypasses both.
      functionDeclaration: `function() {
        const form = this.form || this.closest("form");
        if (!form) return false;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        return true;
      }`,
      returnByValue: true,
    });
    if (exceptionDetails) throw new Error(`Could not submit the form: ${firstLine(exceptionDetails)}`);
    if (result?.value) {
      addNote(await settle.finish());
    } else {
      addNote(
        `The fields were filled, but "${last.selector}" is not inside a <form>, so nothing was submitted. Click the submit button instead.`
      );
    }
    });
  }

  return getPageUpdate();
}
