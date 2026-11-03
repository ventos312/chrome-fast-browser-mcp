import http from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

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

// Helper to wrap tool handlers with error handling
function wrapHandler(
  fn: (args: any) => Promise<string>
): (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return async (args: any) => {
    try {
      const result = await fn(args);
      return { content: [{ type: "text" as const, text: result }] };
    } catch (err: any) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err.message}` }],
      };
    }
  };
}

function createServer(): McpServer {
  const server = new McpServer({
    name: "chrome-fast",
    version: "1.0.0",
  });

  // Navigate
  server.tool(
    "navigate",
    navigateToolDef.description,
    { url: z.string(), waitUntil: z.enum(["load", "domcontentloaded", "networkidle"]).optional() },
    wrapHandler(handleNavigate)
  );

  // Get page
  server.tool(
    "get_page",
    getPageToolDef.description,
    { format: z.enum(["accessibility", "html"]).optional() },
    wrapHandler(handleGetPage)
  );

  // Screenshot (returns image)
  server.tool(
    "screenshot",
    screenshotToolDef.description,
    {
      format: z.enum(["png", "jpeg"]).optional(),
      quality: z.number().optional(),
      fullPage: z.boolean().optional(),
    },
    async (args) => {
      try {
        const result = await handleScreenshot(args);
        return {
          content: [
            {
              type: "image" as const,
              data: result.data,
              mimeType: result.mimeType,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
        };
      }
    }
  );

  // Evaluate
  server.tool(
    "evaluate",
    evaluateToolDef.description,
    { expression: z.string() },
    wrapHandler(handleEvaluate)
  );

  // Click
  server.tool(
    "click",
    clickToolDef.description,
    { selector: z.string(), button: z.enum(["left", "right", "middle"]).optional() },
    wrapHandler(handleClick)
  );

  // Type
  server.tool(
    "type",
    typeToolDef.description,
    {
      selector: z.string(),
      text: z.string(),
      clear: z.boolean().optional(),
      pressEnter: z.boolean().optional(),
    },
    wrapHandler(handleType)
  );

  // Scroll
  server.tool(
    "scroll",
    scrollToolDef.description,
    {
      selector: z.string().optional(),
      direction: z.enum(["up", "down"]).optional(),
      amount: z.number().optional(),
    },
    wrapHandler(handleScroll)
  );

  // Fill form
  server.tool(
    "fill_form",
    fillFormToolDef.description,
    {
      fields: z.array(
        z.object({ selector: z.string(), value: z.string() })
      ),
      submit: z.boolean().optional(),
    },
    wrapHandler(handleFillForm)
  );

  // Tabs
  server.tool("tabs", tabsToolDef.description, {}, wrapHandler(handleTabs));

  server.tool(
    "tab_new",
    tabNewToolDef.description,
    { url: z.string().optional() },
    wrapHandler(handleTabNew)
  );

  server.tool(
    "tab_switch",
    tabSwitchToolDef.description,
    { targetId: z.string() },
    wrapHandler(handleTabSwitch)
  );

  server.tool(
    "tab_close",
    tabCloseToolDef.description,
    { targetId: z.string().optional() },
    wrapHandler(handleTabClose)
  );

  // Wait
  server.tool(
    "wait",
    waitToolDef.description,
    {
      selector: z.string().optional(),
      timeout: z.number().optional(),
      time: z.number().optional(),
      networkIdle: z.boolean().optional(),
    },
    wrapHandler(handleWait)
  );

  return server;
}

async function main() {
  const httpPort = parseInt(process.env.MCP_HTTP_PORT || "0", 10);

  if (httpPort) {
    // HTTP/SSE mode: run as a persistent server on Windows so Docker containers
    // can connect via http://host.docker.internal:PORT/sse
    const transports = new Map<string, SSEServerTransport>();

    const httpServer = http.createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/sse") {
          const server = createServer();
          const transport = new SSEServerTransport("/messages", res);
          transports.set(transport.sessionId, transport);
          transport.onclose = () => {
            transports.delete(transport.sessionId);
          };
          await server.connect(transport);
        } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
          const url = new URL(req.url, `http://localhost:${httpPort}`);
          const sessionId = url.searchParams.get("sessionId") ?? "";
          const transport = transports.get(sessionId);
          if (transport) {
            await transport.handlePostMessage(req, res);
          } else {
            res.writeHead(404).end("Session not found");
          }
        } else if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
        } else {
          res.writeHead(404).end();
        }
      } catch (err: any) {
        process.stderr.write(`HTTP error: ${err.message}\n`);
        if (!res.headersSent) res.writeHead(500).end(err.message);
      }
    });

    httpServer.listen(httpPort, "0.0.0.0", () => {
      process.stderr.write(`chrome-fast MCP server listening on port ${httpPort}\n`);
    });
  } else {
    // stdio mode (default): for direct use in Claude Code or local dev
    const server = createServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write("chrome-fast MCP server running on stdio\n");
  }
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
