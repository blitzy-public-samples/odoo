# Pitfalls

Active contributors: bobbyabbott421-glitch (fork), Odoo SA (upstream)

## Purpose

These are the traps that bite contributors in this repo, each with its symptom, its fix, and a pointer into the tree. Most of them produce a silent wrong result rather than a loud failure, which is what makes them expensive. Read this page before trusting a green test run, debugging "offline doesn't work", or copying API names from memory or older documentation.

## The pitfalls

### Test runs can be green while testing nothing

Symptom: a test command exits 0 in seconds and you move on, but nothing ran. Three separate modes produce this: Odoo exits 0 having collected 0 tests when the module was not installed or updated in that run; the JS suites in `addons/web/tests/test_js.py` are only collected with `-u crm,web`; and browser tests skip themselves, still exiting 0, when a dependency like `websocket-client` or Chrome is missing. The log actually says so: `logs/test-py-TestCrmOffline.log` records "0 failed, 0 error(s) of 0 tests", and Odoo still exited 0. Fix: run everything through `scripts/dev/test-py.sh` and `scripts/dev/test-js.sh`, which grep the log for `of 0 tests` and `: skipped ` and fail (`scripts/dev/_common.sh`, `assert_tests_selected` and `assert_no_skips`). Details in [testing](../how-to-contribute/testing.md).

### Asset bundles go stale after front-end changes

Symptom: a js/scss/xml change has no visible effect, or a JS test fails for a reason that no longer matches the source. Asset bundles are generated at install/upgrade time and served as attachments, so the browser keeps getting the old bundle until it is regenerated. Fix: run `./scripts/dev/rebuild-assets.sh` after every front-end change and before re-testing; `AGENTS.md` calls a result obtained from a stale bundle "not a real result". See [assets](../systems/assets.md).

### Offline features need a secure context

Symptom: the offline stack is entirely absent, `navigator.serviceWorker` is undefined, and queuing an ORM write throws `NonSecureContextError`, all because the page was opened over plain http on a host other than localhost (for example through a port forward). Browsers only grant the storage and crypto APIs the stack is built on inside a secure context, so the framework disables offline rather than storing unencrypted. Fix: use `./scripts/dev/start.sh --https`, which terminates TLS with a self-signed certificate on 8069 and proxies to Odoo on 8070 (`scripts/dev/start.sh`). See [offline and PWA](../features/offline-and-pwa/index.md).

### `TestCrmOffline` does not exist

Symptom: `./scripts/dev/test-py.sh TestCrmOffline`, the example given in `AGENTS.md` and `scripts/dev/README.md`, runs 0 tests (the wrapper then fails the run for exactly that reason). No such class exists anywhere in the tree; the real crm test classes are names like `TestCRMLead`, `TestCrmPls`, `TestLeadAssign`, and `TestUi` in `addons/crm/tests/`. Fix: pick a class that exists, and take the general lesson: names in this repo's docs are illustrative and were not all verified against the code. See [testing](../how-to-contribute/testing.md).

### Documentation lags the 20.0 API

Symptom: code written from upstream documentation, tutorials, or pre-20.0 memory fails at load or render. Upstream docs still describe `ir.model.access` + `ir.rule` (unified into `ir.access` here), `attrs=` in view archs, `name_get`, `<tree>`, and older `read_group` signatures, none of which exist in this revision. Fix: confirm an API exists in this tree before using it, by grepping the ORM or a live usage; `skills/odoo-review/SKILL.md` ("Version traps") makes this the standing rule for reviewing too.

### The POS disables the fork's offline plugin

Symptom: offline queue behavior, the offline systray, and button disabling behave differently or not at all inside point_of_sale sessions, and you start debugging the web plugin for nothing. There are two offline stacks: `addons/point_of_sale/static/src/app/plugins/offline_plugin.js` patches the fork's `OfflinePlugin.setup` to skip its setup and set `_crypto = false` in POS / Self-Ordering mode, because the POS wants its own UI to remain functional offline. Fix: when investigating offline behavior in the POS, read that patch first, and remember the web plugin is deliberately neutralized there. See [point of sale](../apps/point-of-sale.md) and [design decisions](design-decisions.md).

### `l10n_hr` is Croatia, not human resources

Symptom: grepping for HR / payroll code lands on the Croatian localization, whose manifest is "Croatia - Accounting (Euro)" with `countries: ['hr']` (`addons/l10n_hr/__manifest__.py`), because `hr` is Croatia's ISO code. Payroll itself is absent from this repository entirely: there is no `hr_payroll` addon, and the HR family (`addons/hr/`, `hr_holidays`, `hr_expense`, ...) covers employees, leave, and expenses only. Fix: look for payroll in Odoo's enterprise releases, not here. See [HR suite](../apps/hr-suite.md) and [localizations](../apps/localizations-and-integrations.md).

### `sale` vs `sale_management`

Symptom: installing or depending on the wrong one changes what users get. Both manifests are named "Sales": `addons/sale` is the model layer (sales orders, order lines, templates), while `addons/sale_management` depends on `sale` (and `digest`) and adds the menus, reporting views, and quotation templates that make it an app. Note that `addons/crm` depends on neither, only on `sales_team`, so `sale` enters the picture only when quotations are installed. Fix: depend on `sale` for the models, on `sale_management` only when the app experience is wanted. See [sales suite](../apps/sales-suite.md).

### `ir.rule` and `ir.model.access` are gone

Symptom: security data written from upstream examples (`ir.model.access.csv`, `ir.rule` records) fails to load, and tutorials reference models that do not exist. In 20.0 both are unified as `ir.access` (`odoo/addons/base/models/ir_access.py`), and security CSVs are named `ir.access.csv` (for example `addons/crm/security/ir.access.csv`). Fix: write `ir.access` rows with `operation` (a subset of `crud`), optional `group_id`, and optional `domain`. See [users, groups, and access](../primitives/users-groups-and-access.md) and [security](../security.md).

### OWL 3 lives in the `owl2` directory

Symptom: you look for OWL version boundaries and find the compatibility layer at `addons/web/static/src/owl2/owl3_compatibility_layer.js`, a directory named `owl2` that patches the vendored OWL 3 (`addons/web/static/lib/owl/owl.js`). Imports of `@odoo/owl` resolve through that compat layer, not to raw OWL 3, so new code must use the APIs the layer provides (the plugin/service split, `usePlugin`, signals). Fix: treat `@odoo/owl` as "OWL 3 plus compat", and write new code on the plugin API rather than the legacy service bridges marked `@todo owl3 migration`. See [web client](../apps/web/index.md).

### Git history cannot answer "who wrote this"

Symptom: `git log`, `git blame`, and per-author statistics return almost nothing meaningful, because the entire `20.0` base is one squashed commit (an upstream mail fix message with an `X-original-commit` trailer) that also contains the offline framework without attribution, plus one `scripts/dev` commit on top. Nothing records why it was squashed. Fix: date and attribute nothing from git in this repo, read the code instead, and see [lore](../lore.md) for what the two commits actually tell you.

## Related pages

- [Design decisions](design-decisions.md) for the reasoning these pitfalls hang off
- [Testing](../how-to-contribute/testing.md) and [debugging](../how-to-contribute/debugging.md) for the workflows that catch these traps
- [Assets](../systems/assets.md), [offline and PWA](../features/offline-and-pwa/index.md), and [test framework](../systems/test-framework.md) for the subsystems behind the biggest three
