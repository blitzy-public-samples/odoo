# TODOs and FIXMEs

A census of deferred-work markers in `odoo/` and `addons/`, taken on 2026-10-07 at
`30955b57688`. This page reports; it fixes nothing. Marker comments identify deferred
compatibility, migration, testing, and design work — a census is a reading guide, not a
defect list, and most of what it finds belongs to upstream.

## The census

Commands (case-sensitive, all three markers):

```sh
rg -c "TODO|FIXME|HACK" --no-messages odoo addons | sort -t: -k2 -rn | head -20
rg -o "TODO|FIXME|HACK" odoo addons --no-messages | wc -l
```

Totals: **2,246 occurrences across 1,468 files** — TODO 1,112, FIXME 1,107, HACK 27.
Excluding vendored libraries (`**/static/lib/**`), 2,003 occurrences across 1,435
files, so vendored code carries about a tenth of the markers but owns the top of the
per-file table:

| File | Marker lines |
| --- | ---: |
| `addons/web/static/lib/fullcalendar/core/index.global.js` | 105 |
| `addons/web/static/lib/zxing-library/zxing-library.js` | 26 |
| `addons/test_mail/tests/test_mail_composer.py` | 19 |
| `addons/web/static/lib/fullcalendar/interaction/index.global.js` | 15 |
| `addons/web/static/lib/fullcalendar/daygrid/index.global.js` | 14 |
| `addons/web/static/lib/fullcalendar/timegrid/index.global.js` | 13 |
| `odoo/addons/base/tests/test_ir_actions.py` | 9 |
| `addons/stock/tests/test_move2.py` | 9 |
| `addons/payment_adyen/tests/test_adyen.py` | 9 |
| `addons/spreadsheet/static/lib/chartjs-chart-geo/chartjs-chart-geo.js` | 8 |
| `addons/website_sale/controllers/main.py` | 7 |
| `addons/web/static/tests/views/list/list_view.test.js` | 7 |
| `addons/mail/static/lib/odoo_sfu/odoo_sfu.js` | 7 |
| `addons/mail/static/lib/lame/lame.js` | 7 |
| `addons/l10n_fr_pdp/views/account_move_views.xml` | 7 |
| `addons/html_editor/static/tests/utils/selection.test.js` | 7 |
| `addons/website_sale/static/src/website_builder/donation/donation_option_plugin.js` | 6 |
| `addons/website/static/src/scss/website.scss` | 6 |
| `addons/stock_account/tests/test_stockvaluationlayer.py` | 6 |
| `addons/spreadsheet/static/src/o_spreadsheet/o_spreadsheet.js` | 6 |

Census caveats, worth stating because they change the reading:

- **Case sensitivity.** The uppercase pattern misses lowercase markers: 25 `@todo`
  occurrences live in `addons/web/static/src/` alone, including the temporary
  OWL-2-to-3 service bridges (for example
  `addons/web/static/src/core/offline/offline_plugin.js:489`, the legacy `"offline"`
  service wrapper). The headline 2,246 therefore undercounts by at least that family.
- **Vendored dominance.** The top two files are vendored libraries; marker "debt" there
  is upstream-vendor noise, not actionable work.
- **Markers are not defects.** A `FIXME` in an upstream test documents a known
  behavior question (see the `TDE FIXME` cluster below); removing it would delete
  information, and `AGENTS.md` forbids weakening existing tests.

## Upstream debt (out of the fork's scope)

The scope rule confines changes to `addons/crm/` (see
[design decisions](../background/design-decisions.md)), so everything below is context,
not a cleanup candidate.

### Core compatibility and migration seams

- `odoo/tools/config.py:493` — "TODO sensible default for the three following limits."
  (the three multiprocessing memory limits; the file's first TODO-introducing commit
  is dated 2016-09-02).
- `odoo/tools/config.py:790-797` — "TODO saas-22.1: remove support for the empty
  db_replica_host" and its saas-21.1 sibling, old-SaaS compatibility retained in the
  core config.
- `odoo/http/session.py:78` — "TODO: remove `84` length when v18.4 is deprecated";
  `:321` — "TODO (v20): remove backward compatibility". The file's TODO population
  was last touched 2025-12-19.
- `odoo/modules/migration.py:48` — "FIXME handle version >= saas~100 (expected in year
  2106)" — the version-comparison edge case; the file's FIXME population was last
  touched 2023-04-13.
- `odoo/orm/models.py:394` and `:492` — pool-vs-registry disentangling and the old-API
  `_translate` flag, both deferred inside the extracted ORM.

### Web-client migration bridges

The OWL 2-to-OWL 3 transition is the biggest self-aware debt cluster in
`addons/web/static/src/`: 25 lowercase `@todo` markers, each on a legacy service
wrapper the plugin API is meant to replace. `AGENTS.md` names the contract: new code
uses the plugin API (Plugin, usePlugin, signal), never the bridges marked
`@todo owl3 migration`. These are upstream's plan, not the fork's.

### Business addons and tests

Typical upstream markers: `addons/mail/models/mail_activity.py:740` ("Fix void res_id
on attachment when you create an activity with an image"),
`addons/website_sale/controllers/main.py` (7 marker lines; its first TODO-introducing
commit is dated 2013-08-05), and large test files that encode
fixtures and known gaps (`addons/test_mail/tests/test_mail_composer.py`, 19 marker
lines).

## CRM-scope debt (inside the fork's reach, upstream-owned)

`addons/crm/` holds 20 markers on 20 lines across 10 files — all of them pre-fork
upstream comments, not fork work:

- `addons/crm/models/crm_lead.py:2679` — "TODO : check if we need to handle specific
  team_id stages [for lost count]" (the file's TODO population was last changed
  2021-07-02, first introduced 2016-04-26).
- `addons/crm/models/crm_stage.py:45` — "TODO stop hardcoding ids in tests and remove
  this".
- `addons/crm/models/res_config_settings.py:164` — "TDE FIXME: re create cron if not
  found ?"
- The `TDE FIXME` cluster in the conversion and merge tests
  (`addons/crm/tests/test_crm_lead_convert.py:143,161,171,239`,
  `addons/crm/tests/test_crm_lead_convert_mass.py:109,203`,
  `addons/crm/tests/test_crm_lead_merge.py:219,235,238`,
  `addons/crm/tests/test_crm_pls.py:926`) records long-standing behavior questions
  around team/stage recomputation on convert and merge.
- `addons/crm/tests/common.py:406` and `:657` — email-normalization and
  merge/assignment conditions (TODO population dating to 2021-03-26), plus
  `addons/crm/tests/test_sales_team_ui.py:13`.

These are the only markers the fork could technically act on, and even then they
describe upstream behavior questions (team-specific stages, lost-count semantics)
where a "cleanup" would change CRM behavior — each needs a regression test and a
check against upstream intent, not a drive-by deletion.

## Fork debt: zero markers, a list instead

All 92 files the fork added under `addons/crm/`
(`git diff --name-only --diff-filter=A origin/20.0..HEAD -- addons/crm`) contain
**no** TODO/FIXME/HACK markers. The fork tracks its deferred work in prose instead: the 22-item "Known
limits" list in `addons/crm/static/src/mobile/README.md` and the "Superseded"
annotations in `addons/crm/static/src/mobile/offline_inventory.md` (the VAL-INV-011
producer reclassification). That choice keeps debt visible in review (a known-limits
entry ships with its fix commit) but means marker scans cannot find fork debt — read
the known-limits list for that.

## Sampled marker ages

`git log -1 --format=%ad --date=short -S'<marker>' -- <file>` dates the *last commit
that changed the file's marker population*, and `--reverse` finds the first such
commit — a population-level proxy, precise per file, not per marker:

| File | First marker-introducing commit | Last population change |
| --- | --- | --- |
| `addons/website_sale/controllers/main.py` | 2013-08-05 | 2025-11-17 (TODO) |
| `odoo/tools/config.py` | 2016-09-02 | 2025-01-27 (TODO) |
| `addons/crm/models/crm_lead.py` | 2016-04-26 | 2021-07-02 (TODO) |
| `addons/crm/tests/common.py` | 2021-03-26 | 2021-03-26 (TODO) |
| `odoo/http/session.py` | 2025-12-19 | 2025-12-19 (TODO) |
| `odoo/modules/migration.py` | — | 2023-04-13 (FIXME) |

## Key sources

| Source | What it holds |
| --- | --- |
| `AGENTS.md` | The scope rule that makes nearly all of this upstream debt, and the "make only the changes the current task needs" rule |
| `addons/crm/static/src/mobile/README.md` | The known-limits list that carries the fork's actual deferred work |
| `rg` census output | The counts and top-file table above, reproducible with the two commands |

## Related pages

- [Cleanup opportunities](index.md) for the hub and the theme
- [Complexity hotspots](complexity-hotspots.md) for the size side of the census
- [By the numbers](../by-the-numbers.md) for repository-wide size and activity
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md) for
  how fork-side work must extend upstream code
