# chrome-fast

Fast Chrome browser automation MCP server (stdio + HTTP/SSE) backed by Chrome DevTools Protocol.

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
Double-click `start-chrome-debug.bat`. It opens Chrome on port `9222` with an isolated profile under `%LOCALAPPDATA%\NanoClaw\ChromeProfile`. Sign in to any accounts you need (e.g. Google for Gemini) in that window — the profile persists.

You only need the bat for the **first** run (to sign in). After that chrome-fast launches Chrome itself: whenever a tool is called and nothing is listening on the debug port, it starts Chrome with the same flags and the same profile, waits for the port, then connects. Added 2026-09-04.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `CHROME_PORT` | `9222` | DevTools port to connect to / launch on |
| `CHROME_PROFILE` | `%LOCALAPPDATA%NanoClawChromeProfile` | `--user-data-dir` for the launched Chrome |
| `CHROME_PATH` | auto-detected | Path to `chrome.exe` if it is somewhere unusual |
| `CHROME_AUTO_LAUNCH` | `1` | Set to `0` to disable auto-launch and require the bat |

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

HTTP/SSE mode (for containers / cross-machine):
```bash
node dist/index.js --http 3500
# clients connect to http://localhost:3500/sse
```

### Verify
Restart Claude Code. The `mcp__chrome-fast__*` tools should be available. Try:
- `mcp__chrome-fast__tabs` — lists open Chrome tabs
- `mcp__chrome-fast__navigate` — navigates a tab

## Tools provided
- `navigate`, `tabs`, `tab_new`, `tab_switch`, `tab_close`
- `get_page` (accessibility tree or HTML), `screenshot`, `evaluate`
- `click`, `type`, `scroll`, `fill_form`
- `wait` (CSS selector, network idle, or time)

## Notes for drivers (from the 2026-09-04 test)
- Element refs returned by `get_page` / `navigate` / `type` are plain numbers (pass `"55"`). They go stale when the page re-renders; call `get_page` again before clicking by ref, otherwise `click` fails with "Could not compute box model".
- `type` with `pressEnter: true` submits Gemini prompts correctly.
- `screenshot` returns a JPEG/PNG image block; `evaluate` returns JSON and supports top-level `await` and Promises.
