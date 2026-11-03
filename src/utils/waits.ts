import { UNLOAD_CANCELLED_EVENT, type CDPClient } from "../cdp.js";

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

export type NavigationOutcome = "done" | "cancelled" | "timeout";

/**
 * Wait until the navigation of `frameId` (identified by `loaderId` when known)
 * reaches the `until` lifecycle stage. Same-document navigations (hash changes)
 * resolve as soon as Chrome reports them, since they never fire load events.
 * Resolves "cancelled" when the page's beforeunload prompt stopped the
 * navigation, and "timeout" rather than throwing, so callers can still return
 * the page as it currently is.
 */
export async function waitForNavigation(
  client: CDPClient,
  opts: { frameId: string; loaderId?: string; until?: WaitUntil; timeoutMs: number }
): Promise<NavigationOutcome> {
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
  const cancelled = waitForEvent(client, UNLOAD_CANCELLED_EVENT, opts.timeoutMs);
  const outcome = await Promise.race<NavigationOutcome>([
    lifecycle.promise.then((hit) => (hit === null ? "timeout" : "done")),
    sameDocument.promise.then((hit) => (hit === null ? "timeout" : "done")),
    cancelled.promise.then((hit) => (hit === null ? "timeout" : "cancelled")),
  ]);
  lifecycle.cancel();
  sameDocument.cancel();
  cancelled.cancel();
  return outcome;
}

/** Enable the Network domain once per connection (setupClient already does; this covers other clients). */
export async function ensureNetworkEnabled(client: CDPClient): Promise<void> {
  if (client.__networkEnabled) return;
  await client.Network.enable();
  client.__networkEnabled = true;
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

/** Request types that carry the effect of an action (a save, a form post over fetch, lazy-loaded content). */
const TRACKED_REQUEST_TYPES = new Set(["XHR", "Fetch", "Document"]);

/** Path of a URL, for compact notes. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return url.slice(0, 80);
  }
}

interface TrackedRequest {
  method: string;
  url: string;
  status?: number;
  done: boolean;
}

export interface Settle {
  /** Call after the action: waits for its effects and returns a note for the agent, or null. */
  finish: () => Promise<string | null>;
}

/**
 * Observe what an action (click, Enter, form submit) sets in motion. Call this
 * BEFORE dispatching the action, so a navigation or request that starts at once
 * is not missed, then `finish()` after it:
 * - If it started a navigation of the main frame, wait for the new document to
 *   load, so the snapshot that follows shows the new page.
 * - Otherwise wait for the background requests it triggered (an AJAX save, a
 *   fetch that fills in content) to finish, and report them, so the agent can
 *   tell "nothing happened" from "the page saved in the background".
 */
export async function beginSettle(
  client: CDPClient,
  quietMs = 300,
  loadTimeoutMs = 10_000,
  requestTimeoutMs = 3_000
): Promise<Settle> {
  await ensureNetworkEnabled(client);
  const frameId = await getMainFrameId(client);
  let navigationStarted = false;
  let loadDone = false;
  let cancelled = false;
  const requests = new Map<string, TrackedRequest>();

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
  const onCancelled = () => {
    cancelled = true;
  };
  const onRequest = (e: { requestId: string; type?: string; request: { method: string; url: string } }) => {
    if (e.type && !TRACKED_REQUEST_TYPES.has(e.type)) return;
    if (e.request.url.startsWith("data:")) return;
    requests.set(e.requestId, { method: e.request.method, url: e.request.url, done: false });
  };
  const onResponse = (e: { requestId: string; response: { status: number } }) => {
    const r = requests.get(e.requestId);
    if (r) r.status = e.response.status;
  };
  const onRequestDone = (e: { requestId: string }) => {
    const r = requests.get(e.requestId);
    if (r) r.done = true;
  };

  // Attach before the quiet period so a navigation or request that starts, or
  // even finishes, during it is still observed.
  client.on("Page.frameRequestedNavigation", onStart);
  client.on("Page.frameStartedLoading", onStart);
  client.on("Page.frameNavigated", onStart);
  client.on("Page.lifecycleEvent", onLifecycle);
  client.on("Page.navigatedWithinDocument", onSameDocument);
  client.on(UNLOAD_CANCELLED_EVENT, onCancelled);
  client.on("Network.requestWillBeSent", onRequest);
  client.on("Network.responseReceived", onResponse);
  client.on("Network.loadingFinished", onRequestDone);
  client.on("Network.loadingFailed", onRequestDone);

  const finish = async (): Promise<string | null> => {
  try {
    await sleep(quietMs);
    if (cancelled) return null; // the dialog handler already queued a note

    if (navigationStarted) {
      const deadline = Date.now() + loadTimeoutMs;
      while (!loadDone && !cancelled && Date.now() < deadline) await sleep(50);
      if (cancelled) return null;
      // Let the new document run its first scripts before it is snapshotted.
      await sleep(150);
      return loadDone
        ? null
        : `The action started a navigation, but the new page had not finished loading after ${loadTimeoutMs} ms; the content below may be incomplete.`;
    }

    // No navigation: wait for the requests the action started (and any they
    // trigger in turn) so the snapshot shows their effect.
    const deadline = Date.now() + requestTimeoutMs;
    while (Date.now() < deadline && [...requests.values()].some((r) => !r.done)) await sleep(50);
    if (requests.size === 0) return null;
    await sleep(100);

    const list = [...requests.values()];
    const pending = list.filter((r) => !r.done).length;
    const shown = list
      .slice(0, 3)
      .map((r) => `${r.method} ${shortUrl(r.url)}${r.status ? ` → ${r.status}` : ""}`)
      .join(", ");
    return (
      `No navigation; ${list.length} background request${list.length === 1 ? "" : "s"} ` +
      (pending ? `observed, ${pending} still pending after ${requestTimeoutMs} ms` : "finished") +
      `: ${shown}${list.length > 3 ? ", …" : ""}.`
    );
  } finally {
    client.removeListener("Page.frameRequestedNavigation", onStart);
    client.removeListener("Page.frameStartedLoading", onStart);
    client.removeListener("Page.frameNavigated", onStart);
    client.removeListener("Page.lifecycleEvent", onLifecycle);
    client.removeListener("Page.navigatedWithinDocument", onSameDocument);
    client.removeListener(UNLOAD_CANCELLED_EVENT, onCancelled);
    client.removeListener("Network.requestWillBeSent", onRequest);
    client.removeListener("Network.responseReceived", onResponse);
    client.removeListener("Network.loadingFinished", onRequestDone);
    client.removeListener("Network.loadingFailed", onRequestDone);
  }
  };

  return { finish };
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
