# CRM offline surface inventory

This document lists every live-server entry point in `addons/crm/` and assigns each one exactly one
offline class: QUEUE, SKIP or DISABLE. The entry points are JS ORM, `rpc`, action-service and
group- or access-probe calls; view, wizard and report buttons with a server effect; and public
`crm.lead`, `crm.stage` and `crm.team` methods reachable from a button, including inherited methods
and bound actions reached through the Actions menu. Paths and line numbers refer to base commit
`ee8c13eaa57`; the offline and mobile work that follows this inventory may shift them. The document
changes no code and is never bundled, because asset bundles keep only asset extensions
(`odoo/tools/constants.py:3-8`).

## Method

Four sweeps produced the rows.

1. **JS.** A grep over `static/src/**/*.js`, onboarding tours (`static/src/js/tours/**`) excluded,
   for `orm.`, `rpc(`, `.call(`, `searchRead`/`webSearchRead`, `doAction`/`loadAction`,
   `user.hasGroup`, `checkAccessRight`, `isAdmin`, `.save(` and `.load(`; then a second grep for
   `useService(`, `usePlugin(`, `_webReadGroup` and `doActionButton`. Following those hits added
   the call sites of the `checkRainbowmanMessage` helper, the CRM overrides of the framework save
   and stage move (`_save`, `moveRecords`), and the team switcher's selection handler.
2. **XML.** A grep over `views/*.xml`, `wizard/*.xml` and `report/*.xml` for `type="object"`,
   `type="action"`, `type="open"`, `type="delete"`, `name="pls_tooltip_button"` (the PLS button is a
   `<widget>`), `data-hotkey` and `<chatter`; then every `<button` in the wizards.
3. **Python.** `def [a-z]` over `models/crm_lead.py`, `models/crm_team.py` and
   `models/crm_stage.py`, cross-checked against the button names (see "Python methods and the rows
   that reach them").
4. **Actions menu.** The static menu items of the web form, list and kanban controllers
   (`addons/web/static/src/views/form/form_controller.js:601-652`,
   `addons/web/static/src/views/list/list_controller.js:452-496`,
   `addons/web/static/src/views/kanban/kanban_controller.js:383-425`), for each model with a CRM
   view: `crm.lead`, `crm.team` and `crm.stage`. Archive and Unarchive apply only to models with an
   `active` field: `crm.lead` (`models/crm_lead.py:125`) and `crm.team`
   (`addons/sales_team/models/crm_team.py:89`), not `crm.stage`. Bound actions come from a
   `binding_model_id` grep over `addons/crm/**/*.xml`, which finds five, all on `crm.lead`:
   `views/crm_lead_views.xml:682, 694, 1273`, `wizard/crm_merge_opportunities_views.xml:46` and
   `wizard/crm_lead_lost_views.xml:28`. No Python `binding_model` exists.

**Completeness.** Every grep hit and every menu item is either a row below or listed under
"Swept, not requiring a live connection". The per-class and per-source counts sum to the row total.

## Row schema

Each row carries an id for cross-reference (A1, B1, ...), then five columns:

`path | line | call made | class | justification`

- **path** is relative to `addons/crm/`. Table D rows D1–D12 are framework menu items; their paths
  are relative to `addons/web/static/src/views/`, as stated above that table.
- **line** is the first line of the statement (JS) or of the opening tag (XML) that makes the call.
  A grep hit on a continuation line of that statement or tag belongs to the same row.
- **justification** is one line.

## Classification rules

The rules apply in this order, and every entry point gets exactly one class.

- **DISABLE pre-test.** Before QUEUE is considered, an entry point is DISABLE when its call needs any
  of the following:
  - a server `onchange`;
  - a transient-model wizard;
  - an id produced by another call;
  - a server-side decision of the written value;
  - a method the shared offline systray cannot render. The systray renders only `web_save`,
    `unlink`/`web_unlink`, `action_archive` and `action_unarchive`
    (`addons/web/static/src/webclient/offline_systray/offline_systray.js:48-71`).
- **QUEUE.** A write on `crm.lead`, `crm.stage` or `crm.team`, or on a `mail.activity` of a lead,
  whose full argument list is resolvable on the client with no server round-trip. It goes into the
  shared offline queue and is replayed on reconnect.
- **SKIP.** A read whose only effect is decorative or advisory: a tooltip, a visual effect, a
  promotional hint, or a group probe that only toggles display. Offline it is not issued.
- **DISABLE.** Everything else: transient-model wizards, module installation, paid external
  lookups, server-computed reports, access probes gating destructive UI, and navigation to an action
  unavailable offline. Offline the control is disabled and its handler is inert.

## Conflict resolutions applied

- **K4, form "Won" button.** The rule order alone would accept `action_set_won_rainbowman` with
  arguments `[[id]]`. It is DISABLE: object buttons have no offline path
  (`addons/web/static/src/webclient/actions/action_plugin.js:1595-1640`), the won stage is chosen
  server-side by `_stage_find` (`models/crm_lead.py:1057-1081`), and the systray cannot render
  `action_set_won`. Mark-won offline is the client-resolvable equivalent: a `web_save` of `stage_id`
  set to the won stage, made through the kanban move (A5) or the mobile card (N2). The server turns
  it into won with probability 100.
- **K5, PLS tooltip button.** The rule order would read the lookup as a tooltip, so SKIP. It is
  DISABLE: predictive lead scoring is out of scope offline, and the click saves the record before
  the lookup, which cannot be split from it.
- **K6, team switcher.** `get_team_switcher_data` is a non-decorative read, so DISABLE. DISABLE
  applies to the switcher selection it feeds. The load-time read keeps being answered by the
  framework's disk cache, so `static/src/views/crm_search_model.js` is not modified and the
  selected-team facet does not regress.

## A. JS calls (23 rows)

| # | path | line | call made | class | justification |
|---|------|------|-----------|-------|---------------|
| A1 | `static/src/views/check_rainbowman_message.js` | 2 | `orm.call("crm.lead", "get_rainbowman_message", [[recordId]])` | SKIP | Visual effect; replayed later it would fire detached from the save. |
| A2 | `static/src/views/crm_form/crm_form.js` | 51 | `checkRainbowmanMessage()` after a form save that changed the stage | SKIP | Same visual-effect lookup; the save itself is A4. |
| A3 | `static/src/views/crm_kanban/crm_kanban_model.js` | 29 | `checkRainbowmanMessage()` after a kanban stage move | SKIP | Same visual-effect lookup; the move itself is A5. |
| A4 | `static/src/views/crm_form/crm_form.js` | 49 | `super._save()` → `crm.lead` `web_save`, including the partner-sync `email_from`/`phone` copy | QUEUE | Every value is user-entered or already loaded on the record; the framework's offline save queues it. |
| A5 | `static/src/views/crm_kanban/crm_kanban_model.js` | 25 | `super.moveRecords()` → `web_save` with args `[[id], {stage_id}]`, won stage included | QUEUE | The stage id comes from the target group; the server derives won and probability from the stage (K4). |
| A6 | `static/src/views/crm_kanban/crm_column_progress.js` | 14 | `user.hasGroup("crm.group_use_recurring_revenues")` | SKIP | Group probe that only toggles the recurring-revenue aggregate. |
| A7 | `static/src/components/team_switcher/team_switcher.js` | 21 | `user.hasGroup("sales_team.group_sale_manager")` | SKIP | Group probe that only toggles the Manage Teams item. |
| A8 | `static/src/components/team_switcher/team_switcher.js` | 46 | `actionService.doAction("sales_team.crm_team_action_config")` | DISABLE | Navigation to the team configuration action, unavailable offline. |
| A9 | `static/src/components/team_switcher/team_switcher.js` | 60 | `searchModel._updateSwitcherSelection(teamId)`, from the toggle at `team_switcher.xml:6-9` | DISABLE | Selection is locked offline because the reload may need a team domain that was never cached; the disk-cached load-time data (A10) and the current-team facet stay (K6). |
| A10 | `static/src/views/crm_search_model.js` | 130 | `orm.cache({type: "disk", update: "always"}).call("crm.team", "get_team_switcher_data")` | DISABLE | Non-decorative read feeding the disabled selection (K6); the disk cache still answers it at load. |
| A11 | `static/src/activity_menu_patch.js` | 39 | `action.loadAction("crm.crm_lead_action_my_activities")` | DISABLE | Loads an action only to navigate to it; unavailable offline. |
| A12 | `static/src/activity_menu_patch.js` | 45 | `action.doAction(action, {clearBreadcrumbs: true})` | DISABLE | Navigation to the CRM activity views, unavailable offline. |
| A13 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 137 | `orm.cache().searchRead("ir.module.module", [["name", "in", moduleNames]])` | DISABLE | Probe that only serves module installation. |
| A14 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 165 | `user.checkAccessRight(model, "create")` | DISABLE | Access probe gating the install and import actions. |
| A15 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 206 | `orm.silent.call("ir.module.module", "button_immediate_install", [id])` | DISABLE | Module installation. |
| A16 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 241 | `action.doAction({type: "ir.actions.client", tag: "import"})` | DISABLE | Navigation to the server-side import. |
| A17 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 257 | `action.doAction({res_model: "base.module.install.request", target: "new"})` | DISABLE | Transient-model wizard (install or access request). |
| A18 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 45 | `props.record.save()` before the PLS lookup | DISABLE | K5: cannot be split from the lookup; the widget renders at `views/crm_lead_views.xml:99, 131`. |
| A19 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 51 | `orm.call("crm.lead", "prepare_pls_tooltip_data", [resId])` | DISABLE | K5: the server recomputes the probability; PLS is out of scope offline. |
| A20 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 57 | `props.record.load()` after the lookup | DISABLE | K5: reload of the server recomputation. |
| A21 | `static/src/webclient/share_target/crm_share_target_item.js` | 18 | `orm.webSearchRead("crm.team", teamsDomain, {specification})` | DISABLE | Feeds share-target lead creation, which uploads the shared content to the server. |
| A22 | `static/src/views/forecast_kanban/forecast_kanban_model.js` | 12 | `_webReadGroup` with the `fill_temporal` context | DISABLE | Forecast view, out of scope offline; the server fills the temporal groups. |
| A23 | `static/src/views/forecast_kanban/forecast_kanban_renderer.js` | 48 | `props.list.load()` after adding a forecast column | DISABLE | Forecast view, out of scope offline. |

## B. XML buttons (40 rows)

| # | path | line | call made | class | justification |
|---|------|------|-----------|-------|---------------|
| B1 | `views/crm_lead_views.xml` | 9 | Form header "Won" `action_set_won_rainbowman` (hotkey `w`) → `action_set_won` (`models/crm_lead.py:1057`) | DISABLE | K4: object button with no offline path; the server picks the won stage. Mark-won offline is A5 or N2. |
| B2 | `views/crm_lead_views.xml` | 12 | Form header "Convert to Opportunity" `action_convert_to_opportunity` (hotkey `v`) | DISABLE | The server creates or links the partner. |
| B3 | `views/crm_lead_views.xml` | 14 | Form header "Restore" `action_restore` (hotkey `x`) | DISABLE | Server probability recompute, through a method the systray cannot render; the queueable equivalent is Unarchive (C1). |
| B4 | `views/crm_lead_views.xml` | 16 | Form header "Lost" `%(crm.crm_lead_lost_action)d` (hotkey `l`) → `crm.lead.lost` → `action_set_lost` | DISABLE | Transient-model wizard. |
| B5 | `views/crm_lead_views.xml` | 33 | Smart button `action_schedule_meeting` | DISABLE | Opens the calendar, out of scope offline. |
| B6 | `views/crm_lead_views.xml` | 42 | Smart button `action_show_potential_duplicates` | DISABLE | Navigation to a server-computed duplicate search. |
| B7 | `views/crm_lead_views.xml` | 89 | `<a type="object" name="action_set_automated_probability">` | DISABLE | Server PLS recomputation, out of scope offline. |
| B8 | `views/crm_lead_views.xml` | 138 | `<a type="object" name="action_set_automated_probability">` (second location) | DISABLE | Server PLS recomputation, out of scope offline. |
| B9 | `views/crm_lead_views.xml` | 212 | `mail_action_blacklist_remove` | DISABLE | Opens the email unblacklist wizard. |
| B10 | `views/crm_lead_views.xml` | 225 | `phone_action_blacklist_remove` | DISABLE | Opens the phone unblacklist wizard. |
| B11 | `views/crm_lead_views.xml` | 300 | `<chatter reload_on_post="True"/>` | DISABLE | `mail.message` writes are out of scope; the chatter is read-only offline. |
| B12 | `views/crm_lead_views.xml` | 323 | Leads list header "Convert to Opportunities" `%(action_crm_send_mass_convert)d` | DISABLE | Transient mass-convert wizard. |
| B13 | `views/crm_lead_views.xml` | 324 | Leads list header "Mark Lost" `%(crm.crm_lead_lost_action)d` | DISABLE | Transient-model wizard. |
| B14 | `views/crm_lead_views.xml` | 518 | Kanban card menu `<a role="menuitem" type="delete">` → `web_unlink([[id]])` → `unlink` (`models/crm_lead.py:971`) | QUEUE | The id is known on the client; framework queue, systray "Deleted". |
| B15 | `views/crm_lead_views.xml` | 520 | Kanban card menu `kanban_color_picker` → `web_save` with args `[[id], {color}]` | QUEUE | The color index is chosen on the client. |
| B16 | `views/crm_lead_views.xml` | 710 | Opportunities list header "Mark Lost" `%(crm.crm_lead_lost_action)d` | DISABLE | Transient-model wizard. |
| B17 | `views/crm_lead_views.xml` | 711 | Opportunities list header "Email" `%(crm.action_lead_mass_mail)d` | DISABLE | Mail composer wizard (mass mail). |
| B18 | `views/crm_lead_views.xml` | 760 | Opportunities list row "Email" `%(crm.action_lead_mail_compose)d` | DISABLE | Mail composer wizard. |
| B19 | `views/crm_lost_reason_views.xml` | 22 | Smart button `action_lost_leads` | DISABLE | Navigation built server-side. |
| B20 | `views/crm_team_views.xml` | 144 | Team form header "Assign Leads" `action_assign_leads` | DISABLE | The server decides the assignment. |
| B21 | `views/crm_team_views.xml` | 206 | Team smart button `action_open_opportunities` | DISABLE | Navigation built server-side. |
| B22 | `views/crm_team_views.xml` | 276 | Team dashboard `<a type="object" name="action_open_unassigned_opportunities">` | DISABLE | Navigation built server-side. |
| B23 | `views/crm_team_views.xml` | 286 | Team dashboard `<a type="action">` "Leads" (`crm_case_form_view_salesteams_lead`) | DISABLE | Navigation to a team-scoped action loaded with the team as `active_id`. |
| B24 | `views/crm_team_views.xml` | 291 | Team dashboard `<a type="action">` "Opportunities" (`crm_case_form_view_salesteams_opportunity`) | DISABLE | Navigation to a team-scoped action loaded with the team as `active_id`. |
| B25 | `views/crm_team_views.xml` | 302 | Team dashboard `<a type="action">` new "Leads" form (`crm_lead_action_open_lead_form`) | DISABLE | Navigation to a new-record form whose defaults need a server `onchange`. |
| B26 | `views/crm_team_views.xml` | 307 | Team dashboard `<a type="action">` new "Opportunity" form (`action_opportunity_form`) | DISABLE | Navigation to a new-record form whose defaults need a server `onchange`. |
| B27 | `views/crm_team_views.xml` | 318 | Team dashboard `<a type="action">` "Leads" report (`action_report_crm_lead_salesteam`) | DISABLE | Server-computed report (graph, pivot). |
| B28 | `views/crm_team_views.xml` | 323 | Team dashboard `<a type="action">` "Opportunities" report (`action_report_crm_opportunity_salesteam`) | DISABLE | Server-computed report (graph, pivot). |
| B29 | `views/crm_team_views.xml` | 331 | Team dashboard `<a type="action">` "Activities" report (`crm.crm_activity_report_action_team`) | DISABLE | Server-computed activity report. |
| B30 | `views/res_config_settings_views.xml` | 16 | Settings "Manage Recurring Plans" `crm.crm_recurring_plan_action` | DISABLE | Navigation from the transient settings form, unavailable offline. |
| B31 | `views/res_config_settings_views.xml` | 47 | Settings "Update Probabilities" `crm_lead_pls_update_action` (named `crm.crm_lead_pls_update_action` once written as an xmlid) | DISABLE | Transient PLS update wizard. |
| B32 | `views/res_config_settings_views.xml` | 64 | Settings "Update now" `action_crm_assign_leads` | DISABLE | Server-side assignment from the transient settings form. |
| B33 | `views/res_partner_views.xml` | 12 | Partner smart button `action_view_opportunity` | DISABLE | Navigation built server-side. |
| B34 | `views/utm_campaign_views.xml` | 18 | Campaign kanban `<a type="object" name="action_redirect_to_leads_opportunities">` | DISABLE | Navigation built server-side. |
| B35 | `views/utm_campaign_views.xml` | 36 | Campaign form smart button `action_redirect_to_leads_opportunities` | DISABLE | Navigation built server-side. |
| B36 | `wizard/crm_lead_lost_views.xml` | 15 | Wizard confirm "Mark as Lost" `action_lost_reason_apply` (hotkey `q`) | DISABLE | Transient-model wizard, out of scope offline. |
| B37 | `wizard/crm_lead_pls_update_views.xml` | 18 | Wizard confirm "Update" `action_update_crm_lead_probabilities` (hotkey `q`) | DISABLE | Transient-model wizard, out of scope offline. |
| B38 | `wizard/crm_lead_to_opportunity_mass_views.xml` | 55 | Wizard confirm "Convert" `action_apply` (hotkey `q`) | DISABLE | Transient-model wizard, out of scope offline. |
| B39 | `wizard/crm_merge_opportunities_views.xml` | 34 | Wizard confirm "Merge" `action_merge` (hotkey `q`) | DISABLE | Transient-model wizard, out of scope offline. |
| B40 | `report/crm_activity_report_views.xml` | 30 | Activity report list `action="action_open_lead" type="object"` | DISABLE | Server-computed report; opening a row calls the server method. |

## C. Public model methods not already named in a row (4 rows)

| # | path | line | call made | class | justification |
|---|------|------|-----------|-------|---------------|
| C1 | `models/crm_lead.py` | 1031 | `action_unarchive([ids])`, from the form and list Unarchive items (`addons/web/static/src/views/form/form_controller.js:635-642`, `addons/web/static/src/views/list/list_controller.js:477-484`) | QUEUE | The ids are known on the client; the framework queues it and the systray shows "Unarchived". |
| C2 | `models/crm_team.py` | 120 | `write`, reached by `crm.team` `web_save([[id], vals])` from form and list saves | QUEUE | User-entered values; the framework's offline save queues them. |
| C3 | `models/crm_stage.py` | 70 | `write`, reached by `crm.stage` `web_save([[id], vals])` from form and list saves | QUEUE | User-entered values; the framework's offline save queues them. |
| C4 | `models/crm_team.py` | 783 | `action_primary_channel_button`, the team dashboard card click (`addons/sales_team/views/crm_team_views.xml:132`) | DISABLE | Object call whose resulting action the server decides. |

## D. Actions-menu entries (17 rows)

Paths of D1–D12 are relative to `addons/web/static/src/views/`. When an item exists in both the form
and the list controller, both locations are given in the same order in the path and line columns.
D13–D17 are bound actions; their paths are relative to `addons/crm/`, and the line is the action
record's opening tag.

| # | path | line | call made | class | justification |
|---|------|------|-----------|-------|---------------|
| D1 | `form/form_controller.js`; `list/list_controller.js` | 625; 468 | `crm.lead` Archive (`availableOffline: true`) → inherited `action_archive([ids])` | QUEUE | The ids are known on the client; framework queue, systray "Archived". |
| D2 | `form/form_controller.js`; `list/list_controller.js` | 625; 468 | `crm.team` Archive (`availableOffline: true`) → inherited `action_archive([ids])` | QUEUE | The ids are known on the client; framework queue, systray "Archived". |
| D3 | `form/form_controller.js`; `list/list_controller.js` | 635; 477 | `crm.team` Unarchive (`availableOffline: true`) → inherited `action_unarchive([ids])` | QUEUE | The ids are known on the client; framework queue, systray "Unarchived". |
| D4 | `form/form_controller.js`; `list/list_controller.js` | 643; 485 | `crm.lead` Delete (`availableOffline: true`) → `web_unlink([ids])` → `unlink` (`models/crm_lead.py:971`) | QUEUE | The ids are known on the client; framework queue, systray "Deleted". |
| D5 | `form/form_controller.js`; `list/list_controller.js` | 643; 485 | `crm.team` Delete (`availableOffline: true`) → `web_unlink([ids])` → `unlink` (`models/crm_team.py:131`) | QUEUE | The ids are known on the client; framework queue, systray "Deleted". |
| D6 | `form/form_controller.js`; `list/list_controller.js` | 643; 485 | `crm.stage` Delete (`availableOffline: true`) → `web_unlink([ids])` | QUEUE | The ids are known on the client; framework queue, systray "Deleted". |
| D7 | `form/form_controller.js`; `list/list_controller.js` | 618; 461 | `crm.lead` Duplicate → `copy` (`copy_data`, `models/crm_lead.py:954`) | DISABLE | The server assigns the copy's id and copied values. |
| D8 | `form/form_controller.js`; `list/list_controller.js` | 618; 461 | `crm.team` Duplicate → `copy` | DISABLE | The server assigns the copy's id and copied values. |
| D9 | `form/form_controller.js`; `list/list_controller.js` | 618; 461 | `crm.stage` Duplicate → `copy` | DISABLE | The server assigns the copy's id and copied values. |
| D10 | `list/list_controller.js` | 454 | `crm.lead` Export | DISABLE | Server-computed file. |
| D11 | `list/list_controller.js` | 454 | `crm.team` Export | DISABLE | Server-computed file. |
| D12 | `list/list_controller.js` | 454 | `crm.stage` Export | DISABLE | Server-computed file. |
| D13 | `wizard/crm_lead_lost_views.xml` | 22 | Bound "Mark Lost" `crm_lead_lost_action` (form, list: default `binding_view_types`) → `crm.lead.lost` | DISABLE | Transient-model wizard, out of scope offline. |
| D14 | `wizard/crm_merge_opportunities_views.xml` | 41 | Bound "Merge Leads/Opportunities" `action_merge_opportunities` (list, kanban) → `crm.merge.opportunity` | DISABLE | Transient-model wizard, out of scope offline. |
| D15 | `views/crm_lead_views.xml` | 674 | Bound "Send email" `action_lead_mail_compose` (form) → `mail.compose.message` | DISABLE | Mail composer wizard. |
| D16 | `views/crm_lead_views.xml` | 686 | Bound "Send email" `action_lead_mass_mail` (list, kanban) → `mail.compose.message` in mass-mail mode | DISABLE | Mail composer wizard. |
| D17 | `views/crm_lead_views.xml` | 1267 | Bound "Add/Remove Followers" `mail_followers_edit_action_from_lead` (list, kanban) → `mail.followers.edit` | DISABLE | Transient-model wizard. |

The form and list variants of an item share a row, because they call the same method with the same
argument shape. `crm.lead` Unarchive is row C1, because `addons/crm/` overrides `action_unarchive`. The kanban selection-mode variants of Archive, Unarchive and Delete
(`addons/web/static/src/views/kanban/kanban_controller.js:399, 407, 414`) carry no
`availableOffline` flag, so the framework dims them offline; this is left as is, and if invoked they
queue through the same `dynamic_list` path. The kanban Duplicate and Export items (lines 392 and 385)
call the same methods as D7–D12 and share their rows.

## Swept, not requiring a live connection

These sweep hits make no server call of their own, or make it only as part of a row above. They
carry no class and are not counted.

- `user.isAdmin` session reads: `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:39, 49, 59, 69, 195`.
- `<a role="menuitem" type="open">` at `views/crm_lead_views.xml:517`: opens the record's form from
  data already on the client; the framework disables cards of records it has not stored for offline
  use.
- The form "Edit Properties" item (`addons/web/static/src/views/form/form_controller.js:604-617`): a
  client-side toggle. The properties field stays read-only offline, because `properties` is not an
  offline-editable field type (`addons/web/static/src/views/fields/field.js:19-39`).
- `action_reschedule_meeting`, `get_empty_list_help` and `get_import_templates`: no CRM button
  reaches them.
- Local functions matched by the Python sweep, not model methods and not entry points:
  `models/crm_lead.py:584` `return_if_relevant`, nested in `_compute_potential_lead_duplicates`,
  and `models/crm_lead.py:1938` `opps_key`, the sort key nested in `_sort_by_confidence_level`.
  Only their enclosing methods call them.
- `static/src/js/tours/**`: onboarding tours, excluded from the sweep.
- `static/src/views/crm_search_model.js:47`, `super.load(config)`: the framework search-model load
  shared by every view; the CRM-specific read of this file is A10.
- Service lookups at component setup, which make no server call:
  `static/src/views/crm_form/crm_pls_tooltip_button.js:30, 31`,
  `static/src/components/team_switcher/team_switcher.js:18`,
  `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:26, 27, 28` and
  `static/src/views/forecast_kanban/forecast_kanban_renderer.js:14`.
- `static/src/views/forecast_kanban/forecast_kanban_model.js:18` (a comment) and `:32` (the
  `super._webReadGroup` call inside the A22 method): part of A22.
- Continuation lines of a row's statement or tag, counted in that row:
  `static/src/views/crm_search_model.js:142` (A10),
  `static/src/webclient/share_target/crm_share_target_item.js:19` (A21),
  `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js:139` (A13),
  `views/crm_lead_views.xml:10, 13, 91, 140, 214, 227` (B1, B2, B7, B8, B9, B10),
  `views/crm_team_views.xml:207` (B21), `views/utm_campaign_views.xml:19, 37` (B34, B35),
  `wizard/crm_lead_pls_update_views.xml:19` (B37) and `report/crm_activity_report_views.xml:32`
  (B40).
- Wizard Cancel buttons (`special="cancel"`), which close the dialog on the client:
  `wizard/crm_lead_lost_views.xml:16`, `wizard/crm_lead_pls_update_views.xml:20`,
  `wizard/crm_lead_to_opportunity_mass_views.xml:56` and
  `wizard/crm_merge_opportunities_views.xml:35`.

## Python methods and the rows that reach them

Every public method found by sweep 3, with the rows that reach it.

| Model | Method (line) | Reached by |
|-------|---------------|------------|
| `crm.lead` | `create` (729) | A4 on a new record, the framework kanban quick create, N1 |
| `crm.lead` | `write` (760) | A4, A5, B15 and every framework save of a lead |
| `crm.lead` | `search_fetch` (825) | Search-backed lead reads such as list and kanban `web_search_read`, the records of open `web_read_group` groups and `name_search`; not the form's `web_read`, which reads by id; no button |
| `crm.lead` | `copy_data` (954) | D7 |
| `crm.lead` | `unlink` (971) | B14, D4 |
| `crm.lead` | `action_unarchive` (1031) | C1 |
| `crm.lead` | `action_restore` (1042) | B3 |
| `crm.lead` | `action_set_lost` (1051) | B36, opened from B4, B13, B16 and D13 |
| `crm.lead` | `action_set_won` (1057) | B1, through `action_set_won_rainbowman` |
| `crm.lead` | `action_set_automated_probability` (1083) | B7, B8 |
| `crm.lead` | `action_set_won_rainbowman` (1089) | B1 |
| `crm.lead` | `get_rainbowman_message` (1105) | A1–A3 |
| `crm.lead` | `action_schedule_meeting` (1197) | B5 |
| `crm.lead` | `action_reschedule_meeting` (1299), `get_empty_list_help` (1357), `get_import_templates` (2147) | No CRM button (swept list) |
| `crm.lead` | `action_show_potential_duplicates` (1307) | B6 |
| `crm.lead` | `action_convert_to_opportunity` (1320) | B2 |
| `crm.lead` | `redirect_lead_opportunity_view` (1343), `log_meeting` (1435), `merge_opportunity` (1505), `convert_opportunity` (1831), `message_new` (2105) | Server-side callers only (wizards, calendar sync, the mail gateway, the CRM controller) or other addons; no CRM button calls them directly |
| `crm.lead` | `prepare_pls_tooltip_data` (2794) | A19 |
| `crm.team` | `write` (120) | C2 |
| `crm.team` | `unlink` (131) | D5 |
| `crm.team` | `action_assign_leads` (211) | B20 |
| `crm.team` | `action_open_opportunities` (762) | B21 |
| `crm.team` | `action_open_unassigned_opportunities` (770) | B22 |
| `crm.team` | `action_primary_channel_button` (783) | C4 |
| `crm.team` | `get_team_switcher_data` (794) | A10 |
| `crm.stage` | `write` (70) | C3 |

## Counts

| Source | Rows | QUEUE | SKIP | DISABLE |
|--------|------|-------|------|---------|
| A. JS calls | 23 | 2 | 5 | 16 |
| B. XML buttons | 40 | 2 | 0 | 38 |
| C. Public model methods | 4 | 3 | 0 | 1 |
| D. Actions-menu entries | 17 | 6 | 0 | 11 |
| **Total** | **84** | **13** | **5** | **66** |

## Planned entry points (new code)

These are the entry points of the new offline and mobile code. They are counted apart from the 84
existing-code rows above.

| Id | Entry point | Class |
|----|-------------|-------|
| N1 | Mobile quick create: `crm.lead` `web_save([], vals)` | QUEUE |
| N2 | Mobile card stage move, Won included: `web_save` with args `[[id], {stage_id}]` | QUEUE |
| N3 | Log call and follow-up: `mail.activity` `web_save([], {res_model, res_id, activity_type_id, summary, date_deadline, user_id})` | QUEUE |
| N4 | Mark done of any persisted, cached activity, whatever its category: `mail.activity` `action_archive([[id]])` | QUEUE (state only) |
| N5 | Log call and Follow-up creation controls when no creatable (non-meeting, non-upload) activity type is cached; Log call alone when no `phonecall` type is cached. The activity list and mark-done (N4) do not depend on the type cache | DISABLE |
| N6 | Activity actions on a pending lead, and mark-done on a pending activity | DISABLE (needs another call's id) |
| N7 | Creating a calendar event from an activity, meeting-type activity creation, and upload launchers | DISABLE (unreachable: calendar round-trip or file upload) |

N4 holds for `meeting` and `upload_file` activities too. `action_archive` only writes `active`. The
calendar inherit synchronizes an event only when `date_deadline` changes, and event creation and
feedback live in separate methods (`addons/calendar/models/mail_activity.py:14-33, 35-69`).
Archiving therefore creates no event, changes no event and needs no upload.

The shared offline queue persists queued values unencrypted (K10), an existing limitation of the
shared stack that this work does not change; CRM queues only user-entered values and ids that are
already cached.
