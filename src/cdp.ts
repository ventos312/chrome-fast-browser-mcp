import CDP from "chrome-remote-interface";
import { spawn } from "child_process";
import { existsSync } from "fs";
import http from "http";
import path from "path";

const CHROME_PORT = parseInt(process.env.CHROME_PORT || "9222", 10);
const CHROME_PROFILE =
  process.env.CHROME_PROFILE ||
  path.join(
    process.env.LOCALAPPDATA || process.env.HOME || ".",
    "NanoClaw",
    "ChromeProfile"
  );
// Set CHROME_AUTO_LAUNCH=0 to disable launching Chrome automatically.
const AUTO_LAUNCH = (process.env.CHROME_AUTO_LAUNCH || "1") !== "0";

let client: any = null;
let activeTargetId: string | null = null;
let launchPromise: Promise<void> | null = null;

function findChrome(): string | null {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
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
      { host: "127.0.0.1", port: CHROME_PORT, path: "/json/version", timeout: 1500 },
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Make sure a debuggable Chrome is listening on CHROME_PORT.
 * If it is not, launch one with the same flags as start-chrome-debug.bat
 * (same isolated profile, so logins persist) and wait for the port to open.
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
          `Chrome not reachable on port ${CHROME_PORT} and no chrome.exe found. ` +
            `Set CHROME_PATH or run start-chrome-debug.bat.`
        );
      }
      process.stderr.write(
        `chrome-fast: Chrome not reachable on port ${CHROME_PORT}; launching ${chrome} ` +
          `with profile ${CHROME_PROFILE}\n`
      );
      const child = spawn(
        chrome,
        [
          `--remote-debugging-port=${CHROME_PORT}`,
          "--remote-debugging-address=0.0.0.0",
          "--remote-allow-origins=*",
          `--user-data-dir=${CHROME_PROFILE}`,
          "--no-first-run",
          "--no-default-browser-check",
        ],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (await isChromeUp()) {
          process.stderr.write(`chrome-fast: Chrome is up on port ${CHROME_PORT}\n`);
          return;
        }
        await sleep(500);
      }
      throw new Error(
        `Launched Chrome but port ${CHROME_PORT} did not open within 30s. ` +
          `If a Chrome with profile ${CHROME_PROFILE} is already open without a debug port, close it and retry.`
      );
    })().finally(() => {
      launchPromise = null;
    });
  }
  await launchPromise;
}

export async function getClient(): Promise<any> {
  if (client) return client;
  await ensureChrome();
  try {
    client = await CDP({ port: CHROME_PORT });
    activeTargetId = (client as any).target?.id ?? null;

    // Enable essential domains
    await Promise.all([
      client.Page.enable(),
      client.Runtime.enable(),
      client.DOM.enable(),
      client.Accessibility.enable(),
    ]);

    client.on("disconnect", () => {
      client = null;
      activeTargetId = null;
    });

    return client;
  } catch (err: any) {
    throw new Error(
      `Cannot connect to Chrome on port ${CHROME_PORT}. ` +
        `Run start-chrome-debug.bat, or let chrome-fast launch it (CHROME_AUTO_LAUNCH=1).\n` +
        `Error: ${err.message}`
    );
  }
}

export async function connectToTarget(targetId: string): Promise<any> {
  await ensureChrome();
  if (client) {
    try { await client.close(); } catch {}
    client = null;
  }
  client = await CDP({ port: CHROME_PORT, target: targetId });
  activeTargetId = targetId;
  await Promise.all([
    client.Page.enable(),
    client.Runtime.enable(),
    client.DOM.enable(),
    client.Accessibility.enable(),
  ]);
  client.on("disconnect", () => {
    client = null;
    activeTargetId = null;
  });
  return client;
}

export function getActiveTargetId(): string | null {
  return activeTargetId;
}

export async function listTargets(): Promise<any[]> {
  await ensureChrome();
  return CDP.List({ port: CHROME_PORT });
}

export async function newTarget(url: string = "about:blank"): Promise<any> {
  await ensureChrome();
  return CDP.New({ port: CHROME_PORT, url });
}

export async function activateTarget(targetId: string): Promise<void> {
  await ensureChrome();
  await CDP.Activate({ port: CHROME_PORT, id: targetId });
}

export async function closeTarget(targetId: string): Promise<void> {
  await ensureChrome();
  await CDP.Close({ port: CHROME_PORT, id: targetId });
}

export async function disconnectClient(): Promise<void> {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    activeTargetId = null;
  }
}
