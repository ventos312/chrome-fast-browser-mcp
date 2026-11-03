# chrome-fast

Fast Chrome browser automation MCP server (stdio or HTTP) backed by the Chrome DevTools Protocol.
It drives a real, logged-in Chrome profile and returns pages as a compact accessibility tree with
numbered element refs, so an agent can read, click, type and fill forms with very few round trips.

## Setup on a new PC

### Prerequisites
- Node.js 20+
- Google Chrome installed

### Install
```bash
npm install
npm run build
```

### Start Chrome in debug mode
Double-click `start-chrome-debug.bat`. It opens Chrome on port `9222` with an isolated profile under
`%LOCALAPPDATA%\NanoClaw\ChromeProfile`. Sign in to any accounts you need (e.g. Google for Gemini) in
that window; the profile persists.

You only need the bat for the **first** run (to sign in). After that chrome-fast launches Chrome itself:
whenever a tool is called and nothing is listening on the debug port, it starts Chrome with the same
flags and the same profile, waits for the port, then connects.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `CHROME_PORT` | `9222` | DevTools port to connect to / launch on |
| `CHROME_PROFILE` | `%LOCALAPPDATA%\NanoClaw\ChromeProfile` | `--user-data-dir` for the launched Chrome |
| `CHROME_PATH` | auto-detected | Path to `chrome.exe` if it is somewhere unusual |
| `CHROME_AUTO_LAUNCH` | `1` | Set to `0` to disable auto-launch and require the bat |
| `CHROME_DEBUG_ADDRESS` | `127.0.0.1` | Address Chrome's DevTools port listens on. The protocol has no authentication and gives full control of the logged-in profile, so keep it on loopback unless a container or another machine must reach Chrome directly (the HTTP mode below does not need that). |
| `CHROME_FAST_MAX_LINES` | `2000` | Maximum content lines in a page snapshot before the rest is omitted |
| `MCP_HTTP_PORT` | unset | Run the HTTP server on this port instead of stdio (same as `--http <port>`) |
| `MCP_HTTP_HOST` | `0.0.0.0` | Address the HTTP server binds to |
| `MCP_HTTP_TOKEN` | unset | If set, HTTP clients must send `Authorization: Bearer <token>` |

The bat script honours `CHROME_PORT`, `CHROME_PROFILE`, `CHROME_PATH` and `CHROME_DEBUG_ADDRESS` too.

### Register in Claude Code (`~/.claude.json`)

Stdio mode (recommended for single-machine use):
```json
{
  "mcpServers": {
    "chrome-fast": {
      "command": "node",
      "args": ["C:\\path\\to\\chrome-fast\\dist\\index.js"]
    }
  }
}
```

HTTP mode (for containers / cross-machine):
```bash
node dist/index.js --http 3500
```
This serves two transports on the same port:
- `http://localhost:3500/mcp` — Streamable HTTP, the current MCP transport
  (`claude mcp add --transport http chrome-fast http://host.docker.internal:3500/mcp`)
- `http://localhost:3500/sse` — the older HTTP+SSE transport, for clients that still need it
- `http://localhost:3500/health` — returns `ok`

The HTTP server gives anyone who can reach it full control of the browser. Set `MCP_HTTP_TOKEN` when the
port is reachable from other machines and pass the token from the client, e.g.
`claude mcp add --transport http chrome-fast http://host:3500/mcp --header "Authorization: Bearer <token>"`.

### Verify
Restart Claude Code. The `mcp__chrome-fast__*` tools should be available. Try:
- `mcp__chrome-fast__tabs` — lists open Chrome tabs
- `mcp__chrome-fast__navigate` — navigates a tab

### Test
```bash
npm run build
npm test
```
The end-to-end test launches a headless Chrome with a throwaway profile, serves fixture pages locally and
exercises every tool. It needs Chrome installed (or `CHROME_PATH` set).

## Tools provided
- `navigate` (`url`, `waitUntil`: load / domcontentloaded / networkidle, `timeout`)
- `tabs`, `tab_new`, `tab_switch`, `tab_close`
- `get_page` (`format`: `accessibility` with page text, `interactive` without text, or `html`), `screenshot`, `evaluate`
- `click`, `type`, `scroll`, `fill_form`
- `wait` (CSS selector, text on the page, network idle, or a fixed time)

## Notes for drivers
- Element refs returned by `get_page` / `navigate` / `click` / `type` are plain numbers (pass `"55"`).
  They go stale when the page re-renders; if a tool reports a stale ref, call `get_page` again.
- Snapshots list the page text as `text "…"` lines, headings with their level, and form fields with
  their current `value="…"`. Lines starting with `Note:` report things handled automatically, for
  example a dismissed `confirm()` dialog or a page that did not finish loading in time.
- `click` scrolls the element into view first. If another element covers it, a DOM `click()` is
  dispatched instead and a note says so. When a click starts a navigation, the new page is returned.
- `type` appends to the existing content; use `clear: true` to replace it. `pressEnter: true` submits
  forms and sends chat prompts (Gemini, for example).
- `fill_form` handles text inputs, textareas, `<select>` (by option value or label), checkboxes and
  radios (`"true"` / `"false"`) and contenteditable elements, in a way React and similar frameworks notice.
  `submit: true` submits the form like its submit button would (validation and submit handlers run).
- JavaScript dialogs never block the tools: `alert` and `beforeunload` are accepted, `confirm` and
  `prompt` are dismissed. To accept a `confirm`, run `evaluate` with `window.confirm = () => true` first.
- `evaluate` behaves like the DevTools console: top-level `await`, several statements, `let` that can be
  declared again on the next call, and the `$` / `$$` helpers. Promises are awaited, DOM nodes come back
  as HTML, and objects as JSON. It stops after 30 seconds.
- `screenshot` returns a PNG (or JPEG) image block; `fullPage: true` captures the whole scrollable page,
  scaled down if it would exceed what the Claude API accepts.
