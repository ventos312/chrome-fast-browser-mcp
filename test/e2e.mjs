#!/usr/bin/env node
// End-to-end test for chrome-fast.
//
// Launches a headless Chrome with a throwaway profile, serves a few fixture
// pages on a local port, starts the MCP server over stdio and exercises every
// tool against it. Needs Google Chrome or Chromium installed (or CHROME_PATH).
//
//   npm run build && npm test

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

const homePage = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Home</title>
<style>body{font-family:sans-serif;margin:0;padding:16px} .spacer{height:3000px}</style></head>
<body>
<h1>Fixture Home</h1>
<p id="intro">Welcome to the fixture page for chrome-fast tests.</p>
<a id="second-link" href="/second">Go to second page</a>
<button id="show" onclick="document.getElementById('shown').textContent='Button was clicked'">Show message</button>
<span id="shown"></span>
<form id="search" action="/submitted" method="get">
  <label>Query <input id="q" name="q" value="old"></label>
  <label><input type="checkbox" id="agree" name="agree" value="yes"> Agree</label>
  <select id="color" name="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select>
  <textarea id="notes" name="notes"></textarea>
  <button type="submit" id="submit-btn">Submit</button>
</form>
<div id="editor" contenteditable="true">initial text</div>
<div style="position:relative;display:inline-block">
  <button id="covered" onclick="document.getElementById('covered-result').textContent='covered clicked'">Covered button</button>
  <div id="cover" style="position:absolute;inset:0;background:rgba(255,0,0,.4)"></div>
</div>
<span id="covered-result"></span>
<button id="confirm-btn" onclick="document.getElementById('confirm-result').textContent = confirm('Really?') ? 'confirm accepted' : 'confirm dismissed'">Confirm</button>
<span id="confirm-result"></span>
<button id="alert-btn" onclick="alert('Hello'); document.getElementById('alert-result').textContent='after alert'">Alert</button>
<span id="alert-result"></span>
<button id="delayed-btn" onclick="setTimeout(() => { const d = document.createElement('div'); d.id='delayed'; d.textContent='Delayed content arrived'; document.body.appendChild(d); }, 600)">Add delayed</button>
<button id="ajax" onclick="fetch('/slow-json').then(r => r.json()).then(j => { document.getElementById('ajax-result').textContent = j.msg })">Save via ajax</button>
<span id="ajax-result"></span>
<div class="spacer"></div>
<button id="far" onclick="document.getElementById('far-result').textContent='far clicked'">Far down button</button>
<span id="far-result"></span>
<a id="hash-link" href="#bottom">Jump to bottom</a>
<div id="bottom"></div>
<section id="filler">${Array.from({ length: 30 }, (_, i) => `<p>Filler paragraph ${i + 1} keeps this fixture above the small-page threshold so actions report changes.</p>`).join("")}</section>
<script>
  // Mimic React's value tracking: it shadows the value property on the instance,
  // so a plain "el.value = x" followed by an input event looks like no change.
  const q = document.getElementById('q');
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let tracked = q.value;
  Object.defineProperty(q, 'value', {
    configurable: true,
    get() { return proto.get.call(q); },
    set(v) { tracked = String(v); proto.set.call(q, v); },
  });
  q.addEventListener('input', () => {
    if (q.value !== tracked) { tracked = q.value; window.__reactSawChange = true; }
  });
</script>
</body></html>`;

const secondPage = `<!doctype html><html><head><title>Second Page</title></head>
<body><h1>Second</h1><p>You made it to the second page.</p><a href="/">Home</a></body></html>`;

const tallPage = `<!doctype html><html><head><title>Tall Page</title></head>
<body style="margin:0"><div style="height:5000px;background:linear-gradient(red,blue)"></div></body></html>`;

const routes = {
  "/": () => [200, homePage],
  "/second": () => [200, secondPage],
  "/tall": () => [200, tallPage],
  "/missing": () => [404, `<!doctype html><html><head><title>Not Found</title></head><body><h1>Nope</h1></body></html>`],
  "/menu": () => [
    200,
    `<!doctype html><html><head><title>Menu Page</title></head><body><nav aria-label="Main menu">${Array.from(
      { length: 40 },
      (_, i) => `<a href="#i${i + 1}">Item ${i + 1}</a>`
    ).join(" ")}</nav><h1>Menu page</h1><p>Content after the menu</p></body></html>`,
  ],
  "/long": () => [
    200,
    `<!doctype html><html><head><title>Long Page</title></head><body><h1>Long page</h1>${Array.from(
      { length: 400 },
      (_, i) => `<p>Paragraph ${i + 1}: ${"lorem ipsum dolor sit amet ".repeat(3)}</p>`
    ).join("")}<a href="/second">Bottom link</a></body></html>`,
  ],
  // Everything hidden from assistive technology, as some sites leave their page after a modal closed
  "/hidden": () => [
    200,
    `<!doctype html><html><head><title>Hidden Page</title></head><body><div aria-hidden="true"><h1>Hidden from AT</h1><p>Body text</p><a id="hl" href="/second">Hidden link</a><button id="hb" onclick="this.textContent='hb clicked'">Hidden button</button></div><div role="dialog" aria-modal="true" style="position:fixed;opacity:0;width:1px;height:1px"></div></body></html>`,
  ],
  "/dirty": () => [
    200,
    `<!doctype html><html><head><title>Dirty Page</title></head><body><h1>Dirty</h1><input id="f" value=""><a id="away" href="/second">Leave</a><script>window.addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script></body></html>`,
  ],
  "/submitted": (url) => {
    const q = url.searchParams;
    return [
      200,
      `<!doctype html><html><head><title>Submitted</title></head><body><p id="echo">q=${q.get("q")} agree=${q.get("agree")} color=${q.get("color")} notes=${q.get("notes")}</p></body></html>`,
    ];
  },
};

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`<!doctype html><html><head><title>Slow</title></head><body><p>Slow page</p></body></html>`);
        }, 1200);
        return;
      }
      if (url.pathname === "/slow-json") {
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ msg: "saved via ajax" }));
        }, 300);
        return;
      }
      const route = routes[url.pathname];
      if (!route) {
        res.writeHead(404).end("not found");
        return;
      }
      const [status, body] = route(url);
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
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
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForDevtools(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome did not open its DevTools port ${port} within ${timeoutMs} ms`);
}

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

const results = [];
async function test(name, fn) {
  const started = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("test timed out after 30 s")), 30_000)),
    ]);
    results.push({ name, ok: true });
    console.log(`  ok    ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL  ${name} (${Date.now() - started} ms)\n        ${err.message.split("\n").join("\n        ")}`);
  }
}

const textOf = (result) =>
  result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

const refOf = (snapshot, pattern) => {
  const match = snapshot.match(new RegExp(`\\[(\\d+)\\] ${pattern}`));
  assert.ok(match, `no element matching /${pattern}/ in snapshot:\n${snapshot}`);
  return match[1];
};

const pngSize = (base64) => {
  const buf = Buffer.from(base64, "base64");
  assert.equal(buf.toString("hex", 1, 4), "504e47", "not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
};

// ---------------------------------------------------------------------------
// HTTP mode and process lifecycle
// ---------------------------------------------------------------------------

const serverScript = path.join(root, "dist", "index.js");

async function waitForHealth(port, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`HTTP server on port ${port} did not come up`);
}

const waitForExit = (proc, timeoutMs) =>
  Promise.race([
    new Promise((resolve) => proc.once("exit", (code) => resolve(code ?? "signal"))),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
  ]);

async function runHttpTests(chromePort) {
  const baseEnv = { ...process.env, CHROME_PORT: String(chromePort), CHROME_AUTO_LAUNCH: "0", MCP_HTTP_HOST: "127.0.0.1" };

  // Plain server started with the --http flag
  const httpPort = await freePort();
  const server = spawn(process.execPath, [serverScript, "--http", String(httpPort)], {
    env: baseEnv,
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForHealth(httpPort);

    await test("--http serves /health and 404s unknown paths", async () => {
      assert.equal(await (await fetch(`http://127.0.0.1:${httpPort}/health`)).text(), "ok");
      assert.equal((await fetch(`http://127.0.0.1:${httpPort}/nope`)).status, 404);
    });

    await test("Streamable HTTP transport at /mcp", async () => {
      const client = new Client({ name: "chrome-fast-e2e-http", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${httpPort}/mcp`)));
      assert.match(textOf(await client.callTool({ name: "tabs", arguments: {} })), /\(active\)/);
      assert.equal(textOf(await client.callTool({ name: "evaluate", arguments: { expression: "1 + 1" } })), "2");
      await client.close();
    });

    await test("legacy SSE transport at /sse", async () => {
      const client = new Client({ name: "chrome-fast-e2e-sse", version: "1.0.0" });
      await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${httpPort}/sse`)));
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "navigate"));
      assert.equal(textOf(await client.callTool({ name: "evaluate", arguments: { expression: "2 + 2" } })), "4");
      await client.close();
    });
  } finally {
    server.kill();
  }

  // Server started through MCP_HTTP_PORT with a bearer token
  const tokenPort = await freePort();
  const tokenServer = spawn(process.execPath, [serverScript], {
    env: { ...baseEnv, MCP_HTTP_PORT: String(tokenPort), MCP_HTTP_TOKEN: "s3cret" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    await waitForHealth(tokenPort);

    await test("MCP_HTTP_TOKEN rejects requests without the token", async () => {
      const res = await fetch(`http://127.0.0.1:${tokenPort}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      assert.equal(res.status, 401);
      assert.equal((await fetch(`http://127.0.0.1:${tokenPort}/sse`)).status, 401);
    });

    await test("MCP_HTTP_TOKEN accepts the bearer token", async () => {
      const client = new Client({ name: "chrome-fast-e2e-token", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${tokenPort}/mcp`), {
          requestInit: { headers: { Authorization: "Bearer s3cret" } },
        })
      );
      assert.equal(textOf(await client.callTool({ name: "evaluate", arguments: { expression: "3 + 3" } })), "6");
      await client.close();
    });
  } finally {
    tokenServer.kill();
  }
}

async function runStdioShutdownTest(chromePort) {
  await test("stdio server exits when the client closes stdin", async () => {
    const proc = spawn(process.execPath, [serverScript], {
      env: { ...process.env, CHROME_PORT: String(chromePort), CHROME_AUTO_LAUNCH: "0" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffered = "";
    const responses = new Map();
    proc.stdout.on("data", (chunk) => {
      buffered += chunk;
      const lines = buffered.split("\n");
      buffered = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id !== undefined) responses.set(msg.id, msg);
      }
    });
    const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");
    const awaitResponse = async (id) => {
      const deadline = Date.now() + 10_000;
      while (!responses.has(id)) {
        if (Date.now() > deadline) throw new Error(`no response for request ${id}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      return responses.get(id);
    };

    try {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } },
      });
      await awaitResponse(1);
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      // Attach to Chrome so an open WebSocket is keeping the event loop alive
      send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tabs", arguments: {} } });
      const tabs = await awaitResponse(2);
      const listing = tabs.result.content[0].text;
      assert.match(listing, /\(active\)/);
      // A fresh server prefers an empty tab over one left mid-task
      const lines = listing.split("\n");
      const activeIndex = lines.findIndex((l) => l.includes("(active)"));
      assert.match(lines[activeIndex + 1], /about:blank/, `expected the blank tab to be chosen:\n${listing}`);

      proc.stdin.end();
      const code = await waitForExit(proc, 5000);
      assert.notEqual(code, "timeout", "server kept running after stdin closed");
    } finally {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.error("No Chrome found. Install Google Chrome or set CHROME_PATH.");
    process.exit(2);
  }

  const fixtures = await startFixtureServer();
  const base = `http://127.0.0.1:${fixtures.address().port}`;
  const port = await freePort();
  const profile = mkdtempSync(path.join(tmpdir(), "chrome-fast-e2e-"));

  console.log(`Chrome: ${chromePath}`);
  console.log(`Fixtures: ${base}`);
  const chrome = spawn(
    chromePath,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--no-sandbox",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: "ignore" }
  );
  chrome.on("error", (err) => {
    console.error(`Could not start Chrome: ${err.message}`);
    process.exit(2);
  });

  let client;
  try {
    await waitForDevtools(port);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(root, "dist", "index.js")],
      env: { ...process.env, CHROME_PORT: String(port), CHROME_AUTO_LAUNCH: "0" },
      stderr: "inherit",
    });
    client = new Client({ name: "chrome-fast-e2e", version: "1.0.0" });
    await client.connect(transport);
    const call = (name, args = {}) => client.callTool({ name, arguments: args });

    await test("tools are listed with parameter descriptions", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      assert.deepEqual(names, [
        "batch", "click", "evaluate", "fill_form", "get_page", "navigate", "screenshot", "scroll",
        "tab_close", "tab_new", "tab_switch", "tabs", "type", "wait",
      ]);
      const click = tools.find((t) => t.name === "click");
      assert.match(click.inputSchema.properties.selector.description, /ref number/);
    });

    await test("server instructions explain refs and the debug port setup", async () => {
      const instructions = client.getInstructions();
      assert.match(instructions, /get_page again/);
      assert.match(instructions, /CHROME_DEBUG_ADDRESS/);
    });

    await test("tabs marks the attached tab as active", async () => {
      const out = textOf(await call("tabs"));
      assert.match(out, /\(active\)/);
    });

    let home;
    await test("navigate returns title, text and element refs", async () => {
      home = textOf(await call("navigate", { url: `${base}/` }));
      assert.match(home, /^Page: Fixture Home/m);
      assert.match(home, /text "Welcome to the fixture page for chrome-fast tests\."/);
      assert.match(home, /\[\d+\] link "Go to second page"/);
      assert.match(home, /\[\d+\] textbox "Query" value="old"/);
      assert.match(home, /\[\d+\] heading "Fixture Home" level=1/);
    });

    await test("unchecked checkbox is not reported as checked", async () => {
      const line = home.split("\n").find((l) => /checkbox "Agree"/.test(l));
      assert.ok(line, "checkbox line missing");
      assert.doesNotMatch(line, /checked/);
    });

    await test("interactive format omits text lines", async () => {
      const out = textOf(await call("get_page", { format: "interactive" }));
      assert.doesNotMatch(out, /^text "/m);
      assert.match(out, /\[\d+\] link "Go to second page"/);
    });

    await test("html format returns markup", async () => {
      const out = textOf(await call("get_page", { format: "html" }));
      assert.match(out, /^<html/);
      assert.match(out, /id="intro"/);
    });

    await test("repeated navigation to a cached page does not hang", async () => {
      for (let i = 0; i < 3; i++) {
        const out = textOf(await call("navigate", { url: `${base}/second` }));
        assert.match(out, /^Page: Second Page/m);
      }
    });

    await test("same-document navigation (hash change) returns at once", async () => {
      const out = textOf(await call("navigate", { url: `${base}/second#x` }));
      assert.match(out, /^URL: .*\/second#x/m);
    });

    await test("navigate waitUntil networkidle on a slow page", async () => {
      const out = textOf(await call("navigate", { url: `${base}/slow`, waitUntil: "networkidle" }));
      assert.match(out, /^Page: Slow/m);
      assert.match(out, /text "Slow page"/);
    });

    await test("navigate reports a connection failure as an error", async () => {
      const result = await call("navigate", { url: "http://127.0.0.1:1/" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /failed/);
    });

    await test("navigate still returns a 404 page", async () => {
      const result = await call("navigate", { url: `${base}/missing` });
      assert.notEqual(result.isError, true);
      assert.match(textOf(result), /^Page: Not Found/m);
    });

    await test("bare host gets a scheme", async () => {
      const result = await call("navigate", { url: `127.0.0.1:${fixtures.address().port}/second` });
      assert.match(textOf(result), /^Page: Second Page/m);
    });

    await test("click on a link waits for the new page", async () => {
      home = textOf(await call("navigate", { url: `${base}/` }));
      const ref = refOf(home, 'link "Go to second page"');
      const out = textOf(await call("click", { selector: ref }));
      assert.match(out, /^Page: Second Page/m);
      assert.match(out, /text "You made it to the second page\."/);
    });

    await test("click by CSS selector runs the handler", async () => {
      await call("navigate", { url: `${base}/` });
      const out = textOf(await call("click", { selector: "#show" }));
      assert.match(out, /text "Button was clicked"/);
    });

    await test("click on a covered element falls back to a DOM click", async () => {
      const out = textOf(await call("click", { selector: "#covered" }));
      assert.match(out, /text "covered clicked"/);
      assert.match(out, /Note: .*covered/);
    });

    await test("click scrolls an off-screen element into view", async () => {
      const before = textOf(await call("evaluate", { expression: "window.scrollY" }));
      assert.equal(before, "0");
      const out = textOf(await call("click", { selector: "#far" }));
      assert.match(out, /text "far clicked"/);
      const after = Number(textOf(await call("evaluate", { expression: "window.scrollY" })));
      assert.ok(after > 1000, `expected the page to have scrolled, scrollY=${after}`);
    });

    await test("click on a hash link is treated as same-document navigation", async () => {
      const out = textOf(await call("click", { selector: "#hash-link" }));
      assert.match(out, /^URL: .*#bottom/m);
    });

    await test("type with clear and Enter submits the form", async () => {
      await call("navigate", { url: `${base}/` });
      const out = textOf(await call("type", { selector: "#q", text: "hello world", clear: true, pressEnter: true }));
      assert.match(out, /^Page: Submitted/m);
      assert.match(out, /q=hello world/);
    });

    await test("type with clear replaces contenteditable content", async () => {
      await call("navigate", { url: `${base}/` });
      await call("type", { selector: "#editor", text: "replaced", clear: true });
      const value = textOf(await call("evaluate", { expression: "document.getElementById('editor').textContent" }));
      assert.equal(value, "replaced");
    });

    await test("type appends without clear", async () => {
      await call("type", { selector: "#q", text: "+more" });
      const value = textOf(await call("evaluate", { expression: "document.getElementById('q').value" }));
      assert.equal(value, "old+more");
    });

    await test("fill_form sets inputs, checkbox, select by label and textarea", async () => {
      await call("navigate", { url: `${base}/` });
      const out = textOf(
        await call("fill_form", {
          fields: [
            { selector: "#q", value: "filled" },
            { selector: "#agree", value: "true" },
            { selector: "#color", value: "Green" },
            { selector: "#notes", value: "some notes" },
          ],
        })
      );
      assert.match(out, /textbox "Query" value="filled"/);
      const state = JSON.parse(
        textOf(
          await call("evaluate", {
            expression:
              "JSON.stringify({ q: document.getElementById('q').value, react: !!window.__reactSawChange, agree: document.getElementById('agree').checked, color: document.getElementById('color').value, notes: document.getElementById('notes').value })",
          })
        )
      );
      assert.deepEqual(state, { q: "filled", react: true, agree: true, color: "g", notes: "some notes" });
    });

    await test("fill_form reports an unknown select option", async () => {
      const result = await call("fill_form", { fields: [{ selector: "#color", value: "Purple" }] });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no option matches "Purple"/);
    });

    await test("fill_form with submit navigates", async () => {
      const out = textOf(
        await call("fill_form", {
          fields: [{ selector: "#q", value: "submitted via form" }],
          submit: true,
        })
      );
      assert.match(out, /^Page: Submitted/m);
      assert.match(out, /q=submitted via form agree=yes color=g/);
    });

    await test("evaluate supports top-level await", async () => {
      const out = textOf(await call("evaluate", { expression: "await new Promise(r => setTimeout(() => r(42), 10))" }));
      assert.equal(out, "42");
    });

    await test("evaluate allows re-declaring let across calls", async () => {
      assert.equal(textOf(await call("evaluate", { expression: "let x = 1; x + 1" })), "2");
      assert.equal(textOf(await call("evaluate", { expression: "let x = 5; x * 2" })), "10");
    });

    await test("evaluate keeps supporting a top-level return", async () => {
      assert.equal(textOf(await call("evaluate", { expression: "const v = 3; return v + 4;" })), "7");
    });

    await test("evaluate returns objects as JSON and errors as isError", async () => {
      const obj = JSON.parse(textOf(await call("evaluate", { expression: "({ a: 1, b: [1, 2] })" })));
      assert.deepEqual(obj, { a: 1, b: [1, 2] });
      assert.equal(textOf(await call("evaluate", { expression: "undefined" })), "undefined");
      assert.equal(textOf(await call("evaluate", { expression: "null" })), "null");
      assert.equal(textOf(await call("evaluate", { expression: "true" })), "true");
      assert.equal(textOf(await call("evaluate", { expression: "'text'" })), "text");
      const failed = await call("evaluate", { expression: "throw new Error('boom')" });
      assert.equal(failed.isError, true);
      assert.match(textOf(failed), /boom/);
    });

    await test("evaluate settles a promise the expression evaluates to", async () => {
      assert.equal(textOf(await call("evaluate", { expression: "Promise.resolve(9)" })), "9");
      assert.equal(
        textOf(await call("evaluate", { expression: `fetch(${JSON.stringify(base + "/second")}).then(r => r.status)` })),
        "200"
      );
      const rejected = await call("evaluate", { expression: "Promise.reject(new Error('nope'))" });
      assert.equal(rejected.isError, true);
      assert.match(textOf(rejected), /nope/);
    });

    await test("evaluate renders DOM nodes, collections, Maps and cycles", async () => {
      await call("navigate", { url: `${base}/` });
      assert.match(textOf(await call("evaluate", { expression: "document.getElementById('intro')" })), /^<p id="intro">Welcome/);
      const links = JSON.parse(textOf(await call("evaluate", { expression: "document.querySelectorAll('a')" })));
      assert.equal(links[0], "<a#second-link>");
      assert.deepEqual(JSON.parse(textOf(await call("evaluate", { expression: "new Map([['k', 1]])" }))), { k: 1 });
      assert.match(textOf(await call("evaluate", { expression: "const o = { n: 1 }; o.self = o; o" })), /\[Circular\]/);
      assert.equal(textOf(await call("evaluate", { expression: "() => 1" })), "() => 1");
    });

    await test("evaluate exposes console helpers like $$", async () => {
      await call("navigate", { url: `${base}/` });
      const count = Number(textOf(await call("evaluate", { expression: "$$('a').length" })));
      assert.ok(count >= 2, `expected at least two links, got ${count}`);
    });

    await test("screenshot returns a PNG of the viewport", async () => {
      const result = await call("screenshot");
      assert.equal(result.content[0].type, "image");
      assert.equal(result.content[0].mimeType, "image/png");
      const { width, height } = pngSize(result.content[0].data);
      assert.ok(width > 100 && height > 100, `unexpected size ${width}x${height}`);
      assert.ok(height < 2000, `viewport screenshot should not be taller than the window, got ${height}`);
    });

    await test("screenshot fullPage captures beyond the viewport", async () => {
      await call("navigate", { url: `${base}/tall` });
      const result = await call("screenshot", { fullPage: true });
      const { height } = pngSize(result.content[0].data);
      assert.ok(height >= 4500, `full-page screenshot should be about 5000px tall, got ${height}`);
    });

    await test("screenshot jpeg honours the format", async () => {
      const result = await call("screenshot", { format: "jpeg", quality: 50 });
      assert.equal(result.content[0].mimeType, "image/jpeg");
      assert.equal(Buffer.from(result.content[0].data, "base64").toString("hex", 0, 2), "ffd8");
    });

    await test("wait for a selector that appears later", async () => {
      await call("navigate", { url: `${base}/` });
      await call("click", { selector: "#delayed-btn" });
      const out = textOf(await call("wait", { selector: "#delayed", timeout: 3000 }));
      assert.match(out, /text "Delayed content arrived"/);
    });

    await test("wait for text", async () => {
      const out = textOf(await call("wait", { text: "Delayed content arrived", timeout: 1000 }));
      assert.match(out, /^Page: Fixture Home/m);
    });

    await test("wait times out with an error", async () => {
      const result = await call("wait", { selector: "#does-not-exist", timeout: 300 });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Timeout/);
    });

    await test("wait rejects an invalid selector immediately", async () => {
      const started = Date.now();
      const result = await call("wait", { selector: ">>>bad", timeout: 5000 });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Invalid wait condition/);
      assert.ok(Date.now() - started < 2000, "should not have waited for the timeout");
    });

    await test("wait for network idle and fixed time", async () => {
      assert.match(textOf(await call("wait", { networkIdle: true, timeout: 3000 })), /^Page:/m);
      assert.match(textOf(await call("wait", { time: 100 })), /^Page:/m);
    });

    await test("scroll moves the page and scrolls elements into view", async () => {
      await call("navigate", { url: `${base}/` });
      await call("scroll", { direction: "down", amount: 700 });
      assert.equal(textOf(await call("evaluate", { expression: "window.scrollY" })), "700");
      await call("scroll", { selector: "#far" });
      const y = Number(textOf(await call("evaluate", { expression: "window.scrollY" })));
      assert.ok(y > 2000, `expected #far to be scrolled into view, scrollY=${y}`);
    });

    await test("confirm dialogs are dismissed automatically and reported", async () => {
      await call("navigate", { url: `${base}/` });
      const out = textOf(await call("click", { selector: "#confirm-btn" }));
      assert.match(out, /Note: A JavaScript confirm dialog \("Really\?"\) was dismissed automatically/);
      assert.match(out, /text "confirm dismissed"/);
    });

    await test("alert dialogs are accepted automatically", async () => {
      const out = textOf(await call("click", { selector: "#alert-btn" }));
      assert.match(out, /Note: A JavaScript alert dialog \("Hello"\) was accepted automatically/);
      assert.match(out, /text "after alert"/);
    });

    await test("errors are flagged with isError", async () => {
      const result = await call("click", { selector: "9999" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Ref \[9999\] not found/);
      const missing = await call("click", { selector: "#no-such-element" });
      assert.equal(missing.isError, true);
    });

    await test("tab_new, tabs, tab_close keep track of the active tab", async () => {
      const firstTabs = textOf(await call("tabs"));
      const firstId = firstTabs.match(/^\[([^\]]+)\] \(active\)/m)[1];

      const opened = textOf(await call("tab_new", { url: `${base}/second` }));
      assert.match(opened, /^Page: Second Page/m);

      const twoTabs = textOf(await call("tabs"));
      const ids = [...twoTabs.matchAll(/^\[([^\]]+)\]/gm)].map((m) => m[1]);
      assert.equal(ids.length, 2, `expected two tabs:\n${twoTabs}`);
      const activeLine = twoTabs.split("\n").find((l) => l.includes("(active)"));
      assert.match(activeLine, /Second Page/);
      const secondId = activeLine.match(/^\[([^\]]+)\]/)[1];
      assert.notEqual(secondId, firstId);

      // Closing another tab must not move the attachment
      const closedOther = textOf(await call("tab_close", { targetId: firstId }));
      assert.match(closedOther, /Still attached/);
      await new Promise((r) => setTimeout(r, 300));
      const oneTab = textOf(await call("tabs"));
      assert.equal([...oneTab.matchAll(/^\[([^\]]+)\]/gm)].length, 1, `expected one tab:\n${oneTab}`);
      assert.match(oneTab, /\(active\) Second Page/);

      // Closing the current tab attaches to a remaining one
      await call("tab_new", {});
      const closedCurrent = textOf(await call("tab_close", {}));
      assert.match(closedCurrent, /Tab closed\. Switched to: /);
      assert.match(textOf(await call("tabs")), /\(active\) Second Page/);
    });

    await test("tab_switch to an unknown id is an error", async () => {
      const result = await call("tab_switch", { targetId: "nope" });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /No tab with target ID/);
    });

    await test("closed select lists a count instead of its options", async () => {
      const out = textOf(await call("navigate", { url: `${base}/` }));
      assert.match(out, /\[\d+\] combobox value="Red" collapsed \(3 options\)/);
      assert.doesNotMatch(out, /option "Red"/);
    });

    await test("refs stay stable while the page changes", async () => {
      const before = textOf(await call("navigate", { url: `${base}/` }));
      const showRef = refOf(before, 'button "Show message"');
      await call("click", { selector: "#delayed-btn" });
      await call("wait", { selector: "#delayed", timeout: 3000 });
      const after = textOf(await call("get_page"));
      assert.equal(refOf(after, 'button "Show message"'), showRef);
      assert.match(after, /text "Delayed content arrived"/);
    });

    await test("actions report what changed instead of the whole page", async () => {
      await call("navigate", { url: `${base}/` });
      const typed = textOf(await call("type", { selector: "#q", text: "changed", clear: true }));
      assert.match(typed, /^Changes since the previous snapshot/m);
      assert.match(typed, /^- \[\d+\] textbox "Query" value="old"/m);
      assert.match(typed, /^\+ \[\d+\] textbox "Query" value="changed"/m);
      assert.doesNotMatch(typed, /text "Welcome to the fixture page/);
      const scrolled = textOf(await call("scroll", { direction: "down", amount: 100 }));
      assert.match(scrolled, /No visible change on the page/);
    });

    await test("click reports background requests it triggered", async () => {
      await call("navigate", { url: `${base}/` });
      const out = textOf(await call("click", { selector: "#ajax" }));
      assert.match(out, /Note: No navigation; 1 background request finished: GET \/slow-json → 200\./);
      assert.match(out, /^\+ text "saved via ajax"/m);
    });

    await test("long navigation menus are shortened unless expanded", async () => {
      const out = textOf(await call("navigate", { url: `${base}/menu` }));
      assert.equal((out.match(/link "Item \d+"/g) || []).length, 10);
      assert.match(out, /… 30 more links in navigation "Main menu" not shown/);
      assert.match(out, /heading "Menu page"/);
      const full = textOf(await call("get_page", { expandMenus: true }));
      assert.equal((full.match(/link "Item \d+"/g) || []).length, 40);
    });

    await test("long pages are cut at the output limit and continue with offset", async () => {
      const first = textOf(await call("navigate", { url: `${base}/long` }));
      assert.ok(first.length < 22_000, `first chunk is ${first.length} chars`);
      const note = first.match(/… (\d+) more lines not shown .* offset: (\d+) to continue/);
      assert.ok(note, `no truncation note in:\n${first.slice(-300)}`);
      const next = textOf(await call("get_page", { offset: Number(note[2]) }));
      assert.match(next, new RegExp(`^\\(continuing at line ${note[2]} of`, "m"));
      assert.doesNotMatch(next, /text "Paragraph 1:/);
      assert.match(next, /text "Paragraph \d+:/);
    });

    await test("falls back to the DOM when the accessibility tree is hidden", async () => {
      const out = textOf(await call("navigate", { url: `${base}/hidden` }));
      assert.match(out, /Note: The accessibility tree is empty: .*This snapshot was built from the DOM instead\./);
      assert.match(out, /\[\d+\] heading "Hidden from AT" level=1/);
      assert.match(out, /text "Body text"/);
      assert.match(out, /\[\d+\] link "Hidden link"/);
      const ref = refOf(out, 'button "Hidden button"');
      const clicked = textOf(await call("click", { selector: ref }));
      assert.match(clicked, /button "hb clicked"/);
      const dom = textOf(await call("get_page", { format: "dom" }));
      assert.match(dom, /\[\d+\] link "Hidden link"/);
    });

    await test("navigating away from unsaved changes is cancelled unless forced", async () => {
      await call("navigate", { url: `${base}/dirty` });
      // A real click gives the page the user activation it needs to show the prompt
      await call("click", { selector: "#f" });
      const refused = textOf(await call("navigate", { url: `${base}/second` }));
      assert.match(refused, /Note: The page has unsaved changes and asked to confirm leaving/);
      assert.match(refused, /^Page: Dirty Page/m);
      const forced = textOf(await call("navigate", { url: `${base}/second`, force: true }));
      assert.match(forced, /^Page: Second Page/m);
    });

    await test("tab_close keeps a tab with unsaved changes unless forced", async () => {
      await call("navigate", { url: `${base}/dirty` });
      await call("click", { selector: "#f" });
      const refused = textOf(await call("tab_close", {}));
      assert.match(refused, /The tab was not closed: it has unsaved changes/);
      assert.match(textOf(await call("tabs")), /\(active\) Dirty Page/);
      await call("tab_new", { url: `${base}/second` });
      const tabs = textOf(await call("tabs"));
      const dirtyId = tabs.split("\n").find((l) => l.includes("Dirty Page")).match(/^\[([^\]]+)\]/)[1];
      await call("tab_switch", { targetId: dirtyId });
      await call("click", { selector: "#f" });
      const closed = textOf(await call("tab_close", { force: true }));
      assert.match(closed, /^Tab closed\. Switched to: /);
    });

    await test("batch runs several steps and returns the page once", async () => {
      await call("navigate", { url: `${base}/` });
      const out = textOf(
        await call("batch", {
          steps: [
            { tool: "type", args: { selector: "#q", text: "batched", clear: true } },
            { tool: "click", args: { selector: "#show" } },
            { tool: "evaluate", args: { expression: "1 + 2" } },
          ],
        })
      );
      assert.match(out, /^Batch: all 3 steps completed\./m);
      assert.match(out, /^3\. evaluate .* ok: 3$/m);
      assert.match(out, /^\+ \[\d+\] textbox "Query" value="batched"/m);
      assert.match(out, /^\+ text "Button was clicked"/m);
    });

    await test("batch stops at the first failing step", async () => {
      const result = await call("batch", {
        steps: [
          { tool: "click", args: { selector: "#show" } },
          { tool: "click", args: { selector: "#does-not-exist" } },
          { tool: "click", args: { selector: "#show" } },
        ],
      });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Batch stopped: step 2 \(click\) failed: .*No element found/);
      assert.match(textOf(result), /1 of 3 steps completed/);
    });

    await test("batch validates step arguments and returns a full page after navigation", async () => {
      const bad = await call("batch", { steps: [{ tool: "navigate", args: {} }] });
      assert.equal(bad.isError, true);
      assert.match(textOf(bad), /step 1 \(navigate\) has invalid arguments/);
      const out = textOf(await call("batch", { steps: [{ tool: "navigate", args: { url: `${base}/second` } }] }));
      assert.match(out, /^Page: Second Page/m);
      assert.match(out, /text "You made it to the second page\."/);
    });

    await runHttpTests(port);

    // Leave a blank tab next to a content tab, with the content tab active, so
    // the fresh server below has to choose.
    await call("tab_new", {});
    const tabsNow = textOf(await call("tabs"));
    const contentId = tabsNow.split("\n").find((l) => l.includes("Second Page")).match(/^\[([^\]]+)\]/)[1];
    await call("tab_switch", { targetId: contentId });
    await runStdioShutdownTest(port);
  } finally {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    chrome.kill();
    fixtures.close();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(profile, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
