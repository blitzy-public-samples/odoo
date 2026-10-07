# Marketing suite

Active contributors: Christophe, Thibault, Martin (top authors of `addons/mass_mailing` on `origin/20.0`, bots and translation imports excluded)

## Purpose

The marketing family covers outbound campaigns and the audience data behind them: email campaigns, SMS campaigns, printed postcards, the UTM campaign/source/medium taxonomy, short-link click tracking, events and their registrations, and gamified challenges. The family matters to this fork because `addons/crm` inherits the UTM tracking fields it defines, and because several bridge addons push campaign results back into the pipeline as `crm.lead` records.

Two families that upstream ships as enterprise apps are absent from this repository and must not be assumed: `marketing_automation` (multi-step marketing flows) and `social` (social media posting). The community `social_media` addon is not a posting app — it only adds social account fields to `res.company` (`addons/social_media/models/res_company.py`) so email templates and the website can link to them. `mass_mailing` lists `social_media` as a dependency for that reason.

## Family contents

Real directories in `addons/`:

```text
mass_mailing/                 Email Marketing: mailing.mailing, lists, contacts, traces
mass_mailing_sms/             SMS Marketing (adds mailing_type = 'sms')
mass_mailing_themes/          Email design themes
mass_mailing_crm/             Bridge: lead/opportunity counts per mailing
mass_mailing_crm_sms/         Bridge: SMS mailings on leads
mass_mailing_event/           Bridge: mass mailing on event attendees
mass_mailing_event_sms/       Bridge: SMS on event attendees
mass_mailing_event_track/     Bridge: mass mailing on track speakers
mass_mailing_event_track_sms/ Bridge: SMS on track speakers
mass_mailing_sale/            Bridge: mass mailing on sale orders
mass_mailing_sale_sms/        Bridge: SMS on sale orders
mass_mailing_slides/          Bridge: mass mailing on course members
sms/                          SMS gateway: sms.sms, sms.template, sms.tracker
sms_twilio/                   Twilio as the gateway API instead of IAP
utm/                          UTM taxonomy: campaign, source, medium, stage, tag, mixin
link_tracker/                 Short links and per-click tracking
event/                        Events: event.event, registrations, tickets, questions, mailings
event_booth/                  Booth sales and assignments for events
event_booth_sale/             Bridge: booths <-> sale orders
event_crm/                    Bridge: event registration <-> CRM lead
event_crm_sale/               Bridge: event, CRM, and sale orders
event_product/                Sell products at events
event_sale/                   Bridge: event tickets <-> sale orders
event_sms/                    SMS on events
gamification/                 Badges, challenges, goals, karma
social_media/                 Social account fields on res.company only
marketing_card/               Printed postcard campaigns (link_tracker + mass_mailing)
marketing_card_event/         Bridge: postcards for events
snailmail/                    Printed-letter delivery through IAP
digest/                       Periodic KPI emails (not a campaign tool, but the same sending layer)
```

## Key models

| Model | Defined in | Role |
| --- | --- | --- |
| `mailing.mailing` | `addons/mass_mailing/models/mailing.py` | One campaign: subject, body, recipient model, lists, schedule, and statistics |
| `mailing.list` | `addons/mass_mailing/models/mailing_list.py` | A named audience list |
| `mailing.contact` | `addons/mass_mailing/models/mailing_contact.py` | One recipient with blacklist tracking and custom properties |
| `mailing.subscription` | `addons/mass_mailing/models/mailing_subscription.py` | The contact-to-list link, with opt-out state |
| `mailing.subscription.optout` | `addons/mass_mailing/models/mailing_subscription_optout.py` | Per-list opt-out reasons |
| `mailing.filter` | `addons/mass_mailing/models/mailing_filter.py` | A saved domain that selects recipients from any model |
| `mailing.trace` | `addons/mass_mailing/models/mailing_trace.py` | Per-recipient sent/opened/clicked/replied/bounced events that roll up into mailing stats |
| `sms.sms` | `addons/sms/models/sms_sms.py` | One outbound SMS and its delivery state |
| `sms.template` | `addons/sms/models/sms_template.py` | A rendered SMS body reusable from any model |
| `sms.tracker` | `addons/sms/models/sms_tracker.py` | Delivery/click tracking for SMS, the counterpart of `mailing.trace` |
| `utm.campaign` / `utm.source` / `utm.medium` | `addons/utm/models/` | The attribution taxonomy shared by CRM, sales, events, and mailings |
| `utm.mixin` | `addons/utm/models/utm_mixin.py` | Abstract mixin giving any model `campaign_id`, `source_id`, `medium_id`, and `utm_reference` |
| `utm.stage` / `utm.tag` | `addons/utm/models/` | Optional campaign stages and tags |
| `link.tracker` | `addons/link_tracker/models/link_tracker.py` | A tracked short link, itself a `utm.mixin` record |
| `link.tracker.code` | `addons/link_tracker/models/link_tracker.py` | The short code that resolves to a `link.tracker` |
| `link.tracker.click` | `addons/link_tracker/models/link_tracker.py` | One recorded click with its request metadata |
| `event.event` | `addons/event/models/event_event.py` | An event with tickets, questions, and dates |
| `event.registration` | `addons/event/models/event_registration.py` | One attendee, linked to a partner and an optional lead |
| `event.stage` | `addons/event/models/event_stage.py` | Kanban stages for events |
| `event.event.ticket` | `addons/event/models/event_ticket.py` | Ticket types with prices and quotas |
| `event.mail` / `event.mail.registration` | `addons/event/models/event_mail.py`, `.../event_mail_registration.py` | Scheduled communications and their per-registration state |
| `event.question` / `event.registration.answer` | `addons/event/models/event_question.py`, `.../event_registration_answer.py` | Registration form questions and answers |
| `gamification.badge` / `gamification.challenge` / `gamification.goal` | `addons/gamification/models/` | Badges, challenges, and the goals a challenge tracks |
| `gamification.goal.definition` | `addons/gamification/models/gamification_goal_definition.py` | The field, computation mode, and target a goal measures |
| `gamification.karma.rank` / `gamification.karma.tracking` | `addons/gamification/models/` | Karma ranks and the karma ledger |
| `card.campaign` / `card.card` / `card.template` | `addons/marketing_card/models/` | Printed postcard campaigns and their cards |

## How it works

Email campaigns. `mailing.mailing` is a `mail.thread` + `mail.activity.mixin` + `mail.render.mixin` record (`addons/mass_mailing/models/mailing.py:38`). It carries its own `campaign_id`, `medium_id`, and `source_id` fields rather than inheriting `utm.mixin`, and defaults them to the standard `utm.utm_medium_email` and `utm.utm_source_mailing` records. The recipient set is either a list of `mailing.list` records or any model chosen through `mailing_model_id`, filtered by `mailing.filter` domains; `mailing.mailing._get_recipients()` resolves the final set. Sending renders the body per recipient through `mail.render.mixin`, mints a tracked link when the body contains one, and posts `mail.mail` rows. A `mailing.trace` row is written per recipient and updated as the recipient opens, clicks, replies, or bounces, which is what the campaign statistics and A/B tests read.

SMS campaigns. `mass_mailing_sms` extends the `mailing_type` selection on `mailing.mailing` with `'sms'` and adds the SMS-specific fields and scheduling (`addons/mass_mailing_sms/models/mailing_mailing.py:26`). The gateway itself is `addons/sms`: `sms.sms` is an outbound message with a state machine, `sms.template` renders a body from a record, and `sms.tracker` records delivery. `sms.sms.send()` splits messages by API (`_split_by_api`) and sends through IAP by default (`addons/sms/__manifest__.py` depends on `iap_mail`); `sms_twilio` swaps in the Twilio API for companies that configure it.

UTM. `utm.mixin` (`addons/utm/models/utm_mixin.py`) gives any model `campaign_id`, `source_id`, `medium_id`, and a generic `utm_reference`. Its `default_get()` reads tracking values from cookies that `ir.http` dispatch populates from URL parameters, creating the `utm.campaign`/`utm.source`/`utm.medium` record on demand. CRM leads inherit this mixin, which is how a mailing or a link click becomes attributed pipeline; see [CRM](crm/index.md).

Link tracking. `link.tracker` inherits `utm.mixin` and stores a short URL; `link.tracker.code` holds the code, and `link.tracker.click` records each visit. Mailings and events mint trackers automatically when their content contains links, so clicks feed back into the same UTM fields.

Events. `event.event` holds the schedule, tickets (`event.event.ticket`), registration form questions (`event.question`), and scheduled communications (`event.mail`, whose `interval_type` covers before/after event and after registration). `event.registration` is one attendee; bridges connect it to sales (`event_sale` sells tickets through `sale.order`), CRM (`event_crm` creates a lead from a registration), booths (`event_booth`), and SMS (`event_sms`). An `ir.cron` (`addons/event/data/ir_cron_data.xml`) drives the scheduled communications.

Gamification. `gamification.challenge` groups `gamification.challenge.line` goals; each goal follows a `gamification.goal.definition` that names a model, a field, a computation mode, and a target. Two crons (`addons/gamification/data/ir_cron_data.xml`: `ir_cron_check_challenge` calling `_cron_update()` and `ir_cron_consolidate`) evaluate goals and consolidate karma. Badges are awarded manually or from goals. HR wires this to employees through the auto-installed `hr_gamification`.

## Integration points

- CRM: `crm.lead` inherits `utm.mixin`, so every campaign, source, and medium defined here is available as a lead attribution field. `mass_mailing_crm` adds per-mailing lead counts, and `event_crm` converts registrations into leads. See [CRM](crm/index.md).
- Mail: `mailing.mailing` and `sms.template` both build on `mail.render.mixin`; campaign sending goes through `mail.mail`. See [Mail](mail.md).
- Sales: `mass_mailing_sale`, `event_sale`, `event_product`, `event_crm_sale`, and `event_booth_sale` bridge campaigns and events into orders. See [Sales suite](sales-suite.md).
- Website and e-learning: `mass_mailing_slides` targets course members, `website` depends on `social_media`. See [Website suite](website-suite.md).
- Automation: campaign sending, event communications, and gamification goals are all driven by scheduled actions; see [Cron and scheduled actions](../primitives/cron-and-scheduled-actions.md).
- CRM/fork note: nothing in this family is modified by the fork. `addons/crm` consumes the UTM fields and the mailing bridges, and `addons/crm/controllers/webmanifest.py` is the only CRM-side touch point that shares infrastructure with the mail layer.

## Entry points for modification

Start from `addons/mass_mailing/models/mailing.py` for campaign behavior, `addons/mass_mailing/models/mailing_trace.py` for statistics, and `addons/mass_mailing_sms/models/mailing_mailing.py` for the SMS variant of the same flow. To target a new recipient model, add a bridge module that depends on `mass_mailing` and the target addon and extends the mailing's recipient domain, following `addons/mass_mailing_sale` as the template. To change attribution, edit `addons/utm/models/utm_mixin.py`, but remember that CRM's behavior is owned by `addons/crm` and must be extended from there, not here. New models in a family addon must be imported in its `models/__init__.py`, and new XML data files must be added to the manifest `data` list in dependency order.

## Key source files

| File | Purpose |
| --- | --- |
| `addons/mass_mailing/__manifest__.py` | Email Marketing manifest and data order |
| `addons/mass_mailing/models/mailing.py` | `mailing.mailing`, the campaign model (1,566 lines) |
| `addons/mass_mailing/models/mailing_list.py` | `mailing.list` |
| `addons/mass_mailing/models/mailing_contact.py` | `mailing.contact` |
| `addons/mass_mailing/models/mailing_subscription.py` | Contact-to-list subscriptions and opt-outs |
| `addons/mass_mailing/models/mailing_filter.py` | Saved recipient domains |
| `addons/mass_mailing/models/mailing_trace.py` | Per-recipient statistics |
| `addons/mass_mailing_sms/models/mailing_mailing.py` | Adds `mailing_type = 'sms'` to campaigns |
| `addons/sms/models/sms_sms.py` | `sms.sms` gateway record and send path |
| `addons/sms/models/sms_template.py` | `sms.template` rendering |
| `addons/sms_twilio/models/sms_sms.py` | Twilio API backend for the gateway |
| `addons/utm/models/utm_mixin.py` | The `utm.mixin` attribution fields and cookie handling |
| `addons/utm/models/utm_campaign.py` | `utm.campaign` |
| `addons/link_tracker/models/link_tracker.py` | `link.tracker`, `link.tracker.code`, `link.tracker.click` |
| `addons/event/models/event_event.py` | `event.event` |
| `addons/event/models/event_registration.py` | `event.registration` |
| `addons/event/models/event_mail.py` | Scheduled event communications |
| `addons/event/data/ir_cron_data.xml` | Cron driving event communications |
| `addons/gamification/models/gamification_challenge.py` | `gamification.challenge` |
| `addons/gamification/models/gamification_goal.py` | `gamification.goal` |
| `addons/gamification/data/ir_cron_data.xml` | Crons evaluating goals and karma |
| `addons/marketing_card/models/card_campaign.py` | Printed postcard campaigns |
| `addons/social_media/models/res_company.py` | Social account fields on `res.company` |

## Related pages

- [Apps](index.md)
- [CRM](crm/index.md)
- [Mail](mail.md)
- [Sales suite](sales-suite.md)
- [Website suite](website-suite.md)
- [HR suite](hr-suite.md)
- [Cron and scheduled actions](../primitives/cron-and-scheduled-actions.md)
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md)
