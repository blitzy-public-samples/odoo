# Point of sale

Active contributors: Christophe, Frédéric, Martin (top authors of `addons/point_of_sale` on `origin/20.0`, bots and translation imports excluded)

## Purpose

`addons/point_of_sale` is the POS app. It is a separate OWL application, not a view inside the regular web client: it ships its own asset bundles, its own entry point, its own data-loading protocol, and its own local persistence. 45 further addons named `pos_*` extend it with payment terminals, restaurant mode, self-ordering kiosks, stock integration, loyalty, and accounting. The `payment` / `payment_*` family (24 addons) provides the acquirer engine POS reuses for online payments.

## POS offline is not this fork's offline stack

Upstream POS has its own offline mode and it is unrelated to the fork's offline CRM work in `addons/web` and `addons/crm`. The POS keeps its own IndexedDB database through `addons/point_of_sale/static/src/app/models/utils/indexed_db.js`, its own outbound queue (`network.unsyncData`, replayed by `PosDataPlugin.syncData()` in `addons/point_of_sale/static/src/app/plugins/pos_data_plugin.js`), and its own service worker (`addons/point_of_sale/static/src/app/service_worker.js`, cache name `odoo-pos-cache`). Because the web client's `OfflinePlugin` would otherwise install itself inside the POS and disable interactive buttons, `addons/point_of_sale/static/src/app/plugins/offline_plugin.js` patches `OfflinePlugin.setup()` to skip setup and disable crypto whenever `odoo.pos_config_id` is set. Treat the two stacks as independent; do not reuse one to reason about the other.

## Family contents

Real directories in `addons/`, grouped by what they add:

```text
point_of_sale/                 Core app: pos.config, pos.session, pos.order, frontend
pos_restaurant/                Floor plans, tables, courses; module_pos_restaurant
pos_self_order/                Self-ordering kiosk and QR menu (auto-installs with pos_restaurant)
pos_hr/                        Cashier login from hr.employee; module_pos_hr
pos_sale/                      Create a POS order from a sale.order (auto-install)
pos_sale_delivery/             Shipping on POS orders
pos_sale_loyalty/              Loyalty rewards on sale-based POS orders
pos_sale_margin/               Margin on POS orders
pos_sale_stock/                Stock moves for sale-based POS orders
pos_loyalty/                   Coupons and loyalty programs
pos_discount/                  Manual discount button
pos_online_payment/            Pay a POS order through a payment provider
pos_online_payment_self_order/ Online payment in the kiosk
pos_sms/                       SMS receipts and order notifications
pos_event/ pos_event_sale/     Sell event tickets at the POS
pos_stock/ pos_mrp/ pos_repair/ Stock, manufacturing, and repair integration
pos_account_tax_python/        Python-defined taxes on POS products
pos_edi_ubl/                   UBL e-invoicing export for POS orders
pos_partner_autocomplete/      Customer address autocomplete
pos_restaurant_loyalty/        Loyalty in restaurant mode
pos_hr_restaurant/             Employee switching in restaurant mode
pos_adyen/ pos_stripe/ pos_mercado_pago/ pos_razorpay/ pos_viva_com/   Terminal integrations
pos_cashdro/ pos_cashmatic/ pos_glory_cash/ pos_imin/ pos_pine_labs/
pos_qfpay/ pos_safaricom/ pos_dpopay/ pos_bancontact_pay/ pos_mollie/  Cash machines and local acquirers
pos_self_order_{bancontact_pay,pine_labs,qfpay,razorpay,event,sale,sms}/  Kiosk add-ons
```

The `payment` family: `payment` (engine) plus 23 provider addons (`payment_stripe`, `payment_adyen`, `payment_paypal`, `payment_mollie`, `payment_razorpay`, `payment_redsys`, `payment_worldline`, and so on). Each provider addon is a thin `_inherit` of `payment.provider`, `payment.transaction`, and `payment.token`.

## Key models

| Model | Defined in | Role |
| --- | --- | --- |
| `pos.config` | `addons/point_of_sale/models/pos_config.py` | One point of sale: payment methods, journals, presets, feature toggles such as `module_pos_restaurant` and `cash_control` |
| `pos.session` | `addons/point_of_sale/models/pos_session.py` | A cash session with opening/closing control, cash balance, and the orders it contains |
| `pos.order` | `addons/point_of_sale/models/pos_order.py` | A POS order: lines, payments, receipt number, `uuid`, and its posted `account.move` |
| `pos.order.line` | `addons/point_of_sale/models/pos_order_line.py` | One product line with quantity, price, discounts, and notes |
| `pos.payment` | `addons/point_of_sale/models/pos_payment.py` | A payment against an order, tagged with its `pos.payment.method` |
| `pos.payment.method` | `addons/point_of_sale/models/pos_payment_method.py` | A payment method: `type` cash/bank/pay_later plus an optional terminal, QR, or cash-machine integration |
| `pos.bill` | `addons/point_of_sale/models/pos_bill.py` | Coin and banknote denominations used by the cash-count screens |
| `pos.printer` | `addons/point_of_sale/models/pos_printer.py` | Receipt printers (ePOS/IoT) bound to a config |
| `pos.category` | `addons/point_of_sale/models/pos_category.py` | The POS product category tree |
| `pos.preset` | `addons/point_of_sale/models/pos_preset.py` | Order presets (price list, fiscal position, service fee) selectable per order |
| `pos.note` | `addons/point_of_sale/models/pos_note.py` | Canned note lines shown in the note picker |
| `pos.prep.order` / `pos.prep.line` | `addons/point_of_sale/models/pos_prep_order.py`, `.../pos_prep_line.py` | Preparation displays for kitchen/bar tickets |
| `pos.snooze` | `addons/point_of_sale/models/pos_snooze.py` | Time-boxed product availability (a product snoozed for a period) |
| `restaurant.floor` / `restaurant.table` | `addons/pos_restaurant/models/pos_restaurant.py` | Floor plans and their tables |
| `pos.course` | `addons/pos_restaurant/models/pos_course.py` | Course ordering for restaurant tickets |
| `payment.provider` | `addons/payment/models/payment_provider.py` | The acquirer engine: provider configuration and feature flags |
| `payment.transaction` | `addons/payment/models/payment_transaction.py` | One payment attempt, with its state machine and linked documents |
| `payment.token` | `addons/payment/models/payment_token.py` | A saved payment instrument for a partner |
| `payment.method` | `addons/payment/models/payment_method.py` | The payment-method taxonomy (card, bank, ...) shared with the ecommerce flow |

## How it works

A POS session drives everything. `pos.session` moves through `opening_control`, `opened`, `closing_control`, `closed`. `set_opening_control(cashbox_value, notes)` records the starting cash, `load_data()` serves the front end, and `close_session_from_ui()` posts the session's orders and payments into accounting (`account.bank.statement`, `account.move`). `pos.config.cash_control` is computed from whether the config has a `cash` payment method, and it turns on the opening/closing cash-count screens.

Data reaches the front end through one RPC. `pos.session.load_data(local_data)` iterates the model list in `_load_pos_data_models()` (`addons/point_of_sale/models/pos_session.py:164` — around 40 models, from `pos.config` to `account.account`) and, for each model, builds `{domain, fields, relations, records}`. Every model in that list mixes in `pos.load.mixin` (`addons/point_of_sale/models/pos_load_mixin.py`) and implements `_load_pos_data_domain`, `_load_pos_data_fields`, `_load_pos_data_dependencies`, and optionally `_load_pos_data_read`. The front end passes back the records it already cached, and `_read_pos_data_from_metadata()` returns only records whose `write_date` is newer, which is the delta-sync protocol. Writes go the other way: the front end posts order dictionaries keyed by `uuid`, and `pos.order._process_order()` creates or updates by `uuid`, remapping related record uuids (`addons/point_of_sale/models/pos_order.py:109`).

The front end is a standalone OWL app assembled from the `point_of_sale.assets_prod` bundle (`addons/point_of_sale/__manifest__.py`), which includes `point_of_sale.base_app` and `point_of_sale._assets_pos`. `PosDataPlugin` (`addons/point_of_sale/static/src/app/plugins/pos_data_plugin.js`) is the local store: it keeps the loaded records in a reactive registry, mirrors them into IndexedDB with a debounced write, and holds `network.unsyncData`, a FIFO of operations not yet accepted by the server. `syncData()` walks that queue oldest-first, stops on the first failure, and increments a `try` counter; a websocket reconnect or the browser `online` event restarts it. The POS service worker caches GET assets (it deliberately skips `/web/dataset` and non-GET requests, which live in IndexedDB instead).

Cash handling uses three models together: `pos.payment.method` with `type = 'cash'` defines the cashbox, `pos.bill` supplies the denominations the cash-count screen offers, and `pos.config.cash_control` enables the opening and closing counts. Receipts are rendered by `pos.order.receipt` (`addons/point_of_sale/receipt/pos_order_receipt.py`) and its QWeb templates in `addons/point_of_sale/receipt/`; printing goes through `pos.printer`. Restaurant mode is opt-in per config: `pos_restaurant` adds `restaurant.floor` and `restaurant.table`, links tables to orders, and adds `pos.course` for course ordering. `pos_self_order` reuses the same models to serve a kiosk or QR menu.

## Integration points

- Core dependencies: `resource`, `product`, `account`, `barcodes_gs1_nomenclature`, `html_editor`, `digest`, `phone_validation`, `google_address_autocomplete`, `base_report_wkhtmltox`, `iot_webserial`.
- Accounting: sessions post bank statements and moves; `pos_account_tax_python` allows Python tax code; see [Accounting](accounting.md).
- Payment: `pos.payment.method.payment_provider` links a method to a `payment.provider`, and `pos_online_payment` routes orders through `payment.transaction`. The provider addons are the same ones ecommerce uses.
- Sales: `pos_sale` loads `sale.order` records into the POS and links POS orders back to them; `pos_sale_stock`, `pos_sale_delivery`, `pos_sale_margin`, `pos_sale_loyalty` extend that path. See [Sales suite](sales-suite.md).
- Inventory and manufacturing: `pos_stock`, `pos_mrp`, `pos_repair`; see [Inventory and manufacturing](inventory-and-manufacturing.md).
- HR: `pos_hr` lists `hr` as a dependency and logs the cashier as an `hr.employee`; see [HR suite](hr-suite.md).
- Marketing: `pos_self_order` depends on `link_tracker` for its QR menu links; see [Marketing suite](marketing-suite.md).
- Mail and SMS: `pos_sms` sends receipts and notifications through the `sms` gateway; see [Mail](mail.md).

## Entry points for modification

Start from `addons/point_of_sale/models/pos_session.py` to change what the front end loads, `pos_order.py` to change the write-back, and `addons/point_of_sale/static/src/app/plugins/pos_data_plugin.js` to change local persistence. To add a model to the POS, mix in `pos.load.mixin`, implement the `_load_pos_data_*` hooks, and add the model name to `_load_pos_data_models()`. To add a payment terminal, follow the shape of `addons/pos_adyen` or `addons/pos_stripe`: depend on `point_of_sale`, extend `pos.payment.method`, and register the provider in `pos.payment.method.get_payment_providers()`. Feature toggles live on `pos.config` as `module_*` booleans, and the settings form reads them.

## Key source files

| File | Purpose |
| --- | --- |
| `addons/point_of_sale/__manifest__.py` | POS manifest: dependencies and the full asset-bundle graph |
| `addons/point_of_sale/models/pos_config.py` | `pos.config`, feature toggles and settings |
| `addons/point_of_sale/models/pos_session.py` | Session lifecycle and `load_data()` |
| `addons/point_of_sale/models/pos_load_mixin.py` | The `pos.load.mixin` data-loading protocol |
| `addons/point_of_sale/models/pos_order.py` | Order write-back and accounting posting |
| `addons/point_of_sale/models/pos_payment_method.py` | Payment methods and provider integrations |
| `addons/point_of_sale/models/pos_bill.py` | Cash denominations |
| `addons/point_of_sale/receipt/pos_order_receipt.py` | Receipt data assembly |
| `addons/point_of_sale/static/src/app/pos_app.js` | OWL application entry point |
| `addons/point_of_sale/static/src/app/plugins/pos_data_plugin.js` | Local store, IndexedDB mirror, `unsyncData` queue |
| `addons/point_of_sale/static/src/app/plugins/offline_plugin.js` | Neutralizes the web `OfflinePlugin` inside the POS |
| `addons/point_of_sale/static/src/app/models/utils/indexed_db.js` | POS IndexedDB wrapper |
| `addons/point_of_sale/static/src/app/service_worker.js` | POS asset-cache service worker |
| `addons/point_of_sale/static/src/app/models/data_service_options.js` | Which models live in IndexedDB and when they can be pruned |
| `addons/pos_restaurant/models/pos_restaurant.py` | `restaurant.floor` and `restaurant.table` |
| `addons/pos_restaurant/models/pos_course.py` | `pos.course` |
| `addons/pos_self_order/__manifest__.py` | Kiosk/QR self-ordering add-on |
| `addons/payment/models/payment_provider.py` | Payment engine: providers |
| `addons/payment/models/payment_transaction.py` | Payment engine: transactions |

## Related pages

- [Apps](index.md)
- [Accounting](accounting.md)
- [Sales suite](sales-suite.md)
- [Inventory and manufacturing](inventory-and-manufacturing.md)
- [HR suite](hr-suite.md)
- [Marketing suite](marketing-suite.md)
- [Mail](mail.md)
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md)
