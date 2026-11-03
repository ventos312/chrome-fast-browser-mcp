# chrome-fast 1.2.0 — benchmark rerun (2026-11-03)

Same method and prompts as the 1.1 rounds below. Two fresh agents per browser for each test.

| Test | chrome-fast 1.1 | chrome-fast 1.2 | Built-in (rerun) |
|---|---|---|---|
| WordPress draft | 69.5 / 33.8 s (11 / 5 calls) | **25.7** / 78.1 s (**2** / 11 calls) | 38.7 / 39.7 s (8 / 9 calls) |
| CNN lead headline | 30.5 / 50.1 s (6 / 6 calls) | **29.4 / 31.8 s (1 / 2 calls)** ✓ | blocked both runs |
| Wikipedia image URLs | 17.6 / 15.5 s (2 / 2 calls) | 29.9 / 21.3 s (2 / 2 calls) | 18.4 / 18.5 s (2 / 2 calls) |

**Fixed in 1.2:** the CNN snapshot (now 1 call instead of 6, and both runs found the real lead
story). `batch` lets a smooth WordPress run finish in 2 calls, the fastest result of any browser.

### New or remaining problems in 1.2

1. **Unsaved-changes protection cancels the user's own Save**  — bug, cost run 4 about 50 s
   - Clicking a submit button on a page with `onbeforeunload` set (this WordPress editor sets one
     after typing) is cancelled, because form submission counts as leaving the page.
   - Reproduced on a local page: type into a field, click submit → "the action was cancelled to
     protect them", and the page is unchanged.
   - The Note tells the agent to "repeat with force: true", but `click`, `type` and `batch` have
     no `force` option (only `navigate` and `tab_close` do).
   - Fix: apply the protection only to navigations chrome-fast starts itself (`navigate`,
     `tab_close`, opening a different URL). Let `click` and Enter-to-submit leave the page, or at
     least add `force` to `click`, `type` and `batch`.
2. **`batch` cuts off `evaluate` results**  — the cause of the Wikipedia slowdown
   - Both agents had to run `evaluate` again outside `batch` to get the full image list.
   - The page snapshot appended to `batch` was not needed either.
   - Fix: return each step's `evaluate` result in full (up to the normal evaluate limit), and make
     the final snapshot optional (e.g. `snapshot: false`).
3. **Inert note shows when nothing is blocking**
   - Every WordPress admin page reports "about 160 elements hidden by a modal or aria-hidden", but
     there is no visible modal. It caused no harm, but it is noise.
   - Show the note only when it changes what gets shown (when the snapshot falls back to the
     page code), or name the elements involved.
4. **CNN snapshot is cut off at 20,000 characters**
   - One agent needed an extra `get_page` call with an offset, to see the consent dialog's buttons.
   - When an `aria-modal` is open, list its contents first, since that is what the agent must deal with.
   - On CNN, `get_page format: "interactive"` returns the same size as the full snapshot.

---

# chrome-fast 1.1.0 — benchmark findings

Tested 2026-11-03 against Claude's built-in browser. Method: fresh agents with identical
instructions, one browser each, order chrome-fast → built-in → built-in → chrome-fast.

## Results at a glance

| Test | chrome-fast | Built-in browser |
|---|---|---|
| WordPress: create a draft page | 69.5 s / 33.8 s (11 / 5 calls) | 39.0 s / 42.2 s (7 / 10 calls) |
| CNN: lead headline | 30.5 s / 50.1 s ✓ | blocked both times ("Content Unavailable For Legal Reasons") |
| Wikipedia: scrape image URLs | 17.6 s / 15.5 s | 15.9 s / 15.7 s |
| Raw tool speed (scripted, no LLM) | 8.4 s for the WordPress flow | n/a |

The tools themselves are fast (most calls take 40–500 ms). Almost all of the lost time is
the agent reading oversized output, or recovering from an unclear or empty result.

## Problems, in priority order

### 1. Snapshot is empty when the page has an open `aria-modal` (CNN)  — bug
- **Symptom:** on cnn.com, `navigate` and `get_page` (every format) return
  `(no interactive elements found)` even though the page has 633 links.
  Both chrome-fast agents had to fall back to `evaluate`. Reproduces every time.
- **Cause:** CNN has an `[aria-modal=true]` element open (not visible as a banner) plus
  5 `[inert]` elements. Of 511 AX nodes, 508 are `ignored`, 478 of them with reason
  `inertElement`. `getAccessibilityTree` skips every `node.ignored` (`src/utils/accessibility.ts:187`).
- **Ideas:**
  - When nearly all nodes are ignored because of inert or aria-hidden, say so in a Note
    and name the modal ("An aria-modal dialog is open: …; the rest of the page is inert").
  - Include the modal's own contents, so the agent can close it.
  - Fall back to a DOM-based snapshot (links, headings, buttons) when the AX tree is empty.
  - Also: the retry loop at `accessibility.ts:149` retries only when the call throws. It
    could also retry once when the result is empty.

### 2. Output is far too large on real sites  — biggest speed cost
- **WordPress admin:** every `click`, `type` and `fill_form` returns about 15,000 characters
  (about 480 refs). That covers the whole 300-item admin menu, and every `<option>` of
  collapsed selects (one custom-field select alone lists 100+ options).
- **Wikipedia Prague:** `navigate` returned about 77,000 characters. Claude Code saved it to a
  file instead of showing it, so the agent got nothing useful from the call.
- **Ideas:**
  - Default `MAX_LINES` (2000) is too high. Try about 300 lines, or a character budget of about 20 KB.
  - Don't list `option` children of a collapsed `combobox`/`listbox`. Show the selected
    value and an option count instead.
  - Let actions return less: e.g. `snapshot: "none" | "diff" | "full"` on
    click/type/fill_form, with "diff" (only what changed) or a short "ok" summary as the default.
  - Collapse long link lists inside `navigation` landmarks, e.g.
    `navigation "Main menu" (58 links)`, unless the agent asks for them.
  - Emit nodes in document order with indentation, so structure (main vs sidebar vs menu)
    is visible. Right now the form controls sit hundreds of lines below their headings.

### 3. `click` gives no signal when the action is an AJAX save  — misleading result
- **Symptom:** WordPress on this site saves drafts in the background (no page reload).
  After `click #save-post` the snapshot still shows "Saving Draft…" and the URL is unchanged.
  In run 1 the agent decided the click had failed, clicked twice more, then saved through
  `evaluate`. The same click worked in run 4. My manual run also needed 3 extra calls to
  confirm the save.
- **Cause:** `settleAfterAction` (`src/utils/waits.ts:158`) only waits for a main-frame
  navigation. If none starts within 300 ms it returns at once, while XHR/fetch requests
  are still in flight.
- **Ideas:**
  - Track network requests started by the action. Wait (up to about 3 s) for them to finish.
  - Add a Note such as "No navigation; 2 background requests (POST /wp-admin/admin-ajax.php → 200) finished."
  - Optionally report visible text that changed (e.g. "Draft saved at 7:53").

### 4. `beforeunload` is auto-accepted, which can silently discard unsaved work  — risky default
- **Symptom:** in run 1 chrome-fast reused a tab that had unsaved edits. `navigate` accepted the
  "Leave site? Changes you made may not be saved" dialog automatically. Here only benchmark
  data was lost, but in real use it could lose the user's own work.
- **Where:** `src/cdp.ts:192`: `accept = p.type === "alert" || p.type === "beforeunload"`.
  A Note is added, but only after the work is already gone.
- **Ideas:**
  - Dismiss `beforeunload` by default and return a Note
    ("Page has unsaved changes; navigation was cancelled. Pass `force: true` to leave anyway").
  - Or open a new tab rather than navigating away from a tab with unsaved changes.

### 5. Tab reuse picks up leftover tabs
- New agents attached to whatever tab was active, including a half-edited WordPress editor
  left by an earlier session. That caused problem 4.
- **Idea:** have `navigate` with no attached tab open a fresh tab, or warn when the
  attached tab has a pending `beforeunload` handler or a form that has been edited.

### 6. No batching, so more round trips
- The built-in browser can send several actions in one call. With chrome-fast each step
  costs an LLM round trip (about 5–8 s each in these runs).
- **Idea:** a `batch` tool (`[{tool, args}, …]`) that runs steps in order, stops on the first
  error, and returns one snapshot at the end. The WordPress task would drop from 5–11 calls to 2–3.

## What already works well
- Reaches sites that block the built-in browser (CNN), because it drives the user's own Chrome on their own network.
- Correctness fixes from 1.1 hold: 15/15 on the local e2e checks (1.0: 12/15).
- `evaluate` is fast and reliable (about 3 ms) and was the agents' reliable fallback in every test.
- Raw action latency is low: the scripted WordPress flow took 8.4 s end to end, 4.4 s of it the admin page load.

## Repro scripts
In this session's scratchpad `bench/` folder: `bench.mjs` (speed), `correct.mjs` (correctness),
`wp.mjs` (WordPress flow), `cnn.mjs` / `cnn2.mjs` (empty-snapshot repro and AX-tree analysis).
