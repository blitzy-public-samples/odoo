# Lore

This repository tells two stories on top of each other: a TinyERP server trunk from December 2006 that grew into Odoo 20.0 over 211,574 commits, and a six-day fork in the fall of 2026 that turned the CRM into an offline, mobile-first app without leaving `addons/crm/`. The page below is the chronology; what the code does today is on the other pages.

*Every date comes from git in this clone, checked against `origin/20.0` and the fork branch on 2026-10-07. Dates are commit author dates unless the text says otherwise. Counts marked "sampled" are January 1 snapshots, and file-touch counts use `git log --follow`, so they survive renames.*

## Eras

### TinyERP trunk (December 2006 to September 2008)

The first commit is `004a0b996ff`, "New trunk", on 2006-12-07, and all 123 commits of 2006 land in that one December. The tree was a server: `bin/` with the addons inside `bin/addons`, plus `doc/`, `man/` and a `setup.py`. crm, hr, sale and stock are all there from the first commit, as is `res_partner.py`. Every module shipped a `__terp__.py` manifest — the TinyERP name was baked into the file layout. The rename came in September 2008: "tinyerp -> openerp" on 2008-09-02, "Rename Tiny ERP to OpenERP" on 2008-09-10.

### OpenERP growth and the assembled monorepo (September 2008 to March 2011)

Commit volume grew from 3,621 in 2008 to 16,436 in 2010, and kept climbing to a 26,007 peak in 2012. The tree grew by absorbing its sibling projects, and the splices are still visible: the history has seven root commits ([Fun facts](fun-facts.md) lists them), of which "Initial commit, .gitignore" (2009-04-21) and "[IMP] Piratepad web addons." (2010-10-15) record the addons projects joining, so that by June 2009 `addons/` sat beside `bin/` at the top level. The Launchpad heritage shows elsewhere: `.bzrignore` files in the trees until May 2014, and merge commits citing `lp:` URLs through 2012. April 2010 renamed `__terp__.py` to `__openerp__.py` (2010-04-19) and split lead and opportunity out of crm into their own model — `crm_lead.py` was born on 2010-04-28.

### The web client, the website, and the Odoo name (March 2011 to August 2019)

The GTK client that gave TinyERP its desktop UI never lived in this repository; this tree was the server, and the client was a separate project, so the GTK retirement cannot be dated from here. The arrival of its replacement can: "openobject is dead long live to openerpweb" (2011-03-02) merged the web client in, 1,183 insertions including a 661-line `LICENSE.web` and an `openerpweb/` package. The website builder began on 2013-06-24 as "[WIP] website module", the first commit on `addons/website`'s manifest. February 2014 added the route that converts all reports to PDF through wkhtmltopdf (2014-02-12). May 2014 replaced `.bzrignore` with `.gitignore`, "as we are now working with git" (2014-05-16, fixed 2014-05-28). July 2014 renamed the product: "[REF] OpenERP --> Odoo in various UI texts" on 2014-07-09, with a second pass on 2014-07-18. The web client got its own module system on 2015-03-09, and the Python package `openerp` became `odoo` on 2016-09-02 — the same day the manifests became `__manifest__.py` under the "v10 naming convention".

### The OWL rewrite (August 2019 to 2022)

Owl 1.0.0-beta1 was vendored on 2019-08-23 ("add owl 1.0.0-beta1 to odoo"). The rewrite then ran for nearly two years: "Control panel Owl" (2020-03-11) was the first large piece, the pre-OWL client files were moved into `static/src/legacy/` on 2021-04-01 ("move legacy files"), and "rewrite the webclient in OWL (phase 1)" landed on 2021-05-31. The code adapted to Owl 2 on 2022-02-02, and `@odoo/owl` became its own module on 2022-10-19. `relational_utils.js` — the file that would later hold the offline Many2X cache — was born inside this rewrite, on 2022-06-23 ("kanban, list and form views in owl").

### Quiet maturation (September 2022 to 2024)

Commit volume settled between 7,000 and 12,000 a year, and the visible changes were removals and unbundlings. `ir_translation.py` was deleted on 2022-09-01 by "store translated fields as JSONB columns". Spreadsheet moved into community on 2022-09-06. The PWA machinery this fork leans on — the service worker and the web-manifest controller — moved into community on 2023-07-20. The release cadence in `odoo/release.py` marks the years: 17.1 alpha on 2023-10-25, 18.1 alpha on 2024-09-19.

### Odoo 20 and the offline framework (2025 to September 2026)

The offline stack the fork builds on did not arrive in one piece; it accreted in `addons/web` across sixteen months, from April 2025 to August 2026, each commit adding one capability on the last: the encrypted IndexedDB wrapper on 2025-04-03 (born as a cache for actions and views), offline error handling on 2025-10-20, the offline action helper on 2026-01-19, the offline systray together with offline record creating and editing on 2026-01-28, the encryption helper and offline many2x field support on 2026-03-17, the OfflinePlugin itself on 2026-06-29, the ui plugin on 2026-07-30, and the bottom-sheet plugin on 2026-08-24. The `static/src/core/offline/` directory collected 27 commits between 2026-06-29 and 2026-08-19. The same stretch emptied the old world out: still-used legacy public code moved on 2026-02-19, QUnit was removed on 2026-03-17, jQuery was removed from all assets on 2026-06-10, the in-house paper-muncher PDF engine was integrated on 2026-05-07, and Owl 3 arrived with a compatibility layer on 2026-05-20. `odoo/release.py` records 19.1 alpha on 2025-09-05 and `[REL] 20.0` on 2026-09-11. The last commit on `origin/20.0`, "[FIX] mail: duplicate notifications", is dated 2026-09-24 by committer date.

### The fork (September 30 to October 5, 2026)

Nineteen days after the 20.0 release, a single author (bobbyabbott421-glitch) started 76 commits that made the CRM offline-capable and mobile-first. All but two of them touch only `addons/crm/`; the two setup commits are the `scripts/dev` tooling (2026-09-30, 845 lines) and the wiki, agent guidelines and offline QA skill (2026-09-30). The rest split into five milestones and a close-out, told below. A branch named `backup/pre-agents-fix-1d4c8f96` freezes the tree as it stood at 2026-10-03 02:01, the end of milestone 2's fix rounds. The wiki pages themselves were still being rewritten, uncommitted, on 2026-10-07. See [Architecture](overview/architecture.md) for what the fork actually built.

## The fork's five milestones

### Milestone 1: the offline surface inventory (September 30 to October 1, 2026)

The first CRM commit, 2026-09-30 at 23:38, added a 363-line inventory at `addons/crm/static/src/mobile/offline_inventory.md` that classifies every CRM entry point needing a server as QUEUE, SKIP or DISABLE. Five scrutiny rounds closed between 2026-10-01 00:27 and 02:30, a user-testing gap pass at 02:55, and a milestone-2 review was applied at 07:08. The document keeps its own revision ledger and finished at 1,248 lines and 150 rows: 26 QUEUE, 9 SKIP, 115 DISABLE. See [Offline surface inventory](apps/crm/offline-surface-inventory.md).

### Milestone 2: offline fixes and queue semantics (October 1 to October 3, 2026)

The foundation commit at 2026-10-01 07:43 laid `offline_hooks.js` — `useCrmOffline()`, the one place CRM code reads offline state — plus its first tests, 392 lines across 8 files. From there the guards went in one commit at a time through 2026-10-02 05:47: the rainbowman lookup, the team switcher, the recurring-revenue probe, the AI-probability switch, kanban group controls, config and report lists, list cell editing, action and cog menus, the tag color popover, many2one links. Queue-semantics tests landed 2026-10-01 15:01 (replay order, no conflict dialog, rejected-replay parking), hoot proofs that framework-disabled controls stay unusable on 2026-10-02 07:36, and the close-out — cross-cutting re-enable test, QA, wiring — at 09:03. Scrutiny rounds 1-3 and two user-testing evidence rounds followed through 2026-10-03 02:01.

### Milestone 3: data coverage (October 3 to October 4, 2026)

From 2026-10-03 15:22 the work turned to the offline data itself: cold-start fixes showing the cached pipeline and selected team (15:22), framework data-coverage proofs at 15:40 (477 lines, including a 404-line queue-replay test), mark-won at 15:59, the activity panel on the lead form at 19:17, contact lookup through the many2x cache at 19:42 (working on phones by 20:21), close-out tests at 20:53, and the team switcher's "All Teams" fallback on a true cache miss at 22:02. Two server-side helpers date from this milestone so that activity writes can be queued: `action_log_call()` in `models/crm_lead.py` (2026-10-03 16:21) and the `res_model_id` derivation in `models/mail_activity.py`. The Schedule and Log-a-call fixes ended 2026-10-04 00:59, with the M3 user-testing round closing at 01:20.

### Milestone 5: the mobile suite (October 4, 2026)

Built between 2026-10-04 01:42 and 16:46: the mobile offline hooks extension (01:42), the mobile pipeline showing one stage at a time under a fixed header of stage name, count and expected revenue (02:44), the mobile lead card (03:29), and the bottom-sheet quick create (04:12). Then the corrections: reload only the synced stage (11:29), header refresh after sync (12:26), scrutiny round-1 blockers 1-6 (13:43), the card's priority control as blocker 7 (14:04), and the folded-stage fetched-state fixes ending 16:46. Lead creates still sitting in the queue render as non-clickable pending cards. See [Mobile CRM](apps/crm/mobile-crm.md).

### Milestone 4: evidence and PWA (October 4, 2026, evening)

The plan's numbering and the calendar disagree here: milestone 4 landed after milestone 5's build, between 17:54 and 19:33 on 2026-10-04. Its evidence commit strengthened the mobile pipeline and quick-create tests by 393 lines, which reads as a QA close-out of the mobile suite rather than a step before it. The PWA shortcuts "My Pipeline" and "New Lead" followed at 18:23 (the CRM webmanifest controller subclass, 159 lines with its routes test), and the offline end-to-end tour with the pipeline-to-reconnect check at 19:33 (317 lines, tour plus HttpCase).

### The close-out (October 4 to October 5, 2026)

From 2026-10-04 20:05: `crm_test_helpers.js` was restored and `mockCrmOffline` moved (20:05), the cold-start WebClient's mail.store fetch was flushed before destroyApp (20:47), M5's user-testing round-1 online-guard gaps were closed (22:16), and the team switcher's reconnect took three commits to harden — the re-probe against a brief online flip (23:30), then bypassing `user.hasGroup`'s poisoned cache (2026-10-05 00:26). The last commit, 2026-10-05 00:59, added the 160-line developer README at `addons/crm/static/src/mobile/README.md`.

## Longest-standing features

- `res_partner.py` traces back through every rename to "New trunk" (2006-12-07). Counting across the renames, 861 commits have touched it; on its current path alone, 385.
- The crm addon was in the first commit. Its manifest has been `__terp__.py`, `__openerp__.py` and `__manifest__.py`, and 407 commits have touched it across those three names.
- `crm_lead.py` is younger: lead and opportunity were split out of crm on 2010-04-28, and 1,144 commits have touched it since.
- sale, stock and hr were all in the trunk's first commit (2006-12-07); their manifests have collected 318, 373 and 205 commits respectively.

## Deprecated features and rewrites

**The GTK client.** It never lived in this repository — this tree was the server, the client was a separate project — so its retirement cannot be dated from here. The arrival of its replacement can: the web client merged in on 2011-03-02 with "openobject is dead long live to openerpweb".

**The jQuery-era web client.** It got a module system on 2015-03-09 and ran until the OWL rewrite. Its files moved into `static/src/legacy/` on 2021-04-01, the webclient was rewritten in OWL on 2021-05-31, and the leftovers left in three waves in 2026: still-used legacy public code on 2026-02-19, QUnit on 2026-03-17, jQuery itself on 2026-06-10. The tree now has neither `static/src/legacy/` nor `static/src/js/`.

**`ir.translation`.** The model was deleted on 2022-09-01 by "store translated fields as JSONB columns"; translated values moved onto JSONB columns on each model. `odoo/addons/base/models/ir_translation.py` no longer exists.

**Report engines.** The trunk's reports were RML — a 2008-06-04 commit still discusses `blockSpan` in RML. The wkhtmltopdf route landed 2014-02-12 and carried PDF generation for twelve years. Paper-muncher, an in-house C++ engine, was integrated on 2026-05-07, opt-in per report at first; the integrating commit still calls wkhtmltopdf the default.

**Names.** The manifest filename is a fossil record: `__terp__.py` from the trunk until 2010-04-19, `__openerp__.py` until 2016-09-02, `__manifest__.py` since — the same day the `openerp` package became `odoo`.

## Growth trajectory

Commits per year on `origin/20.0`, by author date (2026 runs through late September):

| Year | Commits | Year | Commits |
| --- | --- | --- | --- |
| 2006 | 123 | 2017 | 7,823 |
| 2007 | 1,730 | 2018 | 8,568 |
| 2008 | 3,621 | 2019 | 9,515 |
| 2009 | 3,747 | 2020 | 7,478 |
| 2010 | 16,436 | 2021 | 7,237 |
| 2011 | 16,268 | 2022 | 9,928 |
| 2012 | 26,007 | 2023 | 11,693 |
| 2013 | 13,686 | 2024 | 13,705 |
| 2014 | 11,546 | 2025 | 16,154 |
| 2015 | 7,457 | 2026 | 12,086 |
| 2016 | 6,766 | | |

The 2010-2012 peak is the OpenERP v6-v7 push. The years from 2015 to 2021 ran at roughly half that rate; the commit messages do not say why, and the slowdown appears to be a change in commit granularity as much as a change in output. Volume then climbed again through 2022-2025.

Addon counts, sampled on January 1 of each year by counting manifest files (`__terp__.py` before 2010, `__openerp__.py` until 2016, `__manifest__.py` after):

| January 1 | Addons | January 1 | Addons |
| --- | --- | --- | --- |
| 2007 | 110 | 2016 | 208 |
| 2010 | 118 | 2020 | 329 |
| 2013 | 205 | 2024 | 490 |

The 20.0 branch tip carries 642 addon directories, 641 with manifests. Most of the recent growth is localizations: 47 `l10n_*` addons in January 2013, 79 by 2020, 136 by 2024, 206 by January 2026 and 229 today — more than a third of the tree. The website family went from nothing before June 2013 to 43 addons by 2020 and 57 by January 2024, then settled at 52, likely folded into other addons; the hr family grew from 12 in 2013 to 24. Spreadsheet joined community on 2022-09-06.

The fork is the outlier in every direction: 35,341 lines across 206 files in six days, 25,232 of them in `addons/crm/`, and 76% of the CRM lines are tests. [By the numbers](by-the-numbers.md) carries the tables behind these figures.

## Related pages

- [Architecture](overview/architecture.md)
- [By the numbers](by-the-numbers.md)
- [Offline surface inventory](apps/crm/offline-surface-inventory.md)
- [Mobile CRM](apps/crm/mobile-crm.md)
- [Fun facts](fun-facts.md)
