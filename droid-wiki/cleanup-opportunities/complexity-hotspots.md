# Complexity hotspots

Where a small change can have a wide effect: the largest files, the deepest module
dependency chain, the biggest addons by lines, and the list the fork itself maintains
as its complexity backlog. Counts were taken on 2026-10-07 at `30955b57688` with the
methods noted per table. None of this is a refactoring plan — the scope rule confines
changes to `addons/crm/` (see [design decisions](../background/design-decisions.md)),
and most of the hotspots below are upstream.

## Largest files (Python and JavaScript)

Method: `find odoo addons \( -name '*.py' -o -name '*.js' \) -type f -print0 | xargs -0
wc -l | grep -v ' total$' | sort -rn | head -15`. The `grep -v ' total$'` is the
robustness step: a plain `... | xargs wc -l | sort -rn` interleaves a **per-batch
"total" line** every ~thousand files (xargs batches its argument lists), and those
totals sort to the very top, so the naive pipeline reports meaningless numbers instead
of file names.

| File | Lines | Kind |
| --- | ---: | --- |
| `addons/spreadsheet/static/src/o_spreadsheet/o_spreadsheet.js` | 90,650 | generated bundle |
| `addons/web/static/lib/pdfjs/build/pdf.worker.js` | 59,020 | vendored |
| `addons/web/static/lib/zxing-library/zxing-library.js` | 27,951 | vendored |
| `addons/web/static/lib/pdfjs/build/pdf.js` | 26,312 | vendored |
| `addons/web/static/tests/views/list/list_view.test.js` | 22,473 | hand-written test |
| `addons/web/static/lib/ace/ace.js` | 21,971 | vendored |
| `addons/web/static/src/core/emoji_picker/emoji_data.js` | 21,885 | generated data |
| `addons/web/static/lib/pdfjs/web/viewer.js` | 18,448 | vendored |
| `addons/mail/static/lib/lame/lame.js` | 15,524 | vendored |
| `addons/web/static/lib/Chart/Chart.js` | 15,099 | vendored |
| `addons/web/static/tests/views/form/form_view.test.js` | 13,937 | hand-written test |
| `addons/web/static/tests/views/fields/one2many_field.test.js` | 13,907 | hand-written test |

No Python file reaches that table. The largest Python files are
`addons/account/models/account_move.py` at 8,339 lines, `addons/stock/tests/test_move.py`
at 7,043, and `odoo/orm/models.py` at 6,617.

**Fork relevance: none of these twelve.** Seven are vendored libraries under
`static/lib/`, two are generated artifacts that sit in `static/src` anyway
(`o_spreadsheet.js`'s own header says it must not be edited), and three are upstream
web test suites. All of them are outside `addons/crm/`.

## The fork's own hotspots

What the fork could actually act on, all inside `addons/crm/`:

| File | Lines | Note |
| --- | ---: | --- |
| `addons/crm/models/crm_lead.py` | 2,904 | Upstream model the fork extends (`action_log_call`, mark-won paths); pipeline, scoring, revenue, and conversion logic share it |
| `addons/crm/static/src/mobile/offline_inventory.md` | 1,248 | The fork's largest single artifact: the 150-row QUEUE/SKIP/DISABLE classification, revised through five scrutiny rounds |
| `addons/crm/tests/test_crm_lead.py` | 1,187 | Upstream test suite |
| `addons/crm/tests/test_crm_pls.py` | 1,009 | Upstream PLS test suite |
| `addons/crm/static/tests/crm_offline_team_switcher.test.js` | 906 | Fork-added; the largest of the 51 JS suites under `addons/crm/static/tests/`, 46 of them fork-added |
| `addons/crm/static/tests/crm_offline_kanban_group_guards.test.js` | 900 | Fork-added |
| `addons/crm/static/tests/crm_offline_activity_panel.test.js` | 886 | Fork-added |
| `addons/crm/models/crm_team.py` | 837 | Upstream model the fork touches via team-switcher data |
| `addons/crm/static/src/views/crm_kanban/crm_kanban_renderer.js` | 605 | The two-layout renderer (desktop pipeline plus the `isSmall()` mobile branch) |

For scale: the framework side the fork consumes is small by comparison —
`addons/web/static/src/core/offline/offline_plugin.js`, the entire queue, is 522 lines,
and the service worker is 234. The fork's added weight sits in tests: 54 of its 118
changed `addons/crm/` files are test files, 19,291 of 25,232 added lines (76%, from
[by the numbers](../by-the-numbers.md)).

## Biggest addons by lines

Method: `find addons -type f \( -name '*.py' -o -name '*.js' -o -name '*.xml' -o
-name '*.scss' -o -name '*.css' -o -name '*.csv' \) ... | awk` summing per
`addons/<name>/`. 642 addon directories exist.

| Addon | Source lines |
| --- | ---: |
| `addons/web` | 683,045 |
| `addons/mail` | 207,897 |
| `addons/html_editor` | 157,983 |
| `addons/website` | 156,020 |
| `addons/spreadsheet` | 145,409 |
| `addons/account` | 129,965 |
| `addons/point_of_sale` | 94,571 |
| `addons/stock` | 67,992 |
| `addons/website_sale` | 60,494 |
| `addons/html_builder` | 45,486 |

`addons/crm` just misses this table at 45,256 lines — the fork's whole playground is
the eleventh-largest addon, and five framework/editor addons together hold 39% of all
addon source lines. The fork cannot split, restructure, or even trim any of the top
ten; it can only extend the pieces it consumes.

## Deepest module dependency chain

Method: a manifest parse of the 653 `__manifest__.py` files that declare `depends`,
with a memoized longest-path search. The deepest chain has **16 `depends` edges (17
modules counting `base`)** and ends at a test module:

```text
test_event_full
  -> website_event_booth_sale_exhibitor
  -> website_event_booth_sale
  -> event_booth_sale
  -> event_sale
  -> sale_management
  -> sale
  -> account_payment
  -> account
  -> digest
  -> portal
  -> auth_signup
  -> mail
  -> html_editor
  -> bus
  -> web
  -> base
```

`addons/crm` sits nowhere near this depth: it declares 11 direct depends
(`base_setup`, `base_install_request`, `sales_team`, `mail`, `calendar`, `resource`,
`utm`, `web_tour`, `contacts`, `digest`, `phone_validation` in
`addons/crm/__manifest__.py`), none of them reaching the website/event corner. The
deep chains live in the website/event/sale corner of upstream and are a
manifest-level fact only: they say nothing about Python import depth, which caps at
five path components ([by the numbers](../by-the-numbers.md)).

## The known-limits list as a maintained backlog

The fork's most honest complexity measure is the 22-item "Known limits" list in
`addons/crm/static/src/mobile/README.md`. Each entry names a cost the design
accepted, and the list ships with the feature rather than as scattered markers. Three
ownership buckets run through it:

- **Root cause in another addon (5 items).** The offline systray crash on unknown
  queued methods (`addons/web`, patched around from `addons/crm/static/src/webclient/offline_systray_patch.js`),
  the mail composer and follower actions on non-`crm.lead` chatters (`addons/mail`),
  the manifest `start_url` opening the first app and the `/odoo/crm` string-vs-numeric
  action-id mismatch (`addons/web`'s manifest and keying), and the cosmetic lingering
  Save/Discard indicator (`addons/web`). Under the scope rule these stay open
  indefinitely.
- **Consequences of binding rules (4 items).** Offline-created leads can't take
  activities or be won until sync (the chained-id rule), stage/group delete and
  reorder disabled (the no-new-producers rule), list cell editing disabled
  (`_multiSave` has no queue producer), mark won updating only after replay (queue
  semantics). Closing these would break `AGENTS.md` section 4.
- **The rest: framework cache semantics and product choices.** Partner and contact
  lookup limited to what earlier online searches cached, the view switcher limited to
  mounted view types, one2many sub-lists read-only, the phone list without selection
  checkboxes, and the "New Lead" shortcut showing the cached pipeline offline —
  candidates the fork could narrow inside `addons/crm/`, each a known-limits entry
  first and a code change only after that.

The full list with per-item detail lives in
[mobile CRM](../apps/crm/mobile-crm.md); this page only tracks it as the backlog it is.

## Key sources

| Source | What it holds |
| --- | --- |
| `addons/crm/static/src/mobile/README.md` | The 22-item known-limits backlog |
| `addons/crm/static/src/mobile/offline_inventory.md` | The fork's largest single artifact and its revision history |
| `AGENTS.md` | The scope rule that separates upstream hotspots from fork-actionable ones |
| `find`/`wc -l`/`awk` census output | The counts above, reproducible with the noted commands |

## Related pages

- [Cleanup opportunities](index.md) for the hub and the theme
- [TODOs and FIXMEs](todos-and-fixmes.md) for the marker census
- [By the numbers](../by-the-numbers.md) for repository-wide size, activity, and dependency measurement
- [Mobile CRM](../apps/crm/mobile-crm.md) for the known-limits list in context
- [Design decisions](../background/design-decisions.md) for the rules behind the rule-governed limits
