# Other business apps

Active contributors: Christophe, Fabien, Martin

## Purpose

This page is a roundup of the addons that do not belong to one of the large app families but that other modules depend on constantly. Several are `auto_install` infrastructure rather than apps a user installs, and one of them, `addons/bus`, carries every real-time update in the product. It is also the census page: once every family page has claimed its prefixes, 73 directories remain (`addons/board` counts with the [spreadsheet family](spreadsheet-and-dashboards.md)), and each of them is named below, in a section when it carries logic and in the smaller-modules table when it is a wrapper. None of them are modified by this fork; they are listed so a reader can find the owner of an unfamiliar model.

## Real-time bus

`addons/bus` is the transport for every push the server makes to a browser: chat messages, activity counters, asset-reload watchdogs, and the notifications the discuss client renders. Despite its historical name ("IM Bus"), 20.0 carries an in-process WebSocket implementation, not long polling. `addons/bus/websocket.py` (1,020 lines) plus `addons/bus/websocket_protocol.py` implement the protocol and per-connection state; `addons/bus/bus_dispatcher.py` runs a `BusDispatcher` thread whose listener loop blocks on a Postgres `LISTEN imbus` and whose worker loops fetch matching rows and forward them to subscribed sockets, tracking each channel as a `ChannelTopic` with a `DispatchState`.

The write side is `addons/bus/models/bus.py`: `bus.bus` rows are inserted and announced with a `NOTIFY` (the function is overridable through the `ODOO_NOTIFY_FUNCTION` environment variable, default `pg_notify`), payloads are split recursively to stay under `NOTIFY_PAYLOAD_MAX_LENGTH` (8000 bytes by default, tunable with `ODOO_NOTIFY_PAYLOAD_MAX_LENGTH`), and rows are garbage-collected after `DEFAULT_GC_RETENTION_SECONDS`, 24 hours. Any model can publish to its own channel by inheriting `addons/bus/models/bus_listener_mixin.py`. On the browser side the connection is owned by a `SharedWorker` so all tabs share one socket, `addons/bus/static/src/workers/bus_worker_script.js` is deliberately removed from the normal bundles and served through the dedicated `bus.websocket_worker_assets` bundle; `multi_tab_plugin.js`, `multi_tab_shared_worker_plugin.js` and `multi_tab_fallback_plugin.js` elect the tab that owns it and degrade when `SharedWorker` is unavailable.

## Foundational data models

`addons/uom` defines units of measure and their categories, and is a dependency of anything that counts things. `addons/resource` holds working schedules: `resource.calendar`, its attendance lines and leaves, `resource.resource`, and `resource.mixin` for models that need a working calendar; CRM depends on it. `addons/analytic` adds analytic plans, accounts and lines plus `analytic.mixin` and `analytic.distribution.model`, the cost-tracking dimension used by accounting, projects and timesheets. `addons/rating` adds the `rating.rating` records behind customer satisfaction stars, and `addons/link_tracker` turns URLs into trackable short links tied to UTM campaigns.

`addons/product` defines the catalog itself: `product.template` (the product sheet), `product.product` (each sellable variant), categories and tags, the attribute and value machinery that generates variants, combos, supplierinfo, pricelists (`product.pricelist` and its items) and even `res.currency`. Four satellites ride on it: `product_email_template` (an email template per product, sent when the product is invoiced), `product_expiry` (alert, use and removal dates that lots, moves, pickings and quants enforce), `product_margin` (realised margin per product, computed from accounting) and `product_matrix` (the grid configurator for products with two or more variant attributes).

`addons/utm` holds attribution: `utm.mixin` adds campaign, source and medium fields to any record, `addons/utm/models/ir_http.py` stores `utm_*` URL parameters in cookies, and `utm.campaign`, `utm.source`, `utm.medium`, `utm.tag` and `utm.stage` are the records behind them. How a tracked link turns into a qualified `crm.lead` is on [marketing](marketing-suite.md).

## People, places and things

`addons/contacts` is the UI app around `res.partner`, and it is the reason `addons/web_hierarchy` exists, its org-chart view type (`hierarchy_arch_parser.js`, `hierarchy_card.js`) renders the company tree. `addons/calendar` owns `calendar.event`, recurrences, attendees and alarms, and links meetings to activities through `models/mail_activity.py` and `mail_activity_mixin.py`; `google_calendar` and `microsoft_calendar` synchronise it both ways (see [localizations and integrations](localizations-and-integrations.md)). CRM depends on `calendar` for the "schedule a meeting" activity path, see [CRM](crm/index.md). `addons/fleet` tracks vehicles, models and brands, odometer readings, service logs and contracts, with `fleet_maintenance` as the glue to the maintenance app. `addons/lunch` is a small standalone app: products, suppliers, toppings, locations, orders and a cash-move ledger.

## Surveys

`addons/survey` builds questionnaires: `survey.survey` with a choice of layouts (one page, one page per section, one page per question), `survey.question` for both the sections and the questions (free text, numerical, date, simple and multiple choice, scale, matrix), `survey.user_input` per respondent with scoring and a pass threshold, and certification that awards a `gamification.badge` (`addons/survey/models/badge.py` and `challenge.py` extend the badge with a certification category). `addons/survey/models/ir_http.py` opens public access to a started survey. `addons/survey_crm` qualifies a `crm.lead` from a completed survey.

## Commercial glue

`addons/loyalty` defines `loyalty.program`, its rules, rewards and issued `loyalty.card` records, and is consumed by both the point-of-sale and sales apps. `addons/partnership` adds partner grades and pricelist handling for reseller programmes, depending on `crm` and `sale`. `addons/mysubscription` is the odd one out, an `auto_install` module whose only content is a user-menu dashboard (`static/src/dashboard.js`, `database_section.js`, `iap_section.js`, `plan_section.js`) showing the state of an Odoo Online subscription.

## Portal and outbound channels

`addons/portal` gives external contacts a logged-in area without a backend licence: `portal.mixin` provides the signed access tokens on documents, and the controllers in `addons/portal/controllers/` render document pages, the chatter, and API-key management. `portal_discuss` and `portal_rating` extend it. `addons/im_livechat` builds a live-chat channel on top of discuss, including a scripted chatbot (`chatbot_script.py`, `chatbot_script_step.py`, `chatbot_script_answer.py`) and its own `ir_websocket.py` presence handling. `addons/snailmail` sends physical letters through IAP credits, with `snailmail_account` wiring it to invoices. `addons/theme_default` is data only, the default website theme.

## Web client extras

`addons/web_tour` (`auto_install`) is the tour framework: the registry of tour definitions, the step runner, and the tooltips. It is what this fork's onboarding tour and browser tests are written against. `addons/web_unsplash` (`auto_install`) adds an image picker to the HTML editor.

## Data hygiene and operations

`addons/onboarding` is a toolbox, not an app: `onboarding.onboarding` and `onboarding.onboarding.step` plus per-user progress records drive the step panels apps show on first use. `addons/digest` sends periodic KPI emails and lets any app contribute a KPI field; CRM adds its own. `addons/data_recycle` (`data.recycle.model`, `data.recycle.record`) flags stale or duplicate records for cleanup. `addons/populate` is a data factory used to generate large databases for performance work: generators under `generators/` (fake, relation, temporal, textual, reference), a blueprint/job/session model set, and a CLI at `addons/populate/cli/populate.py`. It is the only addon in the tree with its own `requirements.txt`, pinning `faker` per Python version (22.0.0 on 3.12, 33.3.1 on 3.13, 39.0.0 on 3.14).

## Smaller modules at a glance

The rest of the census. Modules another family page already describes get a link, not a repeat.

| Module | What it does |
| --- | --- |
| `addons/api_doc` | Dynamic API documentation at `/doc`: `addons/api_doc/controllers/api_doc.py` serves model, field and method metadata from the live registry, plus JSON endpoints and a bearer-authenticated playground; `auto_install`. |
| `addons/attachment_indexation` | Extracts text from docx, pptx, xlsx, ods and pdf attachments into `ir.attachment` for content search (`addons/attachment_indexation/models/ir_attachment.py`); PDF needs the optional `pdfminer.six`. |
| `addons/printer` | External receipt and label printers: `printer.printer` of type `zpl` or `epos` (`addons/printer/models/printer.py`), reports rasterised for the ePOS SOAP call (`addons/printer/models/ir_actions_report.py`), and per-user printer selection. |
| `addons/privacy_lookup` | GDPR-style lookup of a person's data: `privacy.lookup.wizard` (`addons/privacy_lookup/wizard/privacy_lookup_wizard.py`) scans models for name and email matches, lists the hits as `privacy.lookup.wizard.line`, logs the run in `privacy.log`; `auto_install`. |
| `addons/phone_validation` | Normalises and validates `phone` fields (`phone_sanitized` through `mail.thread.phone`, `phone.blacklist`); a dependency of `crm` and the SMS chain. |
| `addons/sms`, `addons/sms_twilio` | Outgoing SMS through IAP (`sms.sms`, the composer, provider state mapping) and Twilio as the one direct provider; the sending flow is on [marketing](marketing-suite.md). |
| `addons/social_media` | The `social_*` account fields on `res.company` (X, Facebook, GitHub, LinkedIn, YouTube, Instagram, TikTok, Discord) that the website footer and share buttons read. |
| `addons/http_routing` | Frontend URL machinery: slug routing, redirects and language prefixes through `ir.http`, `ir.qweb` and `res.lang`. |
| `addons/gamification`, `addons/gamification_sale_crm` | Challenges, goals and badges; described in [marketing](marketing-suite.md). |
| `addons/barcodes`, `addons/barcodes_gs1_nomenclature` | Barcode nomenclatures and the client-side scan plugin (there is no singular `barcode` module); described in [inventory and manufacturing](inventory-and-manufacturing.md). |
| `addons/maintenance` | Equipment requests and preventive schedules; described in [project and services](project-and-services.md). |
| `addons/rpc` | The external XML-RPC/JSON-RPC endpoints; described in [HTTP server](../systems/http-server.md). |
| `addons/marketing_card`, `addons/marketing_card_event` | Printed postcard campaigns over snailmail; described in [marketing](marketing-suite.md). |
| `addons/certificate`, `addons/partner_autocomplete` | X.509 certificate storage for EDI signing and company-data lookup over IAP; described in [localizations and integrations](localizations-and-integrations.md). |
| `addons/html_editor`, `addons/html_builder` | The website editing stack; described in [website suite](website-suite.md). |
| Thin bridges | `calendar_sms` (SMS for calendar events), `resource_mail` (activities on `resource.resource`), `snailmail_account` (send invoices by post), `fleet_maintenance` (fleet vehicles in maintenance). |

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
| `addons/product/models/product_template.py` | Product sheet and variant generation |
| `addons/survey/models/survey_survey.py` | Questionnaires, layouts, scoring, certification |
| `addons/utm/models/utm_mixin.py` | Campaign/source/medium attribution mixin |
| `addons/api_doc/controllers/api_doc.py` | `/doc` dynamic API documentation and playground |
| `addons/attachment_indexation/models/ir_attachment.py` | Attachment text extraction for search |
| `addons/printer/models/printer.py` | `printer.printer`, ZPL and ePOS |
| `addons/privacy_lookup/wizard/privacy_lookup_wizard.py` | Person-data lookup across models |
| `addons/test_crm_full/__manifest__.py` | Broadest CRM integration fixture |

## Related pages

- [CRM](crm/index.md): depends on `calendar`, `resource`, `web_tour`, `contacts` and `digest`.
- [Localizations and integrations](localizations-and-integrations.md): the Google/Microsoft calendar connectors, the IAP credits behind `snailmail`, `certificate` and `partner_autocomplete`.
- [Accounting](accounting.md): consumer of `analytic` and `loyalty`.
- [Marketing](marketing-suite.md): `utm`, `sms`, `gamification` and the postcard modules in the table above.
- [Inventory and manufacturing](inventory-and-manufacturing.md): `barcodes`.
- [Project and services](project-and-services.md): `maintenance`.
- [Module system](../systems/module-system.md): what `auto_install` and `Hidden` categories mean.
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md): how these modules extend each other.
