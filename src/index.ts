#!/usr/bin/env node
import http from "http";
import { randomUUID, timingSafeEqual } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  AUTO_LAUNCH,
  CHROME_DEBUG_ADDRESS,
  CHROME_PORT,
  debugPortIsLocalOnly,
  describeChromeSetup,
  disconnectClient,
} from "./cdp.js";
import { navigateToolDef, handleNavigate } from "./tools/navigate.js";
import {
  getPageToolDef,
  screenshotToolDef,
  evaluateToolDef,
  handleGetPage,
  handleScreenshot,
  handleEvaluate,
} from "./tools/page.js";
import {
  clickToolDef,
  typeToolDef,
  scrollToolDef,
  fillFormToolDef,
  handleClick,
  handleType,
  handleScroll,
  handleFillForm,
} from "./tools/interact.js";
import {
  tabsToolDef,
  tabNewToolDef,
  tabSwitchToolDef,
  tabCloseToolDef,
  handleTabs,
  handleTabNew,
  handleTabSwitch,
  handleTabClose,
} from "./tools/tabs.js";
import { waitToolDef, handleWait } from "./tools/wait.js";
import { createBatchTool } from "./tools/batch.js";

const VERSION = "1.2.0";

// Sent to MCP clients on connect, so the agent driving the browser knows how
// the tools fit together and what the setup looks like.
const INSTRUCTIONS = [
  "chrome-fast drives a real, logged-in Chrome through the DevTools protocol.",
  "Start with navigate or get_page. Both return the page as an accessibility tree: text lines, " +
    "headings, and interactive elements with numbered refs (pass them as strings, e.g. \"12\") that " +
    "click, type, scroll and fill_form accept. A ref keeps its number for as long as you stay on the " +
    "same page; if a tool reports a stale ref, call get_page again.",
  "After an action (click, type, fill_form, scroll, wait) you get what changed on the page: lines " +
    "marked + (new) and - (gone), or \"No visible change\". A Note tells you when a navigation " +
    "started, which background requests the action triggered, or when a dialog was handled. Call " +
    "get_page when you need the whole page; long pages are cut at an output limit, and get_page with " +
    "offset continues where it stopped.",
  "Use batch to run several steps in one call, for example type, type, click; it stops at the first " +
    "failing step and returns the page once.",
  "Prefer get_page over screenshot, and use screenshot only when layout matters. Use evaluate for " +
    "anything the other tools cannot express; it behaves like the DevTools console.",
  "A page with unsaved changes is never left silently: navigate and tab_close cancel and report " +
    "instead, and take force: true to proceed. Open a fresh tab with tab_new when in doubt.",
  `Setup: this server talks to Chrome on 127.0.0.1:${CHROME_PORT}` +
    (AUTO_LAUNCH
      ? " and launches Chrome itself when nothing is listening there."
      : "; auto-launch is off (CHROME_AUTO_LAUNCH=0), so Chrome must be started with start-chrome-debug.bat.") +
    " A Chrome started by chrome-fast or by start-chrome-debug.bat has its DevTools port listen on " +
    CHROME_DEBUG_ADDRESS +
    (debugPortIsLocalOnly()
      ? " (this machine only; since 1.1 the default is no longer 0.0.0.0, because the protocol has no " +
        "authentication). If another machine or a container must connect to Chrome directly, the user " +
        "sets CHROME_DEBUG_ADDRESS=0.0.0.0; clients of this server's own HTTP mode need no change."
      : ", which is reachable from other machines."),
].join("\n");

function logStartup(mode: string): void {
  process.stderr.write(`chrome-fast ${VERSION} ${mode}\n`);
  process.stderr.write(`chrome-fast: ${describeChromeSetup()}\n`);
  if (debugPortIsLocalOnly()) {
    process.stderr.write(
      "chrome-fast: Chrome's debug port is reachable from this PC only (changed in 1.1; it used to be " +
        "0.0.0.0). Set CHROME_DEBUG_ADDRESS=0.0.0.0 only if a container or another machine must connect " +
        "to Chrome directly; clients of this server's HTTP mode are unaffected.\n"
    );
  }
}

interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, any>;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

type TextHandler = (args: any) => Promise<string>;

const errorResult = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${(err as Error)?.message ?? String(err)}` }],
  // Lets the client tell a failed call from a page that happens to contain the word "Error".
  isError: true,
});

function registerTextTool(
  server: McpServer,
  def: ToolDef,
  handler: TextHandler,
  annotations?: ToolAnnotations
): void {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.schema, annotations },
    async (args: any) => {
      try {
        return { content: [{ type: "text" as const, text: await handler(args) }] };
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}

function createServer(): McpServer {
  const server = new McpServer({ name: "chrome-fast", version: VERSION }, { instructions: INSTRUCTIONS });

  registerTextTool(server, navigateToolDef, handleNavigate);
  registerTextTool(server, getPageToolDef, handleGetPage, { readOnlyHint: true });

  // Screenshot returns an image block instead of text
  server.registerTool(
    screenshotToolDef.name,
    {
      description: screenshotToolDef.description,
      inputSchema: screenshotToolDef.schema,
      annotations: { readOnlyHint: true },
    },
    async (args: any) => {
      try {
        const result = await handleScreenshot(args);
        return {
          content: [{ type: "image" as const, data: result.data, mimeType: result.mimeType }],
        };
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  registerTextTool(server, evaluateToolDef, handleEvaluate);
  registerTextTool(server, clickToolDef, handleClick);
  registerTextTool(server, typeToolDef, handleType);
  registerTextTool(server, scrollToolDef, handleScroll);
  registerTextTool(server, fillFormToolDef, handleFillForm);
  registerTextTool(server, tabsToolDef, handleTabs, { readOnlyHint: true });
  registerTextTool(server, tabNewToolDef, handleTabNew);
  registerTextTool(server, tabSwitchToolDef, handleTabSwitch);
  registerTextTool(server, tabCloseToolDef, handleTabClose, { destructiveHint: true });
  registerTextTool(server, waitToolDef, handleWait, { readOnlyHint: true });

  const batch = createBatchTool([
    { ...navigateToolDef, handler: handleNavigate },
    { ...getPageToolDef, handler: handleGetPage },
    { ...evaluateToolDef, handler: handleEvaluate },
    { ...clickToolDef, handler: handleClick },
    { ...typeToolDef, handler: handleType },
    { ...scrollToolDef, handler: handleScroll },
    { ...fillFormToolDef, handler: handleFillForm },
    { ...tabsToolDef, handler: handleTabs },
    { ...tabNewToolDef, handler: handleTabNew },
    { ...tabSwitchToolDef, handler: handleTabSwitch },
    { ...tabCloseToolDef, handler: handleTabClose },
    { ...waitToolDef, handler: handleWait },
  ]);
  registerTextTool(server, batch.def, batch.handler);

  return server;
}

/** `--http [port]` on the command line, or MCP_HTTP_PORT; 0 means stdio mode. */
function parseHttpPort(argv: string[]): number {
  let port = parseInt(process.env.MCP_HTTP_PORT || "0", 10) || 0;
  const flag = argv.indexOf("--http");
  if (flag !== -1) {
    const next = argv[flag + 1];
    port = next && /^\d+$/.test(next) ? parseInt(next, 10) : port || 3500;
  }
  return port;
}

const HTTP_TOKEN = process.env.MCP_HTTP_TOKEN || "";

/** With MCP_HTTP_TOKEN set, every MCP request must carry it as a bearer token. */
function authorized(req: http.IncomingMessage): boolean {
  if (!HTTP_TOKEN) return true;
  const header = req.headers.authorization ?? "";
  const expected = Buffer.from(`Bearer ${HTTP_TOKEN}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let shuttingDown = false;
function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  disconnectClient().finally(() => process.exit(code));
}

async function runHttp(port: number): Promise<void> {
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";

  // Streamable HTTP (current MCP transport), one session per client at /mcp
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  // Legacy HTTP+SSE transport at /sse and /messages, kept for older clients
  const sse = new Map<string, SSEServerTransport>();

  const handleStreamable = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const sessionHeader = req.headers["mcp-session-id"];
    const existing = typeof sessionHeader === "string" ? streamable.get(sessionHeader) : undefined;
    if (existing) {
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no active session; send an initialize request first" },
          id: null,
        })
      );
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        streamable.set(id, transport);
      },
      onsessionclosed: (id) => {
        streamable.delete(id);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) streamable.delete(transport.sessionId);
    };
    await createServer().connect(transport);
    // The transport itself rejects anything but an initialize request here.
    await transport.handleRequest(req, res);
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        return;
      }
      if (!authorized(req)) {
        res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
        return;
      }
      if (url.pathname === "/mcp") {
        await handleStreamable(req, res);
      } else if (req.method === "GET" && url.pathname === "/sse") {
        const server = createServer();
        const transport = new SSEServerTransport("/messages", res);
        sse.set(transport.sessionId, transport);
        transport.onclose = () => {
          sse.delete(transport.sessionId);
        };
        await server.connect(transport);
      } else if (req.method === "POST" && url.pathname === "/messages") {
        const transport = sse.get(url.searchParams.get("sessionId") ?? "");
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(404).end("Session not found");
        }
      } else {
        res.writeHead(404).end("Not found");
      }
    } catch (err: any) {
      process.stderr.write(`HTTP error: ${err.message}\n`);
      if (!res.headersSent) res.writeHead(500).end(err.message);
    }
  });

  httpServer.on("error", (err) => {
    process.stderr.write(`Fatal: cannot listen on ${host}:${port}: ${err.message}\n`);
    process.exit(1);
  });

  httpServer.listen(port, host, () => {
    logStartup(
      `listening on http://${host}:${port} ` +
        `(Streamable HTTP at /mcp, legacy SSE at /sse${HTTP_TOKEN ? ", bearer token required" : ""})`
    );
  });

  const stop = () => {
    httpServer.close();
    shutdown(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  // Exit when the client goes away, so no orphaned server keeps Chrome's socket open.
  transport.onclose = () => shutdown(0);
  process.stdin.on("end", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  await server.connect(transport);
  logStartup("running on stdio");
}

async function main() {
  const httpPort = parseHttpPort(process.argv.slice(2));
  if (httpPort) {
    await runHttp(httpPort);
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
