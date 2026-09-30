# Other apps

Active contributors: Odoo SA (upstream)

## Purpose

This page is a roundup of the addons that do not belong to one of the large app families but that other modules depend on constantly. Several are `auto_install` infrastructure rather than apps a user installs, and one of them, `addons/bus`, carries every real-time update in the product. None of them are modified by this fork; they are listed so a reader can find the owner of an unfamiliar model.

## Real-time bus

`addons/bus` is the transport for every push the server makes to a browser: chat messages, activity counters, asset-reload watchdogs, and the notifications the discuss client renders. Despite its historical name ("IM Bus"), 20.0 carries an in-process WebSocket implementation, not long polling. `addons/bus/websocket.py` (1,020 lines) plus `addons/bus/websocket_protocol.py` implement the protocol and per-connection state; `addons/bus/bus_dispatcher.py` runs a `BusDispatcher` thread whose listener loop blocks on a Postgres `LISTEN imbus` and whose worker loops fetch matching rows and forward them to subscribed sockets, tracking each channel as a `ChannelTopic` with a `DispatchState`.

The write side is `addons/bus/models/bus.py`: `bus.bus` rows are inserted and announced with a `NOTIFY` (the function is overridable through the `ODOO_NOTIFY_FUNCTION` environment variable, default `pg_notify`), payloads are split recursively to stay under `NOTIFY_PAYLOAD_MAX_LENGTH` (8000 bytes by default, tunable with `ODOO_NOTIFY_PAYLOAD_MAX_LENGTH`), and rows are garbage-collected after `DEFAULT_GC_RETENTION_SECONDS`, 24 hours. Any model can publish to its own channel by inheriting `addons/bus/models/bus_listener_mixin.py`. On the browser side the connection is owned by a `SharedWorker` so all tabs share one socket, `addons/bus/static/src/workers/bus_worker_script.js` is deliberately removed from the normal bundles and served through the dedicated `bus.websocket_worker_assets` bundle; `multi_tab_plugin.js`, `multi_tab_shared_worker_plugin.js` and `multi_tab_fallback_plugin.js` elect the tab that owns it and degrade when `SharedWorker` is unavailable.

## Foundational data models

`addons/uom` defines units of measure and their categories, and is a dependency of anything that counts things. `addons/resource` holds working schedules: `resource.calendar`, its attendance lines and leaves, `resource.resource`, and `resource.mixin` for models that need a working calendar; CRM depends on it. `addons/analytic` adds analytic plans, accounts and lines plus `analytic.mixin` and `analytic.distribution.model`, the cost-tracking dimension used by accounting, projects and timesheets. `addons/rating` adds the `rating.rating` records behind customer satisfaction stars, and `addons/link_tracker` turns URLs into trackable short links tied to UTM campaigns.

## People, places and things

`addons/contacts` is the UI app around `res.partner`, and it is the reason `addons/web_hierarchy` exists, its org-chart view type (`hierarchy_arch_parser.js`, `hierarchy_card.js`) renders the company tree. `addons/calendar` owns `calendar.event`, recurrences, attendees and alarms, and links meetings to activities through `models/mail_activity.py` and `mail_activity_mixin.py`; `google_calendar` and `microsoft_calendar` synchronise it both ways (see [localizations and integrations](localizations-and-integrations.md)). CRM depends on `calendar` for the "schedule a meeting" activity path, see [CRM](crm/index.md). `addons/fleet` tracks vehicles, models and brands, odometer readings, service logs and contracts, with `fleet_maintenance` as the glue to the maintenance app. `addons/lunch` is a small standalone app: products, suppliers, toppings, locations, orders and a cash-move ledger.

## Commercial glue

`addons/loyalty` defines `loyalty.program`, its rules, rewards and issued `loyalty.card` records, and is consumed by both the point-of-sale and sales apps. `addons/partnership` adds partner grades and pricelist handling for reseller programmes, depending on `crm` and `sale`. `addons/mysubscription` is the odd one out, an `auto_install` module whose only content is a user-menu dashboard (`static/src/dashboard.js`, `database_section.js`, `iap_section.js`, `plan_section.js`) showing the state of an Odoo Online subscription.

## Portal and outbound channels

`addons/portal` gives external contacts a logged-in area without a backend licence: `portal.mixin` provides the signed access tokens on documents, and the controllers in `addons/portal/controllers/` render document pages, the chatter, and API-key management. `portal_discuss` and `portal_rating` extend it. `addons/im_livechat` builds a live-chat channel on top of discuss, including a scripted chatbot (`chatbot_script.py`, `chatbot_script_step.py`, `chatbot_script_answer.py`) and its own `ir_websocket.py` presence handling. `addons/snailmail` sends physical letters through IAP credits, with `snailmail_account` wiring it to invoices. `addons/theme_default` is data only, the default website theme.

## Web client extras

`addons/web_tour` (`auto_install`) is the tour framework: the registry of tour definitions, the step runner, and the tooltips. It is what this fork's onboarding tour and browser tests are written against. `addons/web_unsplash` (`auto_install`) adds an image picker to the HTML editor.

## Data hygiene and operations

`addons/onboarding` is a toolbox, not an app: `onboarding.onboarding` and `onboarding.onboarding.step` plus per-user progress records drive the step panels apps show on first use. `addons/digest` sends periodic KPI emails and lets any app contribute a KPI field; CRM adds its own. `addons/data_recycle` (`data.recycle.model`, `data.recycle.record`) flags stale or duplicate records for cleanup. `addons/populate` is a data factory used to generate large databases for performance work: generators under `generators/` (fake, relation, temporal, textual, reference), a blueprint/job/session model set, and a CLI at `addons/populate/cli/populate.py`. It is the only addon in the tree with its own `requirements.txt`, pinning `faker` per Python version (22.0.0 on 3.12, 33.3.1 on 3.13, 39.0.0 on 3.14).

## Test-support addons

Twenty modules under `addons/` begin with `test_`, and fifteen more under `odoo/addons/`. These are not test suites for a business app, they are fixture modules: hidden addons whose models, views and data exist only so framework behavior can be exercised. `odoo/addons/test_inherit`, `test_inherits_depends` and `test_uninstall` cover ORM inheritance and module removal; `odoo/addons/test_http`, `test_assetsbundle` and `test_lint` cover the HTTP layer, asset generation and code linting; `addons/test_spreadsheet` provides a dummy `spreadsheet.mixin` implementation; `addons/test_mail`, `test_mail_full`, `test_discuss_full`, `test_crm_full`, `test_website` and friends install a whole family at once so cross-module flows can be tested. `addons/test_crm_full` is the one that matters here: it depends on `crm` plus nine CRM satellite modules, so it is the broadest CRM integration fixture in the tree. None of these are installed by the dev scripts, which build `crm_offline` from `crm`, `mail` and demo data.

## Key source files

| File | Purpose |
| --- | --- |
| `addons/bus/websocket.py` | WebSocket protocol and per-connection state (1,020 lines) |
| `addons/bus/bus_dispatcher.py` | Listener/worker threads dispatching `NOTIFY imbus` to sockets |
| `addons/bus/models/bus.py` | `bus.bus` rows, payload splitting, GC retention |
| `addons/bus/models/bus_listener_mixin.py` | Lets any model publish on its own channel |
| `addons/bus/static/src/workers/` | SharedWorker owning the single browser connection |
| `addons/calendar/models/calendar_event.py` | Meetings, attendees, recurrence |
| `addons/calendar/models/mail_activity.py` | Activity to meeting link that CRM extends |
| `addons/resource/models/resource_calendar.py` | Working schedules |
| `addons/analytic/models/analytic_mixin.py` | Analytic distribution on any model |
| `addons/uom/models/` | Units of measure and categories |
| `addons/portal/models/portal_mixin.py` | Signed external access to a document |
| `addons/loyalty/models/loyalty_program.py` | Coupon and loyalty programme definition |
| `addons/onboarding/models/onboarding_onboarding_step.py` | Onboarding panel steps |
| `addons/digest/models/` | Periodic KPI digest emails |
| `addons/data_recycle/models/data_recycle_model.py` | Stale/duplicate record detection rules |
| `addons/populate/cli/populate.py` | `odoo-bin populate` data factory entry point |
| `addons/populate/requirements.txt` | Per-Python-version `faker` pins |
| `addons/web_hierarchy/static/src/hierarchy_arch_parser.js` | Hierarchy view type |
| `addons/im_livechat/models/chatbot_script.py` | Scripted live-chat bot |
| `addons/test_crm_full/__manifest__.py` | Broadest CRM integration fixture |

## Related pages

- [CRM](crm/index.md): depends on `calendar`, `resource`, `web_tour`, `contacts` and `digest`.
- [Localizations and integrations](localizations-and-integrations.md): the Google/Microsoft calendar connectors and IAP credits behind `snailmail`.
- [Accounting](accounting.md): consumer of `analytic` and `loyalty`.
- [Module system](../systems/module-system.md): what `auto_install` and `Hidden` categories mean.
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md): how these modules extend each other.
