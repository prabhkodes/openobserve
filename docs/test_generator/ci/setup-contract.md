# Test Setup Contract: Logs Free-Text SQL Toggle Schema Load  (area: Logs)

Tag each item by SCOPE so the Engineer puts it in the right place:
- **`[shared/read-only]`** — every test just READS it the same way → set up ONCE in `test.beforeAll`.
- **`[per-test]`** — only one test needs it, or a test MUTATES it → set up INSIDE that test, uniquely named.

## Streams / data the spec must establish

Three streams, one org. All are ingested in `test.beforeAll` (serial mode) and never mutated by any
test, but each stream is used to exercise a *different* FTS resolution, so keep all three:

- **`fts_a` [shared/read-only]** — fields: `_timestamp` (i64 µs), `level` (str), `service_name` (str),
  `enabled` (bool), `body` (str, text). **`body` is an FTS key** because it is in the default
  `default_fts_keys` list (`src/config/src/config.rs:202`, `feature_default_index_fields_enabled`).
  Why: primary workflow — bare word `timeout` → `match_all('timeout')`; SQL-toggle renders
  `SELECT * FROM "fts_a" WHERE match_all('timeout')`. Ingest **40 rows** with varied `body` text so
  `-debug`→32 hits, `-500`→32, `limit 50`→8, `timeout`→non-zero.
- **`nofts_b` [shared/read-only]** — fields: `_timestamp`, `msg_text` (str), `detail` (str). **No FTS
  key**: `msg_text`/`detail` are string fields but not in `default_fts_keys` and the stream has no
  `full_text_search_keys`. Why: refusal path — SQL toggle (and bare-word run) shows
  `Full-text search fields are not configured for nofts_b` (`search.noFtsRecovery.title`).
- **`nofts_c` [shared/read-only]** — fields: `_timestamp`, `code` (int only). **No string field at all**.
  Why: `This stream has no text fields to search.` (`search.freeTextNoTextFields`).

## How to create it (copy these EXACT patterns — do NOT invent setup)

- **Ingest**: `await ingestRows(request, ORG, STREAM, rows)` — see
  `tests/ui-testing/playwright-tests/Logs/logsFreeText.spec.js:96-135` (`test.beforeAll`).
  `ingestRows` is `tests/ui-testing/playwright-tests/utils/auto-run-helpers.js:63`; it POSTs
  `/api/{org}/{stream}/_json` in ≤2000-row batches with `getAuthHeaders()`.
- **Org**: fresh, unique org id — `const ORG = \`freetext${Date.now()}\`` (`logsFreeText.spec.js:22`).
  Auth headers come from `require('../utils/cloud-auth.js')` → `getAuthHeaders()`.
- **Wait for searchability**: poll `apiTotal(request, \`SELECT * FROM "${FTS}"\`)` until it equals 40
  (`logsFreeText.spec.js:132-134`). `apiTotal` (line 83) posts
  `{ query: { sql, start_time, end_time, from:0, size:0, track_total_hits:true } }` to
  `/api/{org}/_search?type=logs`. This is the load-bearing wait — do not assert table rows before it.
- **Navigate + query via URL**: `urlFor(streams, query, extra)` (line 38) builds
  `/web/logs?org_identifier=${ORG}&stream=${streams}&stream_type=logs&period=15m&refresh=0&sql_mode=false&quick_mode=false&show_histogram=true&query=${b64(query)}`.
  `open()` (line 51) clears `localStorage` keys matching `/^oo_(toggle_auto_run|logs_|selected_stream_)/`
  first (critical to avoid a persisted stream/mode), then navigates and waits for the editor.
- **Auth/org**: `navigateToBase(page)` from `enhanced-baseFixtures.js` before `page.goto(urlFor(...))`
  (`logsFreeText.spec.js:52-59`). No extra login needed — the worker auth state covers it.

## Preconditions / toggles

- **Start in filter (non-SQL) mode**: `sql_mode=false` in the URL (`urlFor`). Do NOT rely on the
  app's default, and do not leave a persisted `sql_mode` in localStorage.
- **SQL toggle via Vue state, not the UI click**: `await logsPage._setSqlModeViaVue(true)` —
  `tests/ui-testing/pages/logsPages/logsPage.js:8220` (delegates to `_mutateSearchObj`, line 8250).
  This sets `searchObj.meta.sqlMode = true` WITHOUT setting `sqlModeManualTrigger`, so the
  `fullSQLMode` watcher takes the load-and-rewrite branch (`Index.vue:4314-4318`). Using a real
  toggle click is acceptable but the Vue-state setter is the deterministic path the existing tests use.
- **Read mode back**: `await logsPage._isSqlModeEnabledViaVue()` (`logsPage.js:8239`) returns the real
  `searchObj.meta.sqlMode`, not a text heuristic.
- **Editor text**: `editorText(page)` (`logsFreeText.spec.js:46`) reads
  `[data-test="logs-search-bar-query-editor"] .monaco-editor .view-lines` and normalizes `\u00a0`.
- **Set editor content programmatically**: `new PageManager(page).logsPage.setQueryEditorContent(text)`
  (`logsPage.js:9285`) — uses Monaco `executeEdits`, avoids flaky select-all/clear under CI.

## Slow-schema timing (the #15549/#15889 cases)

- Route-intercept the schema call to add latency:
  - no-FTS stream: `page.route(new RegExp(\`/api/${ORG}/streams(/${NOFTS}/schema)?\\?type=logs\`), async r => { await sleep(4000); await r.continue(); })` — `logsFreeText.spec.js:350-354`.
  - FTS stream: `page.route(new RegExp(\`/api/${ORG}/streams/${FTS}/schema\`), ...)` — `logsFreeText.spec.js:367-370`.
- Then `_setSqlModeViaVue(true)` and assert with a `timeout: 20000` (4000ms delay + rewrite).

## Gotchas (so the Healer/Engineer don't rediscover them)

- **Stream schema arrives async and ships `schema: []` until fetched** (`freeTextSearch.ts:409`
  comment). `loadPendingFreeTextSchemas` treats empty as "unloaded" and fetches on toggle. Assert
  the editor/panel only after the field list shows the schema field
  (`logsPage.expectFieldListItemVisible('body')` / `'msg_text'` — `logsPage.js:13519`), otherwise the
  resolver sees `[]` and the toggle behaves as "no FTS fields".
- **`default_fts_keys` decides FTS, not the field being a string.** `body` is FTS because it is in
  `SQL_FULL_TEXT_SEARCH_FIELDS` (`src/config/src/config.rs:202`). `msg_text`/`detail` are strings but
  NOT FTS keys → blocked-with-candidates; `code` (int) → no text fields. Keep these field names exact.
- **The Run button id doubles as Cancel during the load-time search** — `clickRun()` first waits for
  the button to read "Run query" (`logsFreeText.spec.js:71-74`), else the click cancels instead of runs.
- **`sqlModeManualTrigger` suppresses the rewrite.** Typing `SELECT ...` auto-detects SQL mode and
  sets that flag (`SearchBar.vue:2852-2859`), so `setQuery` is skipped. The toggle tests therefore set
  mode via `_setSqlModeViaVue(true)` — do not "help" the test by typing a SELECT first.
- **SQL toggle is disabled in visualize mode with >1 stream** (`SearchBar.vue:5164`) — not relevant to
  these tests, but don't multi-select streams and expect the toggle in visualize.
- **Editor text assertions must normalize NBSP** (`editorText` replaces `\u00a0`). Monaco renders
  trailing whitespace as NBSP; raw `.innerText()` comparisons will flake.
- **No FTS-config API call is needed** to create `fts_a`: the default FTS key list covers `body`.
  Do not add a `full_text_search_keys` update unless you are intentionally testing that stream setting.
