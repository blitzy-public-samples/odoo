# Lore

Active contributors: Odoo SA (upstream)

## A caveat before the story

This clone's git history is squashed to two commits, so per-commit archaeology is impossible here. There is no way to bisect a bug to the change that introduced it, no way to see who wrote which line of the offline stack, and no way to date anything between the birth of Odoo and August 2026. Everything below comes from three sources that do survive squashing: commit metadata on the two commits, `odoo/release.py`, and the shape of the files themselves. You can reproduce the commit evidence with `git log --format=full`. Where the evidence is thin, the text says so.

## Era 1: the upstream lineage (2005 to 2026)

Odoo started as TinyERP, written by Fabien Pinckaers in 2005, was open-sourced and renamed OpenERP, and became Odoo in May 2014 when the product moved from an ERP-only positioning to a suite of business apps. That history is not recorded in this repository, it is the public history of the upstream project, and none of it is verifiable from this tree.

What is verifiable is where this snapshot sits in that line. `odoo/release.py` pins `version_info = (20, 0, 0, FINAL, 0, '')`, so this is the 20.0 series at final release level, requiring Python 3.12 to 3.14 (`MIN_PY_VERSION`, `MAX_PY_VERSION`) and PostgreSQL 16 or later (`MIN_PG_VERSION`). The `author` field still reads `OpenERP S.A.`, a leftover from before the 2014 rename.

The snapshot was taken at a specific upstream commit. The base commit is authored by Maryam Kia of Odoo SA on 2026-08-13, titled `[FIX] mail: duplicate notifications`, and its trailer reads `X-original-commit: ca58f5676aa5874c24b79c834b1f5f7918b2b076`. That trailer is the graft point: it names the upstream commit this tree corresponds to. The commit body describes one small bug, a chatter mention arriving twice, but the commit itself carries the entire 642-addon codebase, because of the squash.

## Era 2: the offline fork (by 2026-08-13)

By the date of that base commit, the offline and PWA framework was already present in `addons/web`: the offline plugin and its ORM sync queue (`addons/web/static/src/core/offline/offline_plugin.js`), the encrypted IndexedDB wrapper (`addons/web/static/src/core/utils/indexed_db.js`) and its AES-GCM helper (`addons/web/static/src/core/crypto.js`), the service worker (`addons/web/static/src/service_worker.js`), the web-manifest controller (`addons/web/controllers/webmanifest.py`), the offline systray (`addons/web/static/src/webclient/offline_systray/offline_systray.js`), the offline action helper (`addons/web/static/src/views/offline_action_helper.js`), the Many2X cache in `addons/web/static/src/views/fields/relational_utils.js`, the bottom-sheet dialog (`addons/web/static/src/core/bottom_sheet/`), and the small-screen signal (`addons/web/static/src/core/ui/ui_plugin.js`).

All of it is fused into the squashed base commit, so none of it carries distinct attribution. There is no way to tell from git which parts came from upstream 20.0 and which the fork added, or in what order the pieces landed. The only surviving statement of intent is `AGENTS.md` at the repo root (untracked), which documents the framework's rules: never build a second offline engine, never change the queue's last-write-wins conflict semantics, gate mobile behavior on the small-screen signal, keep changes inside `addons/crm/` so the fork stays rebasable onto upstream 20.0. See [design decisions](background/design-decisions.md) for why those rules read the way they do.

## Era 3: the tooling commit (2026-09-30)

The single fork-attributed commit in this clone is `[ADD] scripts/dev: reproducible local dev environment` by bobbyabbott421-glitch, dated 2026-09-30, adding roughly 850 lines under `scripts/dev/`. Its message is unusually specific about why it exists, and it is the best surviving record of what actually hurt during development:

- `requirements.txt` does not pin `websocket-client` or `phonenumbers`. Without the first, every browser test skips itself while the run still exits 0. Without the second, five crm Python tests fail on phone formatting. `scripts/dev/setup.sh` installs both.
- `odoo-bin` exits 0 when no test matched the tags, and when a browser test skipped itself. The test wrappers therefore parse the run log rather than trusting the exit code.
- Odoo only collects tests from modules updated during a run, and `-u crm` never updates `web`, so the JS suites defined in `addons/web/tests/test_js.py` are silently never collected unless the run passes `-u crm,web`.

Three separate ways for a test run to report success while testing nothing. The tooling era, such as it is, is one commit long and is mostly about not being lied to by the test runner.

## Longest-standing features

These belong to upstream history, not to this fork, and the repository cannot date them:

- The `ir.*` system-model registry design. Everything configurable in Odoo, views, menus, actions, crons, access, attachments, is itself a record in an `ir.*` model under `odoo/addons/base/models/`. This design has survived every major rewrite since the TinyERP days.
- The active-record ORM: model classes declare fields, recordsets behave like collections, and `_inherit` extends another module's model in place rather than modifying it. The implementation moved (see below), the programming model did not.
- The addon model: a directory with a `__manifest__.py` declaring `depends`, `data` and `assets`, ordered into a dependency graph at load time. It dates to the OpenERP 5 era by the usual accounts, and is the reason the tree holds 642 independently installable modules.
- `crm.lead` (`addons/crm/models/crm_lead.py`) is one of Odoo's oldest apps, present since the TinyERP days, and in this tree it is a 2,871-line model. It is also the fork's whole reason for existing.

## Deprecated and removed in this 20.0 codebase

The 20.0 tree has shed a lot of API that older Odoo documentation still describes. These are the traps most likely to bite someone arriving from an earlier version, and `skills/odoo-review/SKILL.md` warns about exactly this class of error under its "Version traps" heading, telling reviewers to grep the ORM source at the revision under review rather than trusting a remembered API:

- **`ir.rule` is gone.** No model in this tree declares `_name = 'ir.rule'`. Access rights and record rules are unified into a single `ir.access` model (`odoo/addons/base/models/ir_access.py`), which carries both a CRUD selection and an optional `domain` field: "The operations will only be allowed for records in this domain". Enforcement runs through `BaseModel._access_domain` in `odoo/orm/models.py`. Security files are named `ir.access.csv` now, for example `addons/crm/security/ir.access.csv`.
- **`odoo/osv/` is gone.** The old `osv` compatibility package no longer exists.
- **`name_get` and `attrs=` no longer exist**, along with `<tree>` and `read_group`, per the version-traps list in `skills/odoo-review/SKILL.md`. The only remaining `name_get` in the core tree is a local helper variable in a test.
- **The legacy service bridges are explicitly temporary.** Seventeen files under `addons/web/static/src/` carry a `@todo owl3 migration` marker on a legacy service wrapper, including `addons/web/static/src/core/offline/offline_plugin.js:489`, `addons/web/static/src/core/bottom_sheet/bottom_sheet_plugin.js:67`, `addons/web/static/src/core/dialog/dialog_plugin.js:122` and `addons/web/static/src/core/hotkeys/hotkey_plugin.js:453`. New code is supposed to use the plugin API and let those bridges die.

## Major rewrites visible in the tree

You cannot see the rewrites happen, but you can see their scar tissue.

**The ORM extraction.** The implementation now lives in `odoo/orm/` (`models.py`, `registry.py`, `environments.py`, `domains.py`, and a family of ten `fields_*.py` modules). The classic import paths survive as packages whose `__init__.py` re-exports from there, and each one states the reason in its second line: `odoo/models/__init__.py` says "This is a `__init__.py` file to avoid merge conflicts on `odoo/models.py`". The same comment appears in `odoo/api/__init__.py` and `odoo/fields/__init__.py`. So the top-level `odoo/models.py`, `odoo/fields.py` and `odoo/api.py` files no longer exist at all, they were replaced by same-named packages specifically so that in-flight branches touching the old files would not conflict on rename.

**OWL 3 behind a directory called `owl2/`.** The vendored library at `addons/web/static/lib/owl/owl.js` is OWL 3, and every module imports it as `@odoo/owl`, but the compatibility shim lives in `addons/web/static/src/owl2/owl3_compatibility_layer.js`. Its header calls itself "a temporary bridge to ease incremental migration from Owl 2 to Owl 3" and lists the mechanical steps: rename `t-portal` to `t-custom-portal`, rename `t-model` to `t-custom-model`, replace every `useEffect` with `useLayoutEffect`. The directory name records which side of the migration the code in it is for.

**Domains became an AST.** `odoo/orm/domains.py` opens by describing the domain as "a first-order logical expression" represented as an AST of n-ary `AND`/`OR`, unary `NOT`, boolean constants and `(expression, operator, value)` conditions. The older nested-list representation is still what you write in Python, but it is parsed into this structure before it reaches SQL.

## Growth trajectory

The tree holds 642 addons in `addons/`, of which 229 are `l10n_*` localizations, more than a third of the module count. Translations are the other bulk contributor: over 20,000 `.po` files are tracked. The core is comparatively small against that; the largest single Python file is not an ORM file but `addons/account/models/account_move.py` at 8,339 lines, against 6,617 for `odoo/orm/models.py`.

Read honestly, the codebase appears to have grown mostly sideways, by adding country packs, payment providers and app families, rather than by inflating its core. That is an inference from current file counts, not from history this repository can show. Exact figures are in [by the numbers](by-the-numbers.md).

## Related pages

- [Architecture](overview/architecture.md)
- [By the numbers](by-the-numbers.md)
- [Design decisions](background/design-decisions.md)
- [Fun facts](fun-facts.md)
