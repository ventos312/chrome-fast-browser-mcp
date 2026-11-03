import type { CDPClient } from "../cdp.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reject with `message` if `promise` has not settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface Waiter<T> {
  promise: Promise<T | null>;
  cancel: () => void;
}

/**
 * Start listening for a CDP event that satisfies `predicate`.
 * The listener is attached synchronously, so an event that fires between this
 * call and the `await` is not lost. Resolves with the event payload, or with
 * null once `timeoutMs` has passed. The listener is always removed afterwards,
 * so repeated waits do not pile up listeners on the client.
 */
export function waitForEvent<T = any>(
  client: CDPClient,
  event: string,
  timeoutMs: number,
  predicate: (payload: T) => boolean = () => true
): Waiter<T> {
  let resolve!: (value: T | null) => void;
  const promise = new Promise<T | null>((r) => {
    resolve = r;
  });
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const finish = (value: T | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    client.removeListener(event, handler);
    resolve(value);
  };
  const handler = (payload: T) => {
    if (predicate(payload)) finish(payload);
  };
  client.on(event, handler);
  timer = setTimeout(() => finish(null), timeoutMs);
  return { promise, cancel: () => finish(null) };
}

export async function getMainFrameId(client: CDPClient): Promise<string> {
  const { frameTree } = await client.Page.getFrameTree();
  return frameTree.frame.id;
}

export type WaitUntil = "load" | "domcontentloaded" | "networkidle";

const LIFECYCLE_NAME: Record<WaitUntil, string> = {
  load: "load",
  domcontentloaded: "DOMContentLoaded",
  networkidle: "networkIdle",
};

/**
 * Wait until the navigation of `frameId` (identified by `loaderId` when known)
 * reaches the `until` lifecycle stage. Same-document navigations (hash changes)
 * resolve as soon as Chrome reports them, since they never fire load events.
 * Resolves false on timeout rather than throwing, so callers can still return
 * the page as it currently is.
 */
export async function waitForNavigation(
  client: CDPClient,
  opts: { frameId: string; loaderId?: string; until?: WaitUntil; timeoutMs: number }
): Promise<boolean> {
  const name = LIFECYCLE_NAME[opts.until ?? "load"];
  const lifecycle = waitForEvent(
    client,
    "Page.lifecycleEvent",
    opts.timeoutMs,
    (e: { frameId: string; loaderId: string; name: string }) =>
      e.frameId === opts.frameId &&
      e.name === name &&
      (!opts.loaderId || e.loaderId === opts.loaderId)
  );
  const sameDocument = waitForEvent(
    client,
    "Page.navigatedWithinDocument",
    opts.timeoutMs,
    (e: { frameId: string }) => e.frameId === opts.frameId
  );
  const hit = await Promise.race([lifecycle.promise, sameDocument.promise]);
  lifecycle.cancel();
  sameDocument.cancel();
  return hit !== null;
}

const networkEnabled = new WeakSet<object>();

/** Enable the Network domain once per connection; it is only needed for idle detection. */
export async function ensureNetworkEnabled(client: CDPClient): Promise<void> {
  if (networkEnabled.has(client)) return;
  await client.Network.enable();
  networkEnabled.add(client);
}

/**
 * Resolve true once no request has been in flight for `idleMs`, or false when
 * `timeoutMs` elapses first (pages with long-polling never go idle).
 */
export async function waitForNetworkIdle(
  client: CDPClient,
  idleMs = 500,
  timeoutMs = 10_000
): Promise<boolean> {
  await ensureNetworkEnabled(client);
  return new Promise<boolean>((resolve) => {
    const inflight = new Set<string>();
    let idleTimer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      client.removeListener("Network.requestWillBeSent", onSent);
      client.removeListener("Network.loadingFinished", onDone);
      client.removeListener("Network.loadingFailed", onDone);
      resolve(ok);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      if (inflight.size === 0) idleTimer = setTimeout(() => finish(true), idleMs);
    };
    const onSent = (e: { requestId: string }) => {
      inflight.add(e.requestId);
      clearTimeout(idleTimer);
    };
    const onDone = (e: { requestId: string }) => {
      inflight.delete(e.requestId);
      armIdle();
    };
    client.on("Network.requestWillBeSent", onSent);
    client.on("Network.loadingFinished", onDone);
    client.on("Network.loadingFailed", onDone);
    const deadline = setTimeout(() => finish(false), timeoutMs);
    armIdle();
  });
}

/**
 * Give an action (click, Enter, form submit) time to take effect. If it started
 * a navigation of the main frame, also wait for the new document to load, so
 * the snapshot that follows shows the new page and not the old one mid-teardown.
 * Returns a note when the new page did not finish loading in time, else null.
 */
export async function settleAfterAction(
  client: CDPClient,
  quietMs = 300,
  loadTimeoutMs = 10_000
): Promise<string | null> {
  const frameId = await getMainFrameId(client);
  let navigationStarted = false;
  let loadDone = false;
  const isMain = (e: { frameId?: string; frame?: { id: string } }) =>
    e.frameId === frameId || e.frame?.id === frameId;
  const onStart = (e: { frameId?: string; frame?: { id: string } }) => {
    if (isMain(e)) navigationStarted = true;
  };
  const onLifecycle = (e: { frameId: string; name: string }) => {
    if (e.frameId !== frameId) return;
    if (e.name === "init") navigationStarted = true;
    if (e.name === "load" && navigationStarted) loadDone = true;
  };
  const onSameDocument = (e: { frameId: string }) => {
    if (e.frameId === frameId) {
      navigationStarted = true;
      loadDone = true;
    }
  };
  // Attach before the quiet period so a navigation that starts, or even
  // finishes, during it is still observed.
  client.on("Page.frameRequestedNavigation", onStart);
  client.on("Page.frameStartedLoading", onStart);
  client.on("Page.frameNavigated", onStart);
  client.on("Page.lifecycleEvent", onLifecycle);
  client.on("Page.navigatedWithinDocument", onSameDocument);
  try {
    await sleep(quietMs);
    if (!navigationStarted) return null;
    const deadline = Date.now() + loadTimeoutMs;
    while (!loadDone && Date.now() < deadline) await sleep(50);
    // Let the new document run its first scripts before it is snapshotted.
    await sleep(150);
    return loadDone
      ? null
      : `The action started a navigation, but the new page had not finished loading after ${loadTimeoutMs} ms; the content below may be incomplete.`;
  } finally {
    client.removeListener("Page.frameRequestedNavigation", onStart);
    client.removeListener("Page.frameStartedLoading", onStart);
    client.removeListener("Page.frameNavigated", onStart);
    client.removeListener("Page.lifecycleEvent", onLifecycle);
    client.removeListener("Page.navigatedWithinDocument", onSameDocument);
  }
}

/** Press and release a key. `text` makes Chrome also deliver a keypress, which Enter needs to submit forms. */
export async function pressKey(
  client: CDPClient,
  key: string,
  windowsVirtualKeyCode: number,
  text?: string
): Promise<void> {
  const base = { key, code: key, windowsVirtualKeyCode };
  await client.Input.dispatchKeyEvent(
    text
      ? { type: "keyDown", text, unmodifiedText: text, ...base }
      : { type: "rawKeyDown", ...base }
  );
  await client.Input.dispatchKeyEvent({ type: "keyUp", ...base });
}
