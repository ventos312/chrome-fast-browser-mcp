import CDP from "chrome-remote-interface";
import { spawn } from "child_process";
import { existsSync } from "fs";
import http from "http";
import path from "path";

/** A chrome-remote-interface client. Its protocol domains are untyped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CDPClient = any;

export const CHROME_PORT = parseInt(process.env.CHROME_PORT || "9222", 10);
/** chrome-fast always talks to Chrome over loopback, whatever address Chrome itself binds. */
const CHROME_HOST = "127.0.0.1";
export const CHROME_PROFILE =
  process.env.CHROME_PROFILE ||
  path.join(
    process.env.LOCALAPPDATA || process.env.HOME || ".",
    "NanoClaw",
    "ChromeProfile"
  );
/**
 * Address Chrome's DevTools port binds to when chrome-fast launches it.
 * The DevTools protocol has no authentication: anyone who can reach the port
 * has full control of the browser profile, including its logged-in sessions.
 * So the default is loopback only. Set CHROME_DEBUG_ADDRESS=0.0.0.0 only when
 * another machine or container must connect to Chrome directly; the HTTP mode
 * of this server does not need that, because the server is what they talk to.
 */
const CHROME_DEBUG_ADDRESS = process.env.CHROME_DEBUG_ADDRESS || "127.0.0.1";
// Set CHROME_AUTO_LAUNCH=0 to disable launching Chrome automatically.
const AUTO_LAUNCH = (process.env.CHROME_AUTO_LAUNCH || "1") !== "0";
const LAUNCH_TIMEOUT_MS = 30_000;

const devtoolsOptions = { host: CHROME_HOST, port: CHROME_PORT };

let client: CDPClient | null = null;
let activeTargetId: string | null = null;
let connectPromise: Promise<CDPClient> | null = null;
let launchPromise: Promise<void> | null = null;

/**
 * Things that were handled automatically (dismissed dialogs, timeouts) and
 * that the caller should know about. They are drained into the next page
 * snapshot so the agent sees them next to the content they affected.
 */
const pendingNotes: string[] = [];
export function addNote(note: string | null | undefined): void {
  if (note) pendingNotes.push(note);
}
export function takeNotes(): string[] {
  return pendingNotes.splice(0, pendingNotes.length);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findChrome(): string | null {
  if (process.env.CHROME_PATH) {
    if (existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    process.stderr.write(
      `chrome-fast: CHROME_PATH is set to ${process.env.CHROME_PATH} but no file exists there; falling back to auto-detection\n`
    );
  }
  const pf = process.env.ProgramFiles;
  const pf86 = process.env["ProgramFiles(x86)"];
  const lad = process.env.LOCALAPPDATA;
  const candidates = [
    pf && path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    pf86 && path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    lad && path.join(lad, "Google", "Chrome", "Application", "chrome.exe"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function isChromeUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: CHROME_HOST, port: CHROME_PORT, path: "/json/version", timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** The flags chrome-fast launches Chrome with; start-chrome-debug.bat uses the same set. */
export function chromeLaunchArgs(): string[] {
  return [
    `--remote-debugging-port=${CHROME_PORT}`,
    `--remote-debugging-address=${CHROME_DEBUG_ADDRESS}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

/**
 * Make sure a debuggable Chrome is listening on CHROME_PORT.
 * If it is not, launch one with the same flags as start-chrome-debug.bat
 * (same isolated profile, so logins persist) and wait for the port to open.
 * Concurrent callers share one launch.
 */
export async function ensureChrome(): Promise<void> {
  if (await isChromeUp()) return;
  if (!AUTO_LAUNCH) {
    throw new Error(
      `Cannot connect to Chrome on port ${CHROME_PORT} and CHROME_AUTO_LAUNCH=0. ` +
        `Run start-chrome-debug.bat first.`
    );
  }
  if (!launchPromise) {
    launchPromise = (async () => {
      const chrome = findChrome();
      if (!chrome) {
        throw new Error(
          `Chrome not reachable on port ${CHROME_PORT} and no Chrome executable found. ` +
            `Set CHROME_PATH or run start-chrome-debug.bat.`
        );
      }
      process.stderr.write(
        `chrome-fast: Chrome not reachable on port ${CHROME_PORT}; launching ${chrome} ` +
          `with profile ${CHROME_PROFILE}\n`
      );
      const child = spawn(chrome, chromeLaunchArgs(), { detached: true, stdio: "ignore" });
      child.on("error", () => {
        /* reported below as a timeout, with the actionable hint */
      });
      child.unref();
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await isChromeUp()) {
          process.stderr.write(`chrome-fast: Chrome is up on port ${CHROME_PORT}\n`);
          return;
        }
        await sleep(500);
      }
      throw new Error(
        `Launched Chrome but port ${CHROME_PORT} did not open within ${LAUNCH_TIMEOUT_MS / 1000}s. ` +
          `If a Chrome with profile ${CHROME_PROFILE} is already open without a debug port, close it and retry.`
      );
    })().finally(() => {
      launchPromise = null;
    });
  }
  await launchPromise;
}

/** Enable the domains every tool relies on and wire up per-connection event handling. */
async function setupClient(c: CDPClient, targetId: string): Promise<CDPClient> {
  await Promise.all([
    c.Page.enable(),
    c.Runtime.enable(),
    c.DOM.enable(),
    c.Accessibility.enable(),
    // Lifecycle events carry frame and loader IDs, which lets a wait target one
    // specific navigation instead of racing on a global "load" event.
    c.Page.setLifecycleEventsEnabled({ enabled: true }),
  ]);

  // An open JavaScript dialog blocks every other CDP command, so a page that
  // calls alert() or confirm() would otherwise hang every tool. alert and
  // beforeunload dialogs are accepted; confirm and prompt are dismissed, which
  // is the safe answer, and the agent is told what happened.
  c.on("Page.javascriptDialogOpening", (p: { type: string; message: string }) => {
    const accept = p.type === "alert" || p.type === "beforeunload";
    addNote(
      `A JavaScript ${p.type} dialog ("${p.message}") was ${accept ? "accepted" : "dismissed"} automatically.` +
        (accept
          ? ""
          : ` To accept such dialogs, run evaluate with "window.${p.type} = () => true" before the action.`)
    );
    c.Page.handleJavaScriptDialog({ accept }).catch(() => {});
  });

  c.on("disconnect", () => {
    // Only forget this connection if it is still the current one. A stale
    // socket closing late must not clobber a newer connection.
    if (client === c) {
      client = null;
      activeTargetId = null;
    }
  });

  client = c;
  activeTargetId = targetId;
  return c;
}

/**
 * Return the client for the current tab, connecting to Chrome first if needed.
 * Concurrent callers share one connection attempt.
 */
export async function getClient(): Promise<CDPClient> {
  if (client) return client;
  if (!connectPromise) {
    connectPromise = (async () => {
      await ensureChrome();
      try {
        const targets = await CDP.List(devtoolsOptions);
        let target = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
        // A freshly launched Chrome answers /json/version before it has a tab.
        if (!target) target = await CDP.New({ ...devtoolsOptions, url: "about:blank" });
        const c = await CDP({ ...devtoolsOptions, target });
        return await setupClient(c, target.id);
      } catch (err: any) {
        throw new Error(
          `Cannot connect to Chrome on port ${CHROME_PORT}. ` +
            `Run start-chrome-debug.bat, or let chrome-fast launch it (CHROME_AUTO_LAUNCH=1).\n` +
            `Error: ${err.message}`
        );
      }
    })().finally(() => {
      connectPromise = null;
    });
  }
  return connectPromise;
}

/** Attach to a specific tab, replacing the current connection, and bring it to the front. */
export async function connectToTarget(targetId: string): Promise<CDPClient> {
  await ensureChrome();
  const targets = await CDP.List(devtoolsOptions);
  const target = targets.find((t) => t.id === targetId);
  if (!target) {
    throw new Error(`No tab with target ID "${targetId}". Use the tabs tool to list open tabs.`);
  }
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Tab "${targetId}" cannot be debugged: another DevTools client is attached to it.`);
  }
  await disconnectClient();
  const c = await CDP({ ...devtoolsOptions, target });
  await setupClient(c, targetId);
  // Chrome stops painting tabs that are not visible, which stalls screenshots.
  await activateTarget(targetId).catch(() => {});
  return c;
}

export function getActiveTargetId(): string | null {
  return activeTargetId;
}

export async function listTargets(): Promise<any[]> {
  await ensureChrome();
  return CDP.List(devtoolsOptions);
}

export async function newTarget(url: string = "about:blank"): Promise<any> {
  await ensureChrome();
  return CDP.New({ ...devtoolsOptions, url });
}

export async function activateTarget(targetId: string): Promise<void> {
  await ensureChrome();
  await CDP.Activate({ ...devtoolsOptions, id: targetId });
}

export async function closeTarget(targetId: string): Promise<void> {
  await ensureChrome();
  await CDP.Close({ ...devtoolsOptions, id: targetId });
}

export async function disconnectClient(): Promise<void> {
  const c = client;
  client = null;
  activeTargetId = null;
  if (c) {
    try {
      await c.close();
    } catch {
      /* already closed */
    }
  }
}
