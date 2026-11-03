# Changelog

## 1.1.0

### Changed
- **Chrome's DevTools port listens on this PC only.** A Chrome launched by chrome-fast, or by
  `start-chrome-debug.bat`, now uses `--remote-debugging-address=127.0.0.1` instead of `0.0.0.0`.
  The DevTools protocol has no authentication, so the old setting let anyone on the network control
  the logged-in profile. Set `CHROME_DEBUG_ADDRESS=0.0.0.0` if a container or another machine must
  connect to Chrome directly; clients of chrome-fast's HTTP mode are unaffected. The server prints
  the address it uses at startup and includes it in the instructions sent to MCP clients.
- Page snapshots (`navigate`, `get_page` and the content returned after actions) now include the
  page text as `text "…"` lines, heading levels and the current value of form fields. A new
  `format: "interactive"` option of `get_page` gives the previous compact output. Snapshots are
  capped at `CHROME_FAST_MAX_LINES` lines (default 2000).
- `evaluate` runs like the DevTools console: top-level `await`, several statements, `let` that can
  be declared again on the next call, `$` and `$$`. Promises are awaited, DOM nodes come back as
  HTML, Maps and cyclic objects as JSON. Expressions with a top-level `return` keep working.
- `type` appends to the existing content and `clear: true` replaces it, including in contenteditable
  editors. `fill_form` sets values the way frameworks such as React notice, supports checkboxes,
  radios and selects by label, and `submit: true` runs validation and submit handlers.
- Tool errors are returned with `isError: true`. Tool parameters carry descriptions.

### Added
- Streamable HTTP transport at `/mcp` (the current MCP transport) next to the legacy `/sse`.
- `--http <port>` flag, `MCP_HTTP_HOST`, and optional bearer-token authentication via `MCP_HTTP_TOKEN`.
- `wait` can wait for text to appear; `navigate` takes a `timeout`.
- JavaScript dialogs (`alert`, `confirm`, `prompt`, `beforeunload`) are handled automatically instead
  of blocking every tool, and reported as a `Note:` line.
- End-to-end test suite (`npm test`) against a headless Chrome.
- `zod` declared as a direct dependency; `bin` and `engines` fields.

### Fixed
- The attached tab was never tracked after the first connection, so `tabs` never showed `(active)`
  and `tab_close` without an id failed.
- `navigate` and `tab_new` could hang forever on fast or cached pages and on hash-only navigations;
  `waitUntil: "domcontentloaded"` behaved like `load`; navigation errors were ignored.
- `screenshot` with `fullPage: true` returned only the viewport.
- `type` with `pressEnter: true` did not submit forms, and inserted text at the start of the field.
- `click` did not scroll off-screen elements into view, used a wrong `buttons` bitmask, and clicked
  overlays covering the target.
- `wait` with `networkIdle` never enabled network events and leaked listeners on every call.
- Unchecked checkboxes were reported as checked.
- Closing a non-active tab switched the active tab; closing raced Chrome's tab list.
- Concurrent tool calls could open duplicate Chrome connections.
- The documented `--http` flag did not exist; the stdio server kept running after its client exited.
- Dependencies updated to clear all `npm audit` findings.

## 1.0.0
- Initial release.
