# CRM offline surface inventory

Milestone 1 (inventory only — **no code changes** in this commit). This document sweeps
`addons/crm/` for every entry point that needs a live server, and classifies each one so a
later milestone can enforce it. HEAD at the time of this sweep: `8916e416` (branch
`eval/factory-crm-offline`). Every file:line citation below was re-read at this commit; none
is copied uncritically from the starting research reports (`{missionDir}/research/
crm_js_sweep.md`, `crm_python_views.md`, `design_options.md`) — those reports seeded the
search, but every row here was independently re-verified against the files in this repo.

## Rules (applied in order, verbatim from the kickoff)

1. **QUEUE** — a write on `crm.lead`, `crm.stage`, `crm.team`, or a lead's `mail.activity`,
   whose full argument list is resolvable on the client (offline it queues, the UI updates
   optimistically).
2. **SKIP** — a read that is only decorative/advisory (tooltip, visual effect, promotional
   hint, group probe that only toggles display). Skipped silently offline, never queued.
3. **DISABLE** — everything else (transient wizards, module install, paid external lookups,
   server-computed reports, access probes gating destructive UI, navigation to anything
   unavailable offline). Anything needing a server onchange, a transient-model wizard, or an
   id produced by another call is DISABLE, never QUEUE.

Each row gets **exactly one** of the three tokens, decided by applying the rules in this
order (i.e. if a call could be read as either QUEUE and DISABLE, rule 1 is tried first: it
is QUEUE only if it is truly a bare, client-resolvable write; otherwise it falls through).

## Sweep method (reproducible)

**Section A** — every JS/XML file under `addons/crm/static/src/**`, first with:
```
rg -n "orm\.|useService\(\"orm\"\)|services\.orm|rpc\(|doAction|loadAction|switchView|actionService|useService\(\"action\"\)|hasGroup|checkAccessRight|has_access|fetch\(|loadBundle|\.call\(" addons/crm/static/src
```
then a second pass to catch ORM method names the first pattern's `\.call\(` alternative
does not literally spell out:
```
rg -n "orm\.(webSave|call|read|searchRead|webSearchRead|readGroup|formattedReadGroup|write|create|unlink|cache|silent)\(|\.orm\b|useService\(.orm.\)|useService\(.action.\)|this\.action\.|checkAccessRight|hasGroup|user\.isAdmin|\.silent\.call" addons/crm/static/src
rg -n "webSearchRead|searchRead|readGroup|formattedReadGroup|webSave|read_group|name_search|save\(\)|\.load\(\)|record\.save|list\.load\(" addons/crm/static/src
```
Every matched line was opened in context and either turned into a row or excluded with a
documented reason (below). Every `*.js`/`*.xml` file under `addons/crm/static/src/` was also
listed (`find addons/crm/static/src -type f \( -name "*.js" -o -name "*.xml" \)`, 47 files)
and cross-checked file by file so files with zero hits are confirmed empty, not skipped.

**Excluded from Section A** (matched a broad grep, but not a network call, or not an Odoo
server call):
- `user.isAdmin` (`lead_generation_dropdown.js:39,49,59,69,195`): a synchronous session
  property set once at login, no RPC.
- `useService("fillTemporalService")` (`forecast_kanban_renderer.js:14`): a local,
  client-only date-math helper registered as a service; it issues no request itself.
- `promote_mail_plugins_dialog.xml` (`<a href>` to odoo.com/YouTube/Gmail/Outlook, an
  `<iframe>` to YouTube, `<img>` from `download.odoocdn.com`): promotional external links
  with no Odoo backend call at all; not reachable offline anyway because the Generate
  button that opens the dialog is auto-disabled (no `data-available-offline`).
- Files with **zero** matches on any of the patterns above (confirmed by grepping each
  individually): `crm_breadcrumbs.js`, `promote_mail_plugins_dialog.js`,
  `core/common/crm_lead_model.js`, `core/common/res_partner_model_patch.js`,
  `js/fields/many2one_avatar_leader_user.js` (adds a context key only; the actual
  `web_name_search` it feeds is issued and offline-handled by web's `Many2XAutocomplete`,
  outside `addons/crm`), `js/tours/crm.js`, `views/crm_control_panel.js`,
  `views/crm_kanban/crm_kanban_arch_parser.js`, `views/crm_kanban/crm_kanban_renderer.js`,
  `views/crm_kanban/crm_kanban_view.js` (+ `.xml`), `views/crm_list/crm_list_view.js`
  (+ `.xml`), `views/crm_activity/crm_activity_view.js`,
  `views/crm_calendar/crm_calendar_view.js`, `views/crm_graph/crm_graph_view.js`,
  `views/crm_pivot/crm_pivot_view.js`, `views/forecast_graph/forecast_graph_view.js`,
  `views/forecast_pivot/forecast_pivot_view.js`, `views/forecast_list/forecast_list_view.js`,
  `views/forecast_search_model.js`, `views/forecast_kanban/forecast_kanban_view.js`,
  `views/forecast_kanban/forecast_kanban_controller.js`,
  `views/forecast_kanban/forecast_kanban_column_quick_create.js` (its `unfold()` only calls
  `this.props.onValidate()`, which is the `list.load()` already listed as A24),
  `views/forecast_kanban/forecast_kanban_model.js` (overrides `_webReadGroup`/
  `_loadGroupedList` but only calls `super.*`; no direct `orm`/`rpc`/`doAction` token),
  `views/fill_temporal_service.js` (pure date arithmetic), `webclient/share_target/
  crm_share_target_item.xml`, `components/breadcrumbs/crm_breadcrumbs.xml`,
  `components/team_switcher/team_switcher.xml` (markup only, no calls of its own),
  `components/lead_generation_dropdown/lead_generation_dropdown.xml` (markup only),
  `views/crm_form/crm_pls_tooltip_button.xml` (markup only), `views/crm_kanban/
  crm_column_progress.xml` (markup only), `views/forecast_kanban/
  forecast_kanban_renderer.xml` (markup only).

**Section B** — `addons/crm/views/*.xml`, `addons/crm/wizard/*.xml`, `addons/crm/report/*.xml`:
```
rg -n "<button|type=\"object\"|type=\"action\"|<a |statusbar|<chatter|quick_create|kanban_color_picker|kanban_activity|widget=\"priority\"|type=\"delete\"|type=\"open\"|reschedule_dropdown" addons/crm/views addons/crm/wizard addons/crm/report
```
Every `ir.ui.view`/wizard/report record with an arch was opened and read fully (all 18 files
under `views/`, all 4 wizard arch files, both report arch files); non-arch records (menus,
plain `ir.actions.act_window` records with no view button of their own) were excluded unless
reached via an `<a type="action">`/`<button type="action">` from a view that is in scope.

**Excluded from Section B** (matched a broad grep, but no distinct server-side-effect row):
the `crm.lead` form has two more `widget="priority"` fields
(`views/crm_lead_views.xml:242,244`, desktop and touch header layouts) and one inside the
quick-create form (`:440`); unlike the kanban/list occurrences (B22, B53, B54), a form field
only stages a pending change — it needs an explicit Save click to write, so it is already
covered by the generic form-save producer (A13/B5) rather than getting its own row; the
quick-create occurrence (`:440`) is part of the create vals already covered by B24. The
`<a href="mailto:...">` in `views/crm_helper_templates.xml:8` and `<a t-att-href="lead.website">`
in `views/crm_lead_templates.xml:32` are mail-template markup (external mailto/website links,
not Odoo server calls). `report/crm_opportunity_report_views.xml:11` removes (`position="replace"`)
the `mail_activity_mixin_list_reschedule_dropdown` widget from the report list — no server
effect, deleting a control, not adding one. `special="cancel"` buttons in every wizard just
close the dialog client-side, no row needed.

**Section C** — public (no leading underscore) methods on `crm.lead`, `crm.stage`,
`crm.team`:
```
grep -n "^    def [a-zA-Z]" addons/crm/models/crm_lead.py addons/crm/models/crm_stage.py addons/crm/models/crm_team.py
```
then each method was checked against every Section A/B row (button `name=`, `<a name=>`, or
JS `orm.call`/`scheduleORM` target) and against `grep -rn "<method>" addons/crm/{views,wizard,report,static}`
to decide reachability from a button. Methods not referenced anywhere in `addons/crm`
views/wizard/report/JS are listed as excluded, not silently dropped (below).

**Excluded from Section C** (public, defined in `addons/crm/models/*.py`, but not reachable
from any button in a crm view, wizard, report, or from crm JS — confirmed with
`grep -rn "<name>" addons/crm/{views,wizard,report,static/src}`, zero hits outside the
method's own file and, where applicable, the one caller noted):
- `crm.lead`: `search_fetch` (ORM override, not a button target), `copy_data` (Duplicate
  context-menu action is not an in-scope crm view control), `action_unarchive` (only called
  internally by `action_restore`/`action_set_won`, already covered via those rows),
  `redirect_lead_opportunity_view`, `action_reschedule_meeting`, `get_empty_list_help`
  (`@api.model`, empty-list helper, not a button), `log_meeting`, `merge_opportunity` (called
  by the merge wizard's `action_merge`, itself already DISABLE — see B52/C-adjacent),
  `convert_opportunity` (called internally by `action_convert_to_opportunity`, see C12),
  `message_new` (mail gateway entry point, not a button), `get_import_templates` (import
  wizard entry point, not a crm view button).
- `crm.team`: `action_primary_channel_button` (defined in `crm_team.py:783`, not referenced
  anywhere under `addons/crm/views`, `wizard`, `report`, or `static/src` — dead from crm's
  own UI today; it is a `sales_team` dashboard control this addon does not customize).

## Section A — JS/XML ORM, rpc, action-service and group/access-probe calls (`static/src/**`)

| # | File | Line | Call / control | Class | Justification |
|---|---|---|---|---|---|
| A1 | `static/src/activity_menu_patch.js` | 39 | `this.action.loadAction("crm.crm_lead_action_my_activities")` | DISABLE | Activity-menu CRM entry (contract: DISABLE); disk-cached action, but its search state (activity filters, `active in [true,false]`) is unlikely to be visited, and the promise has no `.catch`. |
| A2 | `static/src/activity_menu_patch.js` | 45 | `this.action.doAction(action, {...})` | DISABLE | Same activity-menu CRM entry path as A1. |
| A3 | `static/src/components/team_switcher/team_switcher.js` | 18 | `this.actionService = useService("action")` | SKIP | Service-handle acquisition only; no network I/O at this line (the call it enables is A5). |
| A4 | `static/src/components/team_switcher/team_switcher.js` | 21 | `await user.hasGroup("sales_team.group_sale_manager")` | SKIP | Team-switcher sales-manager probe (contract: SKIP); only toggles "Manage Teams" visibility. |
| A5 | `static/src/components/team_switcher/team_switcher.js` | 46 | `this.actionService.doAction("sales_team.crm_team_action_config")` | DISABLE | "Manage Teams" navigation (contract: DISABLE); manager-only admin area, its `DropdownItem` is not auto-disabled. |
| A6 | `static/src/views/crm_search_model.js` | 130-142 | `this.orm.cache({type:"disk",update:"always",callback}).call("crm.team","get_team_switcher_data")` | SKIP | Feeds the switcher list/domain; on a cache miss or offline the file's own "Offline Mode" section already falls back to "All Teams" with no crash and no queueing — same decision family as the team-switcher probe (see Notes #2 for the debated alternative). |
| A7 | `static/src/views/crm_kanban/crm_column_progress.js` | 14 | `await user.hasGroup("crm.group_use_recurring_revenues")` | SKIP | Recurring-revenue (MRR) group probe (contract: SKIP); only toggles the MRR aggregate line. |
| A8 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 30 | `this.orm = useService("orm")` | SKIP | Service-handle acquisition only; no network I/O at this line. |
| A9 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 45 | `await this.props.record.save()` | QUEUE | Framework's `web_save` producer (`record.js` `_offlineSave`); queues any pending changes before the tooltip computation, same generic mechanism as any form save. |
| A10 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 51 | `await this.orm.call("crm.lead","prepare_pls_tooltip_data",[this.props.record.resId])` | DISABLE | PLS tooltip lookup (contract: DISABLE). |
| A11 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 57 | `await this.props.record.load()` | DISABLE | Refresh tied to the same disabled PLS-tooltip flow (reloads the server-recomputed probability); not merely decorative, so it does not qualify for SKIP, and it is unreachable once the control is disabled per A10/B9/B10. |
| A12 | `static/src/views/check_rainbowman_message.js` | 2 | `await orm.call("crm.lead","get_rainbowman_message",[[recordId]])` | SKIP | Post-save rainbowman lookup (contract: SKIP, known defect 1). |
| A13 | `static/src/views/crm_form/crm_form.js` | 49 | `const res = await super._save(...arguments)` | QUEUE | Framework's `orm.webSave("crm.lead",...)` producer, reached from the form Save button, statusbar stage click, or breadcrumb leave. |
| A14 | `static/src/views/crm_form/crm_form.js` | 51 | `await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId)` | SKIP | Rainbowman lookup call site (defect 1) after a stage-changing form save. |
| A15 | `static/src/views/crm_kanban/crm_kanban_model.js` | 25 | `await super.moveRecords(...arguments)` | QUEUE | Framework's per-record `web_save({stage_id})` producer for a kanban drag; also the only kanban "mark-won" path (dropping into an `is_won` stage). |
| A16 | `static/src/views/crm_kanban/crm_kanban_model.js` | 29 | `await checkRainbowmanMessage(this.model.orm, this.model.effect, movedLeads[0].resId)` | SKIP | Rainbowman lookup call site (defect 1) after a kanban stage drop. |
| A17 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 26 | `this.orm = useService("orm")` | SKIP | Service-handle acquisition only. |
| A18 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 28 | `this.action = useService("action")` | SKIP | Service-handle acquisition only. |
| A19 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 137-143 | `await this.orm.cache().searchRead("ir.module.module",[["name","in",moduleNames]],["id","name","shortdesc"])` | DISABLE | Lead generation (contract: DISABLE); module-install lookup, and the Generate button already lacks `data-available-offline`. |
| A20 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 165 | `await user.checkAccessRight(model,"create")` | DISABLE | Lead generation (contract: DISABLE); access probe gating install/access-request UI (dead code today: no `dropdownContentElements` entry sets `model`). |
| A21 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 206 | `await this.orm.silent.call("ir.module.module","button_immediate_install",[id])` | DISABLE | Lead generation, module install (contract: DISABLE). |
| A22 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 241 | `this.action.doAction({type:"ir.actions.client",tag:"import",...})` | DISABLE | Lead generation, CSV/Excel import client action (contract: DISABLE). |
| A23 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 257 | `this.action.doAction({type:"ir.actions.act_window",res_model:"base.module.install.request",...})` | DISABLE | Lead generation, transient access-request wizard (contract: DISABLE). |
| A24 | `static/src/views/forecast_kanban/forecast_kanban_renderer.js` | 48 | `await this.props.list.load()` | DISABLE | Forecast kanban "add next period" column (contract: forecast views DISABLE); the new `fill_temporal` read-group context is never cached. |
| A25 | `static/src/webclient/share_target/crm_share_target_item.js` | 18-22 | `this.state.teams = await this.orm.webSearchRead("crm.team", this.teamsDomain, {...}).then(...)` | DISABLE | PWA share-target team lookup; the whole share-to-lead flow needs a server-produced id from `name_create` on `res.partner` before an `ir.attachment` write — a chained id, DISABLE per the chained-id rule. |

## Section B — view, wizard and report buttons/controls with a server side effect

| # | File | Line | Call / control | Class | Justification |
|---|---|---|---|---|---|
| B1 | `views/crm_lead_views.xml` | 9-11 | Form header button `action_set_won_rainbowman` ("Won"), type=object | QUEUE | Bare `[[id]]` write path to `action_set_won` server-side; a CRM producer must call `action_set_won` directly (not this `_rainbowman` wrapper) per architecture — see Notes #1. |
| B2 | `views/crm_lead_views.xml` | 12-13 | Form header button `action_convert_to_opportunity`, type=object | DISABLE | Creates/matches a `res.partner` server-side and the UI expects a reload; not a bare resolvable write. |
| B3 | `views/crm_lead_views.xml` | 14-15 | Form header button `action_restore`, type=object | QUEUE | Bare `[[id]]` write (`action_unarchive` + probability reset); needs a CRM-side producer — see Notes #1. |
| B4 | `views/crm_lead_views.xml` | 16-17 | Form header button `%(crm.crm_lead_lost_action)d` ("Lost"), type=action | DISABLE | Opens the transient `crm.lead.lost` wizard (contract: mark-lost wizard DISABLE). |
| B5 | `views/crm_lead_views.xml` | 18-21 | `<field name="stage_id" widget="rotting_statusbar_duration">` (clickable statusbar) | QUEUE | Framework `web_save({stage_id})` producer on form save. |
| B6 | `views/crm_lead_views.xml` | 33-41 | Stat button `action_schedule_meeting` | DISABLE | Calendar-event scheduling (contract: DISABLE); returns a calendar action built server-side. |
| B7 | `views/crm_lead_views.xml` | 42-50 | Stat button `action_show_potential_duplicates` | DISABLE | Navigation to a server-computed duplicate-lead action; read-only, not resolvable client-side. |
| B8 | `views/crm_lead_views.xml` | 89-90 | `<a type="object" name="action_set_automated_probability">` (AI switch, desktop layout) | QUEUE | Bare `[[id]]` write, recomputed server-side on replay; debatable — see Notes #2 (the `<a>` is not auto-disabled by the framework). |
| B9 | `views/crm_lead_views.xml` | 99 | `<widget name="pls_tooltip_button">` (desktop layout) | DISABLE | PLS tooltip control (contract: DISABLE). |
| B10 | `views/crm_lead_views.xml` | 131 | `<widget name="pls_tooltip_button">` (touch/mobile layout) | DISABLE | Same PLS tooltip control, second occurrence. |
| B11 | `views/crm_lead_views.xml` | 138-139 | `<a type="object" name="action_set_automated_probability">` (touch/mobile layout) | QUEUE | Same as B8, second occurrence; debatable — see Notes #2. |
| B12 | `views/crm_lead_views.xml` | 212-215 | Button `mail_action_blacklist_remove` | DISABLE | Opens the transient `mail.blacklist.remove` wizard. |
| B13 | `views/crm_lead_views.xml` | 225-228 | Button `phone_action_blacklist_remove` | DISABLE | Opens the transient `phone.blacklist.remove` wizard. |
| B14 | `views/crm_lead_views.xml` | 300 | `<chatter reload_on_post="True"/>` | DISABLE | Chatter write controls (contract: DISABLE); mail's post/log/attachments/followers/schedule all need the server and are not crm-owned. |
| B15 | `views/crm_lead_views.xml` | 323 | List header button `%(action_crm_send_mass_convert)d` ("Convert to Opportunities") | DISABLE | Mass-convert transient wizard (contract: DISABLE). |
| B16 | `views/crm_lead_views.xml` | 324 | List header button `%(crm.crm_lead_lost_action)d` ("Mark Lost") | DISABLE | Mark-lost wizard (contract: DISABLE). |
| B17 | `views/crm_lead_views.xml` | 374 | `<field name="activity_ids" widget="kanban_activity"/>` (Leads mobile kanban card footer) | DISABLE | Opens mail's activity popover: "Schedule" opens the transient `mail.activity.schedule` wizard; "Mark Done" on an existing activity would be bare-id resolvable but is mail's control with no crm-side offline handling designed yet — debatable, see Notes #2. |
| B18 | `views/crm_lead_views.xml` | 517 | `<a role="menuitem" type="open">` (kanban card menu "Edit") | DISABLE | Opens the lead form; today the framework does not gate this click on `isAvailableOffline`, so an uncached lead throws `ConnectionLostError` silently. Consistent with architecture's planned `OfflineActionHelper`-at-tap-point fix (item 3.2.10, not yet implemented) — see Notes #3. |
| B19 | `views/crm_lead_views.xml` | 518 | `<a role="menuitem" type="delete">` (kanban card menu "Delete") | QUEUE | Framework's `web_unlink` producer (bare ids), already queued with no crm code needed. |
| B20 | `views/crm_lead_views.xml` | 520 | `<field name="color" widget="kanban_color_picker"/>` (kanban card menu) | QUEUE | Framework `web_save({color})` producer. |
| B21 | `views/crm_lead_views.xml` | 503 | Drag-and-drop between stage columns (pipeline kanban, `crm_case_kanban_view_leads`) | QUEUE | Framework per-record `web_save({stage_id})` producer (same mechanism as A15); also the kanban's only mark-won path (drop into an `is_won` stage). |
| B22 | `views/crm_lead_views.xml` | 546 | `<field name="priority" widget="priority"/>` (pipeline kanban card) | QUEUE | Framework `web_save({priority})` producer. |
| B23 | `views/crm_lead_views.xml` | 547 | `<field name="activity_ids" widget="kanban_activity"/>` (pipeline kanban card footer) | DISABLE | Same control as B17, second occurrence (pipeline kanban instead of Leads kanban). |
| B24 | `views/crm_lead_views.xml` | 503 | `on_create="quick_create" quick_create_view="crm.quick_create_opportunity_form"` (pipeline kanban) | QUEUE | New-record quick create → framework `web_save([], vals)` create producer; the crm quick-create form has no onchange dependency for its editable fields. |
| B25 | `views/crm_lead_views.xml` | 408 | `<field name="partner_id">` "Create" option inside `crm.quick_create_opportunity_form` | DISABLE | Creating a new `res.partner` from the quick create needs a server-produced id — chained-id rule; picking an already-cached partner still falls under B24's QUEUE path. |
| B26 | `views/crm_lead_views.xml` | 710 | Opportunities list header button `%(crm.crm_lead_lost_action)d` ("Mark Lost") | DISABLE | Mark-lost wizard (contract: DISABLE). |
| B27 | `views/crm_lead_views.xml` | 711 | Opportunities list header button `%(crm.action_lead_mass_mail)d` ("Email") | DISABLE | Transient `mail.compose.message` mass-mail wizard. |
| B28 | `views/crm_lead_views.xml` | 759 | `<widget name="mail_activity_mixin_list_reschedule_dropdown"/>` (Opportunities list) | DISABLE | Calls `mail.activity` reschedule methods with a date-picker UI not designed for offline; debatable, see Notes #2. |
| B29 | `views/crm_lead_views.xml` | 760 | Opportunities list row button `%(crm.action_lead_mail_compose)d` ("Email") | DISABLE | Transient `mail.compose.message` wizard. |
| B30 | `views/crm_team_views.xml` | 144-149 | Team form button `action_assign_leads` ("Assign Leads", with confirm) | DISABLE | Mass assignment across many leads, posts a note, returns a notification action; not a bare single-record write. |
| B31 | `views/crm_team_views.xml` | 206-211 | Team form stat button `action_open_opportunities` | DISABLE | Navigation; returns a read-only action. |
| B32 | `views/crm_team_views.xml` | 276 | `<a name="action_open_unassigned_opportunities" type="object">` (team kanban dashboard) | DISABLE | Navigation; returns a read-only action. |
| B33 | `views/crm_team_views.xml` | 286 | `<a name="%(crm_case_form_view_salesteams_lead)d" type="action">` (team kanban dashboard) | DISABLE | Navigation to a leads action scoped by `active_id`, unlikely to be a visited search state. |
| B34 | `views/crm_team_views.xml` | 291 | `<a name="%(crm_case_form_view_salesteams_opportunity)d" type="action">` (team kanban dashboard) | DISABLE | Same reasoning as B33. |
| B35 | `views/crm_team_views.xml` | 302 | `<a name="%(crm_lead_action_open_lead_form)d" type="action">` ("New Lead" from Teams dashboard) | DISABLE | Opens a new-lead form whose onchange/context for this specific `active_id` is unlikely to be cached. |
| B36 | `views/crm_team_views.xml` | 307 | `<a name="%(action_opportunity_form)d" type="action">` ("New Opportunity") | DISABLE | Same reasoning as B35. |
| B37 | `views/crm_team_views.xml` | 318 | `<a name="%(action_report_crm_lead_salesteam)d" type="action">` (Leads report) | DISABLE | Server-computed report/analysis view (contract: forecast/graph/pivot views DISABLE family). |
| B38 | `views/crm_team_views.xml` | 323 | `<a name="%(action_report_crm_opportunity_salesteam)d" type="action">` (Opportunities report) | DISABLE | Same reasoning as B37. |
| B39 | `views/crm_team_views.xml` | 331 | `<a name="%(crm.crm_activity_report_action_team)d" type="action">` (Activities report) | DISABLE | Same reasoning as B37. |
| B40 | `views/crm_stage_views.xml` | 22, 37 | `crm_stage_tree` (multi_edit list) / `crm_stage_form` field edits | QUEUE | Framework `web_save` producer for `crm.stage` edits; write access is manager-only, so a salesman's queued edit is parked with an `AccessError` by the framework (no rule change). |
| B41 | `views/crm_lost_reason_views.xml` | 22-28 | Stat button `action_lost_leads` | DISABLE | Navigation; returns a read-only action. |
| B42 | `views/res_partner_views.xml` | 12-19 | Partner form stat button `action_view_opportunity` | DISABLE | Navigation; returns a read-only action (also on `res.partner`, not `crm.lead`). |
| B43 | `views/utm_campaign_views.xml` | 17-24 | Campaign kanban `<a type="object" name="action_redirect_to_leads_opportunities">` | DISABLE | Navigation; returns a read-only action. |
| B44 | `views/utm_campaign_views.xml` | 36-44 | Campaign form stat button `action_redirect_to_leads_opportunities` | DISABLE | Same method as B43, second occurrence. |
| B45 | `views/res_config_settings_views.xml` | 16-18 | Settings button `crm.crm_recurring_plan_action`, type=action | DISABLE | Settings navigation to `crm.recurring.plan` management. |
| B46 | `views/res_config_settings_views.xml` | 47-49 | Settings button `%(crm_lead_pls_update_action)d` ("Update Probabilities") | DISABLE | PLS-update wizard (contract: DISABLE). |
| B47 | `views/res_config_settings_views.xml` | 64 | Settings button `action_crm_assign_leads` | DISABLE | Triggers a lead-assignment run from `res.config.settings` (not a `crm.lead`/`stage`/`team` method). |
| B48 | `report/crm_activity_report_views.xml` | 31 | `<list action="action_open_lead" type="object">` (row click) | DISABLE | Server-computed report list row navigation (contract: report/analysis views DISABLE family). |
| B49 | `wizard/crm_lead_lost_views.xml` | 15 | Footer button `action_lost_reason_apply` (transient `crm.lead.lost`) | DISABLE | Mark-lost wizard confirm (contract: DISABLE); logs a closing note, then calls `action_set_lost` on the leads server-side. |
| B50 | `wizard/crm_lead_pls_update_views.xml` | 18-20 | Footer button `action_update_crm_lead_probabilities` (transient `crm.lead.pls.update`) | DISABLE | PLS-update wizard (contract: DISABLE). |
| B51 | `wizard/crm_lead_to_opportunity_mass_views.xml` | 55 | Footer button `action_apply` ("Convert", transient `crm.lead2opportunity.partner.mass`) | DISABLE | Mass-convert wizard (contract: DISABLE). |
| B52 | `wizard/crm_merge_opportunities_views.xml` | 34 | Footer button `action_merge` ("Merge", transient `crm.merge.opportunity`) | DISABLE | Merge wizard (contract: DISABLE). |
| B53 | `views/crm_lead_views.xml` | 373 | `<field name="priority" widget="priority"/>` (Leads mobile kanban card footer) | QUEUE | Framework `web_save({priority})` producer, same mechanism as B22, second kanban view (Leads instead of pipeline). |
| B54 | `views/crm_lead_views.xml` | 734 | `<field name="priority" optional="hide" widget="priority"/>` (Opportunities list column) | QUEUE | Framework `web_save({priority})` producer; list-view click-to-save widget, same mechanism as B22/B53, third occurrence. |

## Section C — public `crm.lead` / `crm.stage` / `crm.team` methods reachable from a button

| # | File | Line | Method | Class | Justification |
|---|---|---|---|---|---|
| C1 | `models/crm_lead.py` | 729 | `create(vals_list)` | QUEUE | Reachable via any Save on a new record or the pipeline quick create (B24); framework `web_save`/create producer, bare vals resolvable client-side. |
| C2 | `models/crm_lead.py` | 760 | `write(vals)` | QUEUE | Reachable via any Save/edit/stage-move/priority/color control (B5, B20-B22); framework `web_save` producer; stage-change side effects (`date_last_stage_update`, won-stage forcing) run fully server-side on replay. |
| C3 | `models/crm_lead.py` | 971 | `unlink()` | QUEUE | Reachable via the kanban "Delete" menu item (B19); framework `web_unlink` producer (bare ids); a salesman's queued delete is parked with an `AccessError` since salesmen have no unlink rights (no rule change). |
| C4 | `models/crm_lead.py` | 1042 | `action_restore()` | QUEUE | Reachable via the "Restore" button (B3); bare `[[id]]` write; needs a CRM-side `scheduleORM` producer — see Notes #1. |
| C5 | `models/crm_lead.py` | 1051 | `action_set_lost(**additional_values)` | DISABLE | Reachable today only indirectly, through the transient `crm.lead.lost` wizard's `action_lost_reason_apply` (B49), itself DISABLE; no crm view calls this method directly. A hypothetical direct `action_set_lost([[id]],{lost_reason_id})` call would be bare-args QUEUE-able, but no button reaches it that way today — see Notes #2. |
| C6 | `models/crm_lead.py` | 1057 | `action_set_won()` | QUEUE | Reachable indirectly via the "Won" button (B1), which today calls `action_set_won_rainbowman` (C8); architecture's approved Won producer must call this method directly instead — see Notes #1. |
| C7 | `models/crm_lead.py` | 1083 | `action_set_automated_probability()` | QUEUE | Reachable via the AI-switch `<a>` controls (B8, B11); `ensure_one`, bare `[[id]]`, recomputes and writes probability server-side; debatable — see Notes #2. |
| C8 | `models/crm_lead.py` | 1089 | `action_set_won_rainbowman()` | DISABLE | The button-bound method itself (B1's `name=` target); it calls `get_rainbowman_message` (a heavy SQL read) and returns an effect action needing a live round-trip — not itself a resolvable producer. The button (B1) is still QUEUE because the *intended* producer bypasses this wrapper and calls `action_set_won` (C6) directly — see Notes #1/#2. |
| C9 | `models/crm_lead.py` | 1105 | `get_rainbowman_message()` | SKIP | Reachable via the JS calls after any stage-changing save/drag (A12, A14, A16); rainbowman lookup (contract: SKIP, known defect 1). |
| C10 | `models/crm_lead.py` | 1197 | `action_schedule_meeting(smart_calendar=True)` | DISABLE | Reachable via the "Meeting" stat button (B6); calendar-event scheduling (contract: DISABLE). |
| C11 | `models/crm_lead.py` | 1307 | `action_show_potential_duplicates()` | DISABLE | Reachable via the stat button (B7); navigation, read-only server action. |
| C12 | `models/crm_lead.py` | 1320 | `action_convert_to_opportunity()` | DISABLE | Reachable via the "Convert to Opportunity" button (B2); creates/matches a `res.partner` server-side. |
| C13 | `models/crm_lead.py` | 2794 | `prepare_pls_tooltip_data()` | DISABLE | Reachable via the PLS tooltip widget (A10, B9, B10); PLS tooltip lookup (contract: DISABLE). |
| C14 | `models/crm_stage.py` | 70 | `write(vals)` | QUEUE | Reachable via any stage edit (B40); framework `web_save` producer; write access is manager-only (no rule change; a salesman's queued edit is parked with an `AccessError`, matching current online behavior). |
| C15 | `models/crm_team.py` | 120 | `write(vals)` | QUEUE | Reachable via any team form Save (inherited `sales_team` form, edited in-scope by `sales_team_form_view_in_crm`); framework `web_save` producer (updates the alias when `use_leads`/`use_opportunities` change). |
| C16 | `models/crm_team.py` | 131 | `unlink()` | QUEUE | Reachable via the team list/kanban Delete action (inherited from `sales_team`, the override itself lives in this crm file); framework `web_unlink` producer. |
| C17 | `models/crm_team.py` | 211 | `action_assign_leads()` | DISABLE | Reachable via the "Assign Leads" button (B30); mass assignment across many leads, posts a note, returns a notification action. |
| C18 | `models/crm_team.py` | 762 | `action_open_opportunities()` | DISABLE | Reachable via the stat button (B31); navigation, read-only. |
| C19 | `models/crm_team.py` | 770 | `action_open_unassigned_opportunities()` | DISABLE | Reachable via the dashboard `<a>` (B32); navigation, read-only. |
| C20 | `models/crm_team.py` | 794 | `get_team_switcher_data()` | SKIP | Reachable via the JS call (A6); same decision as A6 (falls back to "All Teams", no queueing) — debatable, see Notes #2. |

## Counts

### Overall

| Classification | Count |
|---|---|
| QUEUE | 25 |
| SKIP | 12 |
| DISABLE | 62 |
| **Total** | **99** |

### Per section

| Section | Rows | QUEUE | SKIP | DISABLE |
|---|---|---|---|---|
| A — JS/XML calls | 25 | 3 (A9, A13, A15) | 10 (A3, A4, A6, A7, A8, A12, A14, A16, A17, A18) | 12 (A1, A2, A5, A10, A11, A19, A20, A21, A22, A23, A24, A25) |
| B — view/wizard/report buttons and controls | 54 | 13 (B1, B3, B5, B8, B11, B19, B20, B21, B22, B24, B40, B53, B54) | 0 | 41 (B2, B4, B6, B7, B9, B10, B12-B18, B23, B25-B39, B41-B52) |
| C — public model methods reachable from a button | 20 | 9 (C1, C2, C3, C4, C6, C7, C14, C15, C16) | 2 (C9, C20) | 9 (C5, C8, C10, C11, C12, C13, C17, C18, C19) |
| **Total** | **99** | **25** | **12** | **62** |

## Notes for review

### 1. QUEUE rows that need a CRM-side `scheduleORM` producer beyond what the framework already queues

The web framework's own producers (`record.js`, `dynamic_list.js`) only ever issue
`web_save`, `web_unlink`, `action_archive`/`action_unarchive`. Every QUEUE row above that is
**not** one of those four is already reached today only through the *online* `orm.call`
path (a plain `type="object"` button dispatch), which throws `ConnectionLostError` offline
with nothing queued. A later milestone must add an explicit
`offline.scheduleORM(model, method, args, kwargs, extras)` call from crm-owned JS for each of
these, gated on `isOffline()`, with optimistic UI:
- **B1/C6 — Won**: call `action_set_won` (not `action_set_won_rainbowman`/C8) with
  `[[record.resId]]`; no rainbowman effect offline (already SKIP per A12/A14/A16/C9).
- **B3/C4 — Restore**: `action_restore` with `[[record.resId]]`.
- **B8/B11/C7 — AI-probability switch**: `action_set_automated_probability` with
  `[[record.resId]]`. Lower priority than Won/Restore (see Notes #2 on whether this is worth
  building at all).
- **B19/C3 — kanban Delete**, **B20/C2 — color picker**, **B21 — kanban drag**,
  **B22/B53/B54 — priority stars** (pipeline kanban, Leads kanban, Opportunities list) and
  **B24/C1 — quick create** are *already* covered by the framework's own
  `web_unlink`/`web_save` producers (`record.js`, `dynamic_list.js`), so no new crm producer
  is needed there — listed here only to make clear which QUEUE rows do and do not need new
  crm code.
- Outside this milestone's Section C scope (mail.activity is not `crm.lead`/`stage`/`team`),
  architecture §3.3 also calls for new producers for `mail.activity` `create` (schedule),
  `action_done` (done), and a new `crm.lead.action_log_call` (log a call) — flagged here
  because they are the other half of "QUEUE rows needing a producer" even though the
  triggering controls (B17/B23, kanban_activity widget) are classified DISABLE in *this*
  inventory since no crm-owned offline UI exists for them yet (see Notes #3).

### 2. Debatable rows

- **A6/C20 — `get_team_switcher_data`**: chosen SKIP because `crm_search_model.js`'s own
  "Offline Mode" section already implements a graceful fallback (`switcherAvailable=false`,
  `switcherTeams=[]`, "All Teams") with no crash. The alternative is DISABLE, because an
  uncached miss with the background-refresh error unhandled could in principle abort the
  whole view load (the disk-cache rethrows the network error from the background refresh).
  SKIP wins because the code path that would need to catch that error already exists and is
  designed to degrade gracefully, matching the "probe that only toggles display" spirit of
  rule 2 (the switcher list only decorates/filters an already-loaded view; it does not gate
  the view's own load).
- **B8/B11/C7 — `action_set_automated_probability`**: chosen QUEUE because the rule is
  content-based (bare `[[id]]`, fully resolvable, no onchange/wizard/chained id) and the
  method is a plain recompute-and-write. The alternative is DISABLE, because the `<a>`
  elements are not matched by `SELECTORS_TO_DISABLE` (`button:...`) so they would need
  crm-added disabling work regardless of classification, and the control is low-value
  (an "undo my probability override" toggle). QUEUE wins on the letter of the rule; a
  reviewer preferring conservatism could downgrade this pair to DISABLE with no ripple
  effect elsewhere in this document.
- **B17/B23 — `kanban_activity` widget ("Mark Done" on an existing activity)**: chosen
  DISABLE because the control belongs to mail's `activity_list_popover`/`activity_model`
  JS, not crm's, and no crm-side offline handling exists for it yet. The alternative is
  QUEUE for the "Mark Done" half specifically (`mail.activity.action_done([[id]])` is a bare
  resolvable write), which is exactly what architecture §3.3's dedicated mobile activity
  panel is planned to replace this control with. Until that panel exists, DISABLE is the
  correct classification for the control as it stands today.
- **B28 — `mail_activity_mixin_list_reschedule_dropdown`**: chosen DISABLE because its date
  picker is not verified to resolve to a bare client value the way the kanban_activity
  "Mark Done" case does, and because it targets `mail.activity` reschedule methods with no
  offline UI designed. The alternative (QUEUE for `action_reschedule_today`, which needs no
  extra argument) is plausible but not pursued here; flagged for the next milestone.
- **B18 — kanban card `<a type="open">` ("Edit")**: chosen DISABLE because the framework
  does not gate this click on `isAvailableOffline` today (`o_disabled_offline` styling is
  applied but the card stays clickable per the web-framework research), so opening an
  uncached lead throws an unhandled `ConnectionLostError`. This is consistent with — and
  will be resolved by — architecture §3.2 item 10's planned uncached-lead helper; see
  Notes #3.
- **C5/C8 vs B1/B3/B4/B49**: `action_set_lost` (C5) and `action_set_won_rainbowman` (C8) are
  each DISABLE as *methods*, even though the *button* that is their nearest neighbour (B1
  for C8, and B4/B49 for the "Lost" family that C5 belongs to) is QUEUE (B1) or DISABLE
  (B4/B49). This is not a contradiction: Section B classifies what the **button control**
  should do offline (which may route to a *different*, more offline-friendly method than
  the one the button calls today), while Section C classifies whether **that specific
  method**, called with only an id, is itself a suitable QUEUE target. `action_set_lost`
  has no button of its own today (only the wizard's `action_lost_reason_apply` reaches it),
  so C5 stays DISABLE until/unless a future milestone adds a direct control for it.

### 3. Consistency with approved decisions in `architecture.md`

- **Won → QUEUE via `action_set_won`**: matches B1 (QUEUE) and C6 (QUEUE); C8
  (`action_set_won_rainbowman`, the method the button calls *today*) is DISABLE precisely
  because architecture wants the producer to bypass it — see Notes #1/#2.
- **Activity schedule/done/log-call → QUEUE**: these are `mail.activity`-level methods, out
  of this milestone's Section C scope (`crm.lead`/`stage`/`team` only). The *existing*
  crm-view controls that today reach mail.activity actions (B17, B23, kanban_activity
  widget) are DISABLE in this inventory only because no crm-owned offline UI exists for them
  yet — architecture §3.3 plans a **new** dedicated activity panel/control (with its own
  `data-available-offline` markers) that will carry the QUEUE behavior for schedule/done/log
  a call. This inventory does not contradict that plan; it documents the *current* controls,
  which are superseded by that future work.
- **Mark-lost/mass-convert/merge/PLS-update wizards, calendar event,
  forecast/graph/pivot/activity views, lead generation → DISABLE**: matches B4, B15, B16,
  B26, B49 (mark-lost family); B51 (mass-convert); B52 (merge); B46, B50 (PLS-update); B6
  (calendar/meeting); A24, B37, B38, B39, B48 (forecast/report/analysis views); A19-A23
  (lead generation, all of Section A's lead-generation-dropdown rows).
- **Rainbowman lookup, MRR group probe, team-switcher manager probe → SKIP**: matches A12,
  A14, A16, C9 (rainbowman); A7 (MRR group probe); A4 (team-switcher manager probe). A6/C20
  (`get_team_switcher_data`) is an additional SKIP in the same team-switcher family, decided
  as debatable in Notes #2 above but consistent with the same "probe that only
  decorates/filters an already-usable view" reasoning.
