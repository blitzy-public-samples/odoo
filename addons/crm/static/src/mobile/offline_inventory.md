# CRM offline surface inventory

Milestone 1 (inventory only — **no code changes** in this commit). This document sweeps
`addons/crm/` for every entry point that needs a live server, and classifies each one so a
later milestone can enforce it. HEAD at the time of the original sweep: `8916e416` (branch
`eval/factory-crm-offline`), committed as `a6a1ceef`. Every file:line citation below was
re-read at this commit; none is copied uncritically from the starting research reports
(`{missionDir}/research/crm_js_sweep.md`, `crm_python_views.md`, `design_options.md`) —
those reports seeded the search, but every row here was independently re-verified against
the files in this repo.

**This revision** closes 7 blocking gaps a scrutiny review found in `a6a1ceef` (missing
stage-column create/delete/resequence rows, two missing non-lead/stage/team editable
lists, a missing team-switcher selection row, a missing reachable `crm.team` method, a
missing tag-color-editor row, and a false claim about the team-switcher cache-miss
fallback), then runs a bounded completeness pass for the same categories of omission
across the rest of the addon. HEAD for this revision's re-verification is still `a6a1ceef`
(no crm source changed between the two sweeps). Every citation — old and new — was
re-read again at this HEAD with the scripted check in "Self-verification" below; the new
rows and corrected text are marked inline. No row number was reassigned: new rows are
appended to the end of each section's table (same convention the original sweep already
used for B53/B54), so every existing cross-reference in "Notes for review" still points at
the same row.

**This round-2 fix** closes 4 further scrutiny findings against `6e6de2b8` (the commit the
round-1 fix above landed as): two Section B controls the round-1 completeness pass missed
(the pipeline kanban's default-enabled column "Edit" menu, and the lead form's tag
quick-create, both on `crm_lead_views.xml`), and two inaccuracies in how B58/B59 and their
Notes #1 entries described the stage-resequence/-delete producers — those entries spelled
out `scheduleORM`/`webResequence` argument lists, kwargs, and a `specification` payload
that were each incomplete or wrong (a missing fifth `options`/`extras` argument on
`scheduleORM`, a missing `specification` kwarg on `webResequence`). This inventory
classifies entry points; it is not an implementation spec, so those recipes are removed in
favor of a method-level statement of what a future producer must queue, with the exact
argument list, kwargs, and options/extras left to milestone 2. The two new rows are B62 and
B63, appended per this document's existing convention (no row renumbered). HEAD for this
round's re-verification is `6e6de2b8` (no crm source changed by this fix either); every
citation — old and new — was re-read again at this HEAD.

**This round-3 fix** closes 3 further scrutiny findings against `cf127d42` (the commit the
round-2 fix above landed as), all in the same "relational-field create/edit" category: the
Leads/Opportunities multi-edit lists' tag color-edit and quick-create
(`crm_lead_views.xml:353,753`, both falsely excluded as unreachable), the Stages multi-edit
list's `team_ids` quick-create (`crm_stage_views.xml:26`, falsely called "display-only"),
and the PLS-update wizard's `pls_fields` quick-create (`wizard/crm_lead_pls_update_views.xml:12`,
same false "display-only" framing). Rather than patch these three in place, this fix adds a
new **Section B-REL** that exhaustively enumerates every many2one/many2many/many2many_tags/
one2many field occurrence in an editable context that can create or edit a related record,
generated with a throwaway script (`/tmp/rel_field_sweep.py`, not committed — its selection
logic is restated below so the enumeration is reproducible without the script itself). That
pass found 2 further occurrences beyond the three named findings (the Opportunities list's
`list_activity` widget, and the lead form's `partner_id` with `widget="res_partner_many2one"`)
and confirmed that one single framework mechanism — `Many2XAutocomplete.suggest()` adding its
"Create"/"Create and edit" suggestions only `if (!this.offlinePlugin.isOffline())`
(`addons/web/static/src/views/fields/relational_utils.js:450-454`) — already hides the
*typed-name* quick-create path for every many2one and many2many_tags field in this addon's
views offline, which the original "display-only" claims had not identified as the real
reason those two specific fields' create paths are already effectively covered; the tag
color-edit popover is a separate, uncovered mechanism (confirmed in Section B-REL's header).
HEAD for this round's re-verification is `cf127d42` (no crm source changed by this fix
either); every citation — old and new — was re-read again at this HEAD.

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
close the dialog client-side, no row needed. The lead's `tag_ids` many2many_tags field has
`options="{'on_tag_click': 'edit_color'}"` four more times besides the form occurrence (B55):
`views/crm_lead_views.xml:353` (Leads list), `:370` (Leads mobile kanban card), `:542`
(pipeline kanban card) and `:753` (Opportunities list). `many2many_tags_field.js`'s
`onTagClick()` (`addons/web`) opens the color popover only
`if (this.props.record.isInEdition)`; kanban records default to `mode: "readonly"`
(`dynamic_record_list.js`), so `:370` and `:542` (both kanban cards) are correctly excluded
regardless of anything else on the page. **Correction (round-3 fix):** `:353` and `:753`
are **not** excluded — both lists (`crm_case_tree_view_leads`/`crm_case_tree_view_oppor`)
are `multi_edit="1"` (`:320`, `:707`), and `list_renderer.js`'s `onCellClicked()` enters a
*selected* row into edit mode on a cell click even with no `editable=` attribute (confirmed
by reading `:1520-1557` at HEAD — the `multiEdit && record.selected` branch is checked
before the `editable=`-only branch), making `record.isInEdition` true for that row exactly
as it already is for the form; see Section B-REL's BR1-BR4 for the color-edit and
quick-create rows this adds, replacing the earlier "no-op" claim for these two occurrences.
The pipeline kanban's `group_create`/`group_delete`/
`group_edit` (B56/B57/B62) and resequence (B58) and the stage list's `widget="handle"`
resequence (B59) are likewise control-level additions; see their own rows for the exact
mechanism. The lead form's tag field (`:245`) also exposes a quick-create "Create" option
distinct from the four options above: only `no_create_edit` is set there, not `no_create`
or `no_quick_create`, so the field's autocomplete still offers to create a brand-new tag by
name — see B63, which is distinct from B55's color-edit popover on the same field.

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

  **Correction (this revision):** `crm.team.action_primary_channel_button` (`crm_team.py:783`)
  was previously listed here as excluded ("dead from crm's own UI today ... a `sales_team`
  dashboard control this addon does not customize"). That is wrong: this addon's own
  `crm_team_view_kanban_dashboard` (`views/crm_team_views.xml:259`,
  `inherit_id="sales_team.crm_team_view_kanban_dashboard"`) inherits the exact view whose
  kanban root carries `action="action_primary_channel_button" type="object"`
  (`addons/sales_team/views/crm_team_views.xml:132`); the inherited view only adds fields
  and a few `<xpath>` insertions, it never touches the kanban tag's `action`/`type`
  attributes, so clicking a team card on the inherited Teams dashboard reaches this crm
  override. It is reachable and gets its own row — C21.

**Sweep method, round 2 (gap-closing re-sweep, this revision)** — a scrutiny review found
7 blocking omissions in the sweep above; closing them exposed the same categories of
omission are not special-cased by the original Section A/B grep patterns, so a second,
targeted sweep was run across the same scope:
```
rg -n "editable=" addons/crm/views addons/crm/wizard addons/crm/report
rg -n "widget=\"handle\"" addons/crm/views addons/crm/wizard addons/crm/report
rg -n "group_create|group_delete|group_edit|archivable=" addons/crm/views addons/crm/wizard addons/crm/report
rg -n "many2many_tags" addons/crm/views addons/crm/wizard addons/crm/report
rg -n "on_tag_click" addons/crm/views
rg -n "default_group_by|groups_draggable" addons/crm/views
rg -n "kanban_color_picker" addons/crm/views
rg -n "onSelect|_updateSwitcherSelection|_notify\(|switchView|searchModel\." addons/crm/static/src --include=*.js
```
Findings beyond the 7 confirmed gaps: the pipeline kanban (`crm_lead_views.xml:503`) has no
`group_create`/`group_delete` attribute, so both default to enabled
(`kanban_arch_parser.js:18-19` in `addons/web`) — the column-level create/delete rows (B56,
B57) and the column-drag resequence (B58) all follow from that same `<kanban>` tag; the
stage list's `widget="handle"` (`crm_stage_views.xml:23`) adds a fourth row (B59). The
`editable="bottom"` sweep found exactly the two models named in the scrutiny findings
(`crm.recurring.plan`, `crm.lost.reason` — B60/B61) and no third; `crm.stage`'s own list
(B40) is `multi_edit="1"`, not `editable=`, and was already a row. The `many2many_tags`/
`on_tag_click` sweep found the lead's five occurrences discussed above (one new row, B55,
plus the four siblings, two of which — `:370`, `:542` — are confirmed-unreachable kanban
cards; see the round-3 fix's correction for `:353`/`:753` above and BR1-BR4) and two more
`many2many_tags` fields with no `on_tag_click` option at all: `crm_stage_views.xml:48`'s
form `team_ids` (`no_open`+`no_create` both set — genuinely display-only, no create and no
color-edit control) and, **(correction, round-3 fix)**, `crm_stage_views.xml:26`'s *list*
`team_ids` and `wizard/crm_lead_pls_update_views.xml:12`'s `pls_fields` — neither of these
two sets `no_create`/`no_quick_create`, so each still exposes a quick-create "Create"
suggestion in its autocomplete (hidden offline by the framework, see Section B-REL's header);
calling them "display-only" alongside `:48` was wrong — see BR5/BR6. One more
`on_tag_click="edit_color"` occurrence outside
`crm.lead`'s own views (`report/crm_activity_report_views.xml:39`, `tag_ids` "Lead Tags" on
a read-only report list row) — report-list rows are never `isInEdition` for the same reason
as the non-editable Leads/Opportunities lists above, so no new row. The `onSelect`/`_notify`
sweep found exactly
one unmatched handler, `team_switcher.js:56-60` (A26); `crm_search_model.js`'s own
`_notify()` calls (lines 163, 206, 228) are internal to the already-covered team-switcher
family and are not themselves separate network entry points. The forecast kanban
(`crm_lead_view_kanban_forecast`, `crm_lead_views.xml:565-600`) groups by `date_deadline`,
not a many2one field; `kanban_renderer.js`'s `canCreateGroup()` requires
`groupByField.type === "many2one"`, and `dynamic_group_list.js`'s `createGroup`/
`resequence` both throw synchronously for a non-many2one groupby — so this kanban never
renders group-level create/delete/resequence controls at all, and no new row applies there
(it keeps relying on A25's "add next period" `list.load()`, already DISABLE).

**Sweep method, round 3 (gap-closing re-sweep, round 2 fix)** — a second scrutiny round
found 4 blocking gaps in `6e6de2b8`: two missed Section B controls and two inaccurate
producer-recipe excerpts. The round-2 sweep's own
`group_create|group_delete|group_edit|archivable=` grep already matched `group_edit`
alongside `group_create`/`group_delete`, but the round-1 fix only drew a conclusion for the
latter two; re-reading the matched kanban tag's config menu
(`addons/web/static/src/views/view_components/group_config_menu.js`) shows it also
registers an `edit_group` item (`:87-98`) gated by `canEditGroup()` (`:80-84`), reachable
whenever `group_edit` is not overridden on the `<kanban>` tag (true here, same as
`group_delete`) — new row B62. Separately, re-reading `many2many_tags_field.js`'s
`extractProps` (`:356-365`) against the lead form's `tag_ids` options
(`crm_lead_views.xml:245`, only `no_create_edit: True`) shows
`canQuickCreate = canCreate && !noQuickCreate` evaluates true (`no_create`/`no_quick_create`
are both unset), so the field's autocomplete still offers a "Create" suggestion
(`relational_utils.js:483-515`) that calls `name_create` on `crm.tag` and links the
returned id (`many2many_tags_field.js:127-132`) — a distinct control from the color-edit
popover already covered by B55, missed in the earlier sweeps because the Section B grep
patterns match XML attributes/widgets, not a JS field's internally-computed prop — new row
B63. The B57/B58/B59 producer notes were checked against the actual framework call sites
again (`relational_model/utils.js:854-861`, `offline_plugin.js:271-279,447-449`,
`addons/web/models/models.py:540`) and rewritten below and in Notes #1 to name the model and
method a future producer must queue without restating the exact argument list.

**Sweep method, round 4 (relational-field create/edit sweep, this revision)** — a third
scrutiny round found 3 blocking gaps in `cf127d42`, all in the same category: a many2one/
many2many/many2many_tags/one2many field, in an editable context, that can create or edit a
related record through a mechanism this document had not swept for. Rather than patch the
3 named occurrences in place, a dedicated throwaway script,
`/tmp/rel_field_sweep.py` (not committed), was written to re-derive the whole category from
scratch; its selection logic, restated here so the result is reproducible without the
script itself:
1. Parse every `<record model="ir.ui.view">` in `addons/crm/views/*.xml`,
   `addons/crm/wizard/*.xml`, `addons/crm/report/*.xml` with `lxml.etree` (keeps
   `.sourceline`); read each record's `<field name="model">` (the arch's `res_model`) and
   the root tag of its `<field name="arch" type="xml">`.
2. Skip the whole record if that root tag is `kanban`/`search`/`graph`/`pivot`/`calendar`
   (per the task's exclusion), or descend into a `<templates>` (kanban card QWeb) without
   ever treating it as editable.
3. Track, at every `<list>`/`<form>` boundary, whether the container is an **editable
   context**: a `<form>` always is; a `<list>` is only if it has `editable="top"/"bottom"`
   **or** `multi_edit="1"` — the latter because `list_renderer.js`'s `onCellClicked()`
   (`:1520-1557`) puts a *selected* row into edit mode on a cell click with no `editable=`
   attribute at all (the exact mechanism the round-3 findings turned on); a `<list>` with
   neither is a display/open-only list and nothing inside it is independently editable.
4. For every `<field>` inside an editable container, resolve its Odoo field type from a
   `model, field → (ttype, relation)` map read once from `ir_model_fields` in the
   `crm_offline` database (`psql -d crm_offline -Atc "select model, name, ttype, relation
   from ir_model_fields where ttype in ('many2one','many2many','one2many') and model in
   (...)"`, for every `res_model` this sweep's records target) — keep only
   `many2one`/`many2many`/`one2many` (`many2many_tags` is a *widget*, not a type; the type
   is `many2many`). One2many/many2many fields with their own inline `<list>`/`<form>`
   sub-arch are recursed into with the model switched to the field's `relation`.
5. Exclude a field occurrence with a static `readonly="1"`/`readonly="True"`, or a static
   `invisible="1"`/`column_invisible="True"` (a field that is never rendered has no
   interactive capability at all) — dynamic expressions are not evaluated and are kept,
   same as the existing document's section-A/B readonly handling.
6. The script prints every surviving occurrence (file, line, model, container kind, field,
   ttype/relation, widget, options, create/domain attrs, inline-subarch flag) as a
   candidate list; it does not itself decide create/edit capability per widget — that
   requires reading each widget's own `extractProps`/component, done by hand below and
   cross-checked against `addons/web`'s field-registry source files at HEAD.

Run against this scope, the script found 52 candidate many2one/many2many/one2many
occurrences in an editable context. Of those, 44 are plain many2one/many2many(_tags) fields
with no non-default create/edit mechanism and fall under the blanket Many2XAutocomplete
coverage stated in Section B-REL's header (listed there, not repeated here); the remaining
8 are the three round-3 findings (6 rows, since the two list `tag_ids` occurrences each need
a separate color-edit row and quick-create row) plus 2 more the completeness pass surfaced
(the Opportunities list's `list_activity` widget, and the lead form's `partner_id` with
`widget="res_partner_many2one"`) — Section B-REL's BR1-BR8.

## Section A — JS/XML ORM, rpc, action-service and group/access-probe calls (`static/src/**`)

| # | File | Line | Call / control | Class | Justification |
|---|---|---|---|---|---|
| A1 | `static/src/activity_menu_patch.js` | 39 | `this.action.loadAction("crm.crm_lead_action_my_activities")` | DISABLE | Activity-menu CRM entry (contract: DISABLE); disk-cached action, but its search state (activity filters, `active in [true,false]`) is unlikely to be visited, and the promise has no `.catch`. |
| A2 | `static/src/activity_menu_patch.js` | 45 | `this.action.doAction(action, {...})` | DISABLE | Same activity-menu CRM entry path as A1. |
| A3 | `static/src/components/team_switcher/team_switcher.js` | 18 | `this.actionService = useService("action")` | SKIP | Service-handle acquisition only; no network I/O at this line (the call it enables is A5). |
| A4 | `static/src/components/team_switcher/team_switcher.js` | 21 | `await user.hasGroup("sales_team.group_sale_manager")` | SKIP | Team-switcher sales-manager probe (contract: SKIP); only toggles "Manage Teams" visibility. |
| A5 | `static/src/components/team_switcher/team_switcher.js` | 46 | `this.actionService.doAction("sales_team.crm_team_action_config")` | DISABLE | "Manage Teams" navigation (contract: DISABLE); manager-only admin area, its `DropdownItem` is not auto-disabled. |
| A6 | `static/src/views/crm_search_model.js` | 130-142 | `this.orm.cache({type:"disk",update:"always",callback}).call("crm.team","get_team_switcher_data")` | SKIP | Feeds the switcher list/domain; SKIP is the *target* disposition (a probe that only decorates/filters an already-loaded view), but **correction (this revision)**: today it does not degrade gracefully on a cache miss. `_initSwitcher()` (`crm_search_model.js:125-145`) `await`s this call with no `.catch`, and `load()` (`:42-47`) `await`s `_initSwitcher()` with no `.catch` either; `RPCCache.read()` (`addons/web/static/src/core/network/rpc_cache.js`) rejects its returned promise when there is no ram/disk value to fall back on, so an offline cache miss rejects `_initSwitcher()`, which rejects the whole `CrmSearchModel.load()` — aborting the view's load, not silently falling back to "All Teams". The file's "Offline Mode" section (`:210-250`) only re-exports/restores the team **facet** on an already-loaded search state (`applySearch`/`getCurrentSearch`); it has no bearing on this cache-miss path. Making this call actually skip silently on a miss (the behavior this row's SKIP classification assumes) is milestone-2 (`offline-fixes`) work, not yet done — see Notes #2. |
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
| A26 | `static/src/components/team_switcher/team_switcher.js` | 56-60 | `onSelect(teamId) { ... this.env.searchModel._updateSwitcherSelection(teamId); }` | DISABLE | **New row (this revision)**, missed by the original Section A grep (no `orm.`/`rpc(`/`doAction`/`hasGroup` token on these lines). Reached only through a `DropdownItem` inside the switcher's `Dropdown`, whose toggle is `<button class="o_cp_team_switcher">` (`team_switcher.xml:6`) with no `data-available-offline`; the framework's `SELECTORS_TO_DISABLE` (`button:not([data-available-offline]):not([disabled])`) disables that exact button offline — the same mechanism A5 relies on for "Manage Teams" — so the dropdown cannot be opened to reach this handler at all. Even if it were reached, `_updateSwitcherSelection` changes the search domain/context and calls `_notify()`, which drives the view controller to reload the kanban/list for the newly selected team; that reload may hit crm.lead/crm.stage data never visited offline for that team, so this is navigation to possibly-unavailable data, not a bare resolvable write — DISABLE per the catch-all rule, matching the scrutiny finding. |

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
| B55 | `views/crm_lead_views.xml` | 245 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color', ...}"/>` (lead form) | DISABLE | **New row (this revision)**. The form record is always `isInEdition` (an existing record being viewed in a non-readonly form), so clicking a tag opens `Many2ManyTagsFieldColorListPopover`; picking a color calls `many2many_tags_field.js`'s `switchTagColor()` → `tagRecord.update({[colorField]: colorIndex}); tagRecord.save();` — a direct write to `crm.tag`, not `crm.lead`/`crm.stage`/`crm.team`, so DISABLE. Two of the four other `on_tag_click="edit_color"` occurrences in this file (`:370`, `:542`) are kanban cards, always `mode: "readonly"`, and stay unreachable (see "Excluded from Section B" above); the other two (`:353`, `:753`, both `multi_edit="1"` lists) are reachable through row selection and get their own rows — see Section B-REL's BR1/BR3 (**correction, round-3 fix**: the original document wrongly excluded these two as well). |
| B56 | `views/crm_lead_views.xml` | 503 | Pipeline kanban "Add a column..." (stage-column create; `group_create` not set on this `<kanban>`, defaults to enabled per `kanban_arch_parser.js:18`) | DISABLE | **New row (this revision)**. Submitting the column-create input calls `dynamic_group_list.js`'s `createGroup(groupName)` → `_createGroup()`, which does `orm.call("crm.stage", "name_create", [groupName])` and then uses the **returned id** to set `default_<field>` context on the new group's config and to resequence the new column after the last one — an id produced by this very call, so DISABLE per the chained-id rule, never QUEUE, regardless of `crm.stage` being otherwise QUEUE-eligible. |
| B57 | `views/crm_lead_views.xml` | 503 | Pipeline kanban column config-menu "Delete" (stage-column delete; `group_delete` not set, defaults to enabled per `kanban_arch_parser.js:19`) | QUEUE | **New row (this revision)**. Calls `dynamic_group_list.js`'s `deleteGroups([group])` → `_deleteGroups()` → `_unlinkGroups()`, which issues a plain `orm.unlink("crm.stage", [stageId])` — a bare write with a client-known id on `crm.stage` (a QUEUE-eligible model), so QUEUE by rule 1; this matches what the scrutiny review flagged as the correct target. It is **not** one of the framework's own auto-queued producers (`web_save`/`web_unlink`/`action_archive`/`action_unarchive`): `_unlinkGroups()` has no `ConnectionLostError` catch, so today the click throws uncaught offline instead of queueing — it needs a new crm-side `scheduleORM` producer like the other rows in Notes #1, which now also lists it. |
| B58 | `views/crm_lead_views.xml` | 503 | Pipeline kanban stage-column drag (resequencing stage columns themselves, not cards; `groups_draggable` not overridden, defaults to enabled for a many2one groupby) | QUEUE | **New row (this revision)**. Dropping a dragged column calls `dynamic_group_list.js`'s `resequence(movedGroupId, targetGroupId)` → `_resequence()` → the shared `resequence()` util (`relational_model/utils.js:794-866`), which calls `orm.webResequence` on `crm.stage` — **not** `web_save`, unlike what B21's card-drag and B40's generic "any stage edit" wording might suggest. `webResequence` has no queue producer either (the util's only `catch` rolls the UI order back and rethrows). Every argument that call needs — the moved ids, the sequence field name, the offset, and the per-field `specification` the Python method requires (`addons/web/models/models.py:540`) — is resolvable purely from client-known state, so the full argument list stays client-resolvable and this is QUEUE by rule 1 regardless; it needs a new producer — see Notes #1 for the method-level statement (the exact call, including that `specification` kwarg and the `scheduleORM` options/extras, is implementation work for milestone 2). Distinct from B21 (per-record `web_save({stage_id})` when a *card* is dropped into a different column, already auto-queued). |
| B59 | `views/crm_stage_views.xml` | 23 | `<field name="sequence" widget="handle"/>` (Stages list drag-to-reorder) | QUEUE | **New row (this revision)**. Dragging a row by its handle calls the list's `_resequence()` → the same `resequence()` util as B58 → the same `orm.webResequence` call on `crm.stage` — the exact call B40's "any stage edit → `web_save`" wording does not cover. Same client-resolvable-argument reasoning as B58 applies (bare ids, offset, and a client-known `specification`), so QUEUE by rule 1; needs its own crm-side producer, same gap as B57/B58 — see Notes #1. |
| B60 | `views/crm_recurring_plan_views.xml` | 8-9 | `<list editable="bottom">` + `<field name="sequence" widget="handle"/>` (crm.recurring.plan: inline create/edit/resequence) | DISABLE | **New row (this revision)**. An editable-list row's inline edit/create would auto-queue via the framework's `web_save` producer like any form, and the handle's resequence would go through the same `webResequence` path as B58/B59 — but the model is `crm.recurring.plan`, not `crm.lead`/`crm.stage`/`crm.team` or a lead's `mail.activity`, so rule 1 does not apply at all regardless of mechanism — DISABLE. |
| B61 | `views/crm_lost_reason_views.xml` | 49 | `<list string="Channel" editable="bottom">` (crm.lost.reason: inline create/edit) | DISABLE | **New row (this revision)**. Same reasoning as B60: inline edits on an editable list would auto-queue via `web_save`, but `crm.lost.reason` is outside rule 1's model scope — DISABLE. |
| B62 | `views/crm_lead_views.xml` | 503 | Pipeline kanban column config-menu "Edit" (stage-column edit; `group_edit` not set on this `<kanban>`, defaults to enabled per `kanban_arch_parser.js:20`) | DISABLE | **New row (round 2 fix)**. The same column config menu that renders Delete (B57) also renders an "Edit" item (`group_config_menu.js`'s `edit_group` entry, `:87-98`, gated by `canEditGroup()`, `:80-84`); choosing it calls `editGroup()` (`:61-72`), which opens a `FormViewDialog` on the clicked stage's own id (`resModel: groupByField.relation`, i.e. `crm.stage`) and, on save, calls `this.props.list.load()` to reload the kanban. The dialog loads that specific `crm.stage` record outside the view-level `actionId`/`viewType` tracking `OfflinePlugin.isAvailableOffline` keys offline availability on, so opening the dialog for a stage never visited offline throws `ConnectionLostError` — the same uncached-record-navigation reasoning as B18's kanban-card "Edit" menu item, plus a second round-trip on save. Not a bare resolvable write: DISABLE per the navigation-unavailable-offline rule, distinct from B57 (Delete, QUEUE) and B40 (direct form/list field edits, QUEUE). |
| B63 | `views/crm_lead_views.xml` | 245 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color', 'no_create_edit': True}"/>` (lead form, tag quick-create) | DISABLE | **New row (round 2 fix)**. Only `no_create_edit` is set on this field, not `no_create` or `no_quick_create`; `many2many_tags_field.js`'s `extractProps` therefore computes `canQuickCreate = canCreate && !noQuickCreate` as true, so typing an unmatched tag name in the autocomplete offers a "Create" suggestion (`relational_utils.js:483-515`) whose handler calls `this.orm.call("crm.tag", "name_create", [name], ...)` and immediately links the **returned id** to the lead (`many2many_tags_field.js:127-132`) — an id produced by this very call, so DISABLE per the chained-id rule, same family as B25/B56. Distinct from B55, which classifies the color-edit popover on this same field (an existing tag's `write`, not a `name_create`). **Addendum (round-3 fix):** this "Create" suggestion is itself already hidden offline by the framework before a user could ever select it — `Many2XAutocomplete.suggest()` only adds the create/create-and-edit/search-more suggestions `if (!this.offlinePlugin.isOffline())` (`relational_utils.js:450-454`), and `many2many_tags_field.xml:23` wires this field's `quickCreate` into that same `Many2XAutocomplete`; see Section B-REL's header for the full blanket-coverage statement this row is one instance of. The row is kept (as it already was) for completeness and defense in depth, not because the control is reachable offline today. |

## Section B-REL — relational-field create/edit controls

Closes the "relational-field create/edit" omission category identified by round-3 scrutiny:
every many2one/many2many/many2many_tags/one2many field occurrence (found by the sweep
documented above) in an editable context that lets the user create or edit a record on a
*different* model than the view's own `res_model`, through a mechanism distinct from the
host record's own Save. **Selecting an existing related record (no create) is not listed
here**: picking an existing record for the field only stages a value that is written when
the host record itself is saved — that save is already a Section A/B/C row (the generic
form/list-save producer, or the model's specific QUEUE/DISABLE row) and is not a separate
entry point.

**Blanket coverage — read before the rows below.** Every many2one field in this addon's
views (plain `many2one`, and the `many2one_avatar_user`/`many2one_avatar_leader_user`/
`rotting`/`badges_many2one`-style wrappers that extend it — confirmed by reading
`many2one_avatar_user_field.js:15`, `many2one_avatar_leader_user.js:9`, `rotting_widget.js:44`,
each `extends`/wraps `Many2One`) and every many2many_tags field's typed-name quick-create
(`many2many_tags_field.xml:23` wires its `quickCreate` into the same `<Many2XAutocomplete>`)
go through one single component, `Many2XAutocomplete` (`addons/web/static/src/views/fields/
relational_utils.js`). Its `suggest()` method only pushes the create/create-and-edit/
search-more suggestions onto the dropdown `if (!this.offlinePlugin.isOffline())`
(`:450-454`); offline, the "Create ..."/"Create and edit..." entries never appear at all, so
nobody can trigger `name_create`/`slowCreate` through this path while offline, for **any**
many2one or many2many_tags field in this addon — regardless of whether the field sets
`no_create`/`no_quick_create`/`no_create_edit`. This is a single framework mechanism, not a
per-field one, so it is stated once here rather than repeated on every row; rows below are
only for occurrences where creating or editing a related record happens through a
**different** mechanism this blanket rule does **not** reach (confirmed per-widget by
reading its source, not assumed): a many2many_tags color-edit popover (`onTagClick`'s
`edit_color` branch, which never touches `Many2XAutocomplete`), a one2many widget with its
own inline control (`list_activity`'s `ActivityButton`), or an `otherSources` entry injected
alongside the base autocomplete (`res_partner_many2one`'s external partner lookup, added via
`props.otherSources`, outside `suggest()`'s gate — see BR8). Quick-create rows below (BR2,
BR4-BR6, and the already-existing B63) are kept anyway, for completeness and consistency
with how this document already keeps framework-covered QUEUE rows (Notes #1's B19/B20/B21
bullet) — not because the control is reachable offline today.

| # | File | Line | Field + widget/options | Class | Justification |
|---|---|---|---|---|---|
| BR1 | `views/crm_lead_views.xml` | 353 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>` (Leads list, color-edit) | DISABLE | **New row.** Resolves round-3 scrutiny finding #1 (part A). `crm_case_tree_view_leads` is `multi_edit="1"` (`:320`); `list_renderer.js`'s `onCellClicked()` (`:1520-1557`) checks `multiEdit && record.selected` before the `editable=`-only branch, and on a match calls `this.props.list.enterEditMode(record)` (`:1552`) — selecting the row, then clicking a cell, puts that record in `mode: "edit"`, so `record.isInEdition` (`record.js:148-154`) becomes true for the same reason B55's form occurrence always is. `many2many_tags_field.js`'s `onTagClick()` (`:169`) only early-returns `if (!this.props.record.isInEdition)`; once true, clicking an existing tag opens the color popover, and `switchTagColor()` (`:256-262`) writes `crm.tag` directly — same mechanism and DISABLE reasoning as B55, reached through row selection instead of a form. **Not** covered by the blanket Many2XAutocomplete rule above: the color popover never goes through that component. |
| BR2 | `views/crm_lead_views.xml` | 353 | same field, quick-create | DISABLE | **New row.** Resolves round-3 scrutiny finding #1 (part B). Once the row is in edit mode (BR1), the field's own autocomplete is also live; this occurrence sets no `no_create`/`no_quick_create`/`no_create_edit`, so (same `extractProps` formula as B63) `canQuickCreate` is true and typing an unmatched name offers "Create" → `name_create` on `crm.tag`, consuming the returned id — chained-id DISABLE, same family as B63. **Is** covered by the blanket Many2XAutocomplete rule above: the "Create" suggestion itself never renders offline. Row kept for completeness, same as B63. |
| BR3 | `views/crm_lead_views.xml` | 753 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>` (Opportunities list, color-edit) | DISABLE | **New row.** Same control and reasoning as BR1, second occurrence: `crm_case_tree_view_oppor` is also `multi_edit="1"` (`:707`). |
| BR4 | `views/crm_lead_views.xml` | 753 | same field, quick-create | DISABLE | **New row.** Same control and reasoning as BR2, second occurrence; covered by the blanket rule. |
| BR5 | `views/crm_stage_views.xml` | 26 | `<field name="team_ids" widget="many2many_tags"/>` (Stages multi-edit list, quick-create) | DISABLE | **New row.** Resolves round-3 scrutiny finding #2. `crm_stage_tree` is `multi_edit="1"` (`:22`); `team_ids` here carries no `no_create`/`no_quick_create`/`no_create_edit` option at all — unlike the stage *form*'s own `team_ids` (`:48`, `no_open`+`no_create` both set, genuinely has no create path; the earlier "both display-only" framing wrongly conflated the two). Once a row is selected and a cell clicked (same mechanism as BR1), typing an unmatched team name offers "Create" → `crm.team.name_create`, consuming the returned id — chained-id DISABLE, same family as B56/B63. No `on_tag_click` option is set here, so there is no paired color-edit control. Covered by the blanket Many2XAutocomplete rule; row kept for completeness, correcting the original "display-only" claim. |
| BR6 | `wizard/crm_lead_pls_update_views.xml` | 12 | `<field name="pls_fields" widget="many2many_tags" options="{'color_field': 'color'}"/>` (PLS-update wizard, quick-create) | DISABLE | **New row.** Resolves round-3 scrutiny finding #3. `pls_fields` sets only `color_field`, no `no_create`/`no_quick_create`, no `on_tag_click`; the wizard's own form is always an editable context, so typing an unmatched value offers "Create" → `name_create` on `crm.lead.scoring.frequency.field`, consuming the returned id — chained-id DISABLE, same family as BR2/BR5/B63, regardless of whether a read-only ACL would reject the create server-side (an ACL rejection does not make the request disappear). Covered by the blanket Many2XAutocomplete rule, **and** doubly unreachable today because the wizard's own opening button (`res_config_settings_views.xml:47-49`, B46) and "Update" footer button (B50) are both already DISABLE with no `data-available-offline`. Row kept for completeness, correcting the original "display-only" claim. |
| BR7 | `views/crm_lead_views.xml` | 735 | `<field name="activity_ids" optional="hide" widget="list_activity"/>` (Opportunities list) | DISABLE | **New row** (completeness pass, not a named round-3 finding). `list_activity.js` (`addons/mail`) renders the same `ActivityButton` component (`@mail/core/web/activity_button`) as the `kanban_activity` widget already classified DISABLE at B17/B23 — confirmed by reading both widget registrations (`kanban_activity.js:1,9`; `list_activity.js:1,9`). One2many (`activity_ids` → `mail.activity`) inline-create control (the popover's "Schedule" action); reachable here on a direct click, independent of the list's own edit mode (unlike BR1-BR5). Same DISABLE reasoning as B17/B23: "Schedule" opens the transient `mail.activity.schedule` wizard; "Mark Done" on an existing activity is bare-id resolvable but has no crm-owned offline handling yet (debatable, same family as B17/B23 — see Notes #2). |
| BR8 | `views/crm_lead_views.xml` | 167, 187 | `<field name="partner_id" widget="res_partner_many2one" .../>` (lead form; `:167` for `type == 'lead'`, `:187` for `type == 'opportunity'`, one always rendered) | DISABLE | **New row** (completeness pass). `PartnerAutoCompleteMany2one` (`partner_autocomplete_many2one.js`) wraps the standard `Many2One`/`Many2XAutocomplete` — its base "Create"/"Create and edit" suggestion is covered by the blanket rule above — **and additionally** injects an `otherSources` entry (`:67-91`) that queries the external IAP partner-autocomplete service directly; selecting a suggestion calls `onSelectPartnerAutocompleteOption()` (`:97-114`), which opens a prefilled *new* `res.partner` form via `openRecord({context})` (not a bare `name_create`, but still DISABLE under the same reasoning as B2/B25 — creates/matches a partner, needs an explicit follow-up Save; architecture.md §3.3's "Contact lookup" bullet makes the same call for this exact field — "no create option offline (web already hides it — prove it)"). `otherSources` bypasses `suggest()` entirely (`relational_utils.js:307`: `[this.optionsSource, ...this.props.otherSources]`), so it is **not** covered by the blanket rule; whether the external lookup's own network call fails gracefully offline (silently empty, or an uncaught rejection) is **not verified here** — this is a document-only milestone with no browser QA — meaning this row is exactly the "prove it" architecture.md asks for, only partially proven: the base Many2XAutocomplete half is proven (confirmed covered by the blanket rule), the `otherSources` half is not. |

**Excluded from B-REL** (occurrences the sweep script found in an editable context, with no
individual row because they fall under the blanket rule above, have no create/edit path at
all, or are unreachable through a different gate):
- Covered by the blanket Many2XAutocomplete rule (plain many2one/many2many fields, no
  distinct widget-level mechanism, no row needed beyond the header statement): lead-form
  `lost_reason_id` (`:234`), `user_id`/`many2one_avatar_leader_user` (`:237-238`), `state_id`
  (`:264`, `no_open` only), `campaign_id` (`:281`), `medium_id` (`:282`), `source_id`
  (`:283`); Leads-list `company_id` (`:337`), `state_id` (`:339`), `user_id` (`:343-344`),
  `team_id` (`:345`), `campaign_id` (`:347`), `medium_id` (`:349`), `source_id` (`:350`);
  Opportunities-list `partner_id` (`:722`), `company_id` (`:726`), `state_id` (`:728`),
  `user_id` (`:731-732`), `team_id` (`:733`), `activity_user_id` (`:736`), `campaign_id` (`:738`),
  `medium_id` (`:739`), `source_id` (`:740`), `recurring_plan` (`:748`), `stage_id`/`rotting`
  (`:749`, `no_open` only), `lost_reason_id` (`:752`); merge-wizard `user_id` (`:11`) and
  `team_id` (`:15`) (both unreachable anyway — see below). Two of these fields are only
  create-capable in a *list*, not the *form*, for the same field: `team_id` has
  `no_create: True` on the lead form (`:293`) but no such option on either multi-edit list
  (`:345`, `:733`); `recurring_plan` has `no_create`+`no_open` on the form (`:81`, `:119`,
  `:445`) but neither on the Opportunities list (`:748`). This form/list asymmetry is a
  genuine inconsistency worth a reviewer's attention for milestone 2 but does not change
  either occurrence's classification (both still DISABLE, both still covered by the blanket
  rule) — flagged in Notes #6, not given extra rows here.
- No create path at all (option(s) fully suppress it; excluded without a row, not merely
  folded into the blanket statement): lead-form `recurring_plan` (`:81`, `:119`, `:445`,
  `no_create`+`no_open`), `country_id` (`:266`, `no_create`+`no_open`), `lang_id` (`:269`,
  `no_quick_create`+`no_create_edit` both set — equivalent to no create path at all),
  `company_id` (`:289`, `no_create`), `team_id` (`:293`, `no_create`); Leads/Opportunities
  lists' `country_id` (`:340`, `:729`, `no_create`+`no_open`); stage form `team_ids` (`:48`,
  `no_open`+`no_create`, genuinely display-only); `crm.lead.lost`'s `lost_reason_id`
  (`:9`, `widget="badges_many2one"`, whose own component hard-codes
  `activeActions: { create: false }` in `badges_many2one_field.js:53-59`, regardless of any
  XML option); `crm_lead_to_opportunity_mass`'s `user_ids` (`:22`, `no_create`) and `team_id`
  (`:23`, `no_create`); `crm_lead_to_opportunity_mass`'s `duplicated_lead_ids` (`:36`, its
  inline `<list create="false">` disables creation outright). Form field `stage_id`
  (`:18-21`, same occurrence as B5, `widget="rotting_statusbar_duration"`) is a pure
  status-bar/selection widget (`rotting_statusbar.js:8`'s `RottingStatusBarDurationField`
  extends `StatusBarDurationField` (`statusbar_duration_field.js:6`), which extends
  `StatusBarField`, not `Many2OneField`) — it offers no autocomplete and no create path at
  all, unlike the Opportunities list's `stage_id`
  (`:749`, plain `widget="rotting"`, which does extend `Many2OneField` and is in the
  blanket-coverage list above).
- Unreachable because the field's own host wizard is already DISABLE at the entry point
  (its opening button/menu item lacks `data-available-offline`, so the framework disables
  it offline before the wizard can even open): `crm.merge.opportunity`'s `user_id`/`team_id`/
  `opportunity_ids` (opened only via B52, DISABLE) and `crm.lead2opportunity.partner.mass`'s
  `user_ids`/`team_id`/`duplicated_lead_ids`/`lead_tomerge_ids` (opened only via B15, DISABLE)
  — each is additionally covered by one of the two bullets above regardless, so this is a
  second, independent reason none of them gets a row.
- `wizard/crm_lead_lost_views.xml`'s `lead_ids` (`:8`) is `invisible="1"` (context-only,
  never rendered) — excluded by the script's invisible filter, no row needed.

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
| C20 | `models/crm_team.py` | 794 | `get_team_switcher_data()` | SKIP | Reachable via the JS call (A6); SKIP is the target disposition, but **correction (this revision)**: today an offline cache miss rejects the whole search-model load rather than falling back to "All Teams" — see A6's corrected justification and Notes #2. |
| C21 | `models/crm_team.py` | 783 | `action_primary_channel_button()` | DISABLE | **New row (this revision)**. Previously excluded as "dead from crm's own UI"; that was wrong — this addon's `crm_team_view_kanban_dashboard` (`views/crm_team_views.xml:259`) inherits `sales_team.crm_team_view_kanban_dashboard`, whose kanban root carries `action="action_primary_channel_button" type="object"` (`addons/sales_team/views/crm_team_views.xml:132`); the inherited view's `<xpath>` edits never touch that attribute, so clicking a team card on the Teams dashboard reaches this crm override. It returns `self.action_open_opportunities()` when `use_opportunities` (otherwise `super()`'s own navigation) — a read-only navigation action, same reasoning as C18/C19 — DISABLE. |

## Counts

### Overall

| Classification | Count |
|---|---|
| QUEUE | 28 |
| SKIP | 12 |
| DISABLE | 78 |
| **Total** | **118** |

### Per section

| Section | Rows | QUEUE | SKIP | DISABLE |
|---|---|---|---|---|
| A — JS/XML calls | 26 | 3 (A9, A13, A15) | 10 (A3, A4, A6, A7, A8, A12, A14, A16, A17, A18) | 13 (A1, A2, A5, A10, A11, A19, A20, A21, A22, A23, A24, A25, A26) |
| B — view/wizard/report buttons and controls | 63 | 16 (B1, B3, B5, B8, B11, B19, B20, B21, B22, B24, B40, B53, B54, B57, B58, B59) | 0 | 47 (B2, B4, B6, B7, B9, B10, B12-B18, B23, B25-B39, B41-B52, B55, B56, B60, B61, B62, B63) |
| B-REL — relational-field create/edit controls | 8 | 0 | 0 | 8 (BR1-BR8) |
| C — public model methods reachable from a button | 21 | 9 (C1, C2, C3, C4, C6, C7, C14, C15, C16) | 2 (C9, C20) | 10 (C5, C8, C10, C11, C12, C13, C17, C18, C19, C21) |
| **Total** | **118** | **28** | **12** | **78** |

(9 rows added in the round-1 fix: A26; B55-B61; C21. 2 more rows added in the round-2 fix:
B62, B63. 8 more rows added in this round-3 fix: BR1-BR8, the new B-REL subsection. Counts
above are the recomputed totals, not a delta.)

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
- **B57 — stage-column delete**: needs a CRM-side producer queuing `crm.stage` `unlink` via
  `OfflinePlugin.scheduleORM`, called from the kanban header's delete handler (`addons/web`'s
  `deleteGroup`), gated on `isOffline()`; the id is already known client-side (it is the
  group's own value), so no onchange/wizard is involved. Exact args, kwargs, and
  options/extras (including `timeStamp`) are defined at implementation in milestone 2.
- **B58/B59 — stage resequencing**: both the pipeline's column drag and the Stages list's
  handle widget need a CRM-side producer queuing `crm.stage` `web_resequence` via
  `OfflinePlugin.scheduleORM`, gated on `isOffline()`, with the same UI-rollback-on-reject
  behavior the online `resequence()` util already has when offline the call doesn't
  actually fail. Exact args, kwargs (including the per-field `specification` the Python
  method requires) and options/extras (including `timeStamp`) are defined at implementation
  in milestone 2. Two call sites, one producer.
- B56 (stage-column create via `name_create`) stays DISABLE regardless of a producer: the
  chained id defeats rule 1 outright, so no amount of crm-side `scheduleORM` wiring would
  make it QUEUE-eligible; it is listed in the DISABLE counts, not here.

### 2. Debatable rows

- **A6/C20 — `get_team_switcher_data`** — **corrected this revision**: the previous version
  of this row claimed `crm_search_model.js`'s "Offline Mode" section already implements a
  graceful fallback to "All Teams" with no crash on a cache miss. That claim was false:
  rereading `_initSwitcher()` (`:125-145`) shows it `await`s
  `this.orm.cache({type:"disk",...}).call("crm.team","get_team_switcher_data")` with **no
  `.catch`**, and `load()` (`:42-47`) `await`s `_initSwitcher()` with **no `.catch`**
  either; `RPCCache.read()` (`addons/web/static/src/core/network/rpc_cache.js`) rejects its
  returned promise when there is no cached value to serve, so an uncached offline miss
  rejects `_initSwitcher()` and therefore the whole `CrmSearchModel.load()` — aborting the
  view's load entirely, not falling back to "All Teams". The "Offline Mode" section
  (`:210-250`, `applySearch`/`getCurrentSearch`) only restores/exports the team **facet** on
  an already-loaded search state; it never runs during `_initSwitcher()`. SKIP is kept as
  the row's classification because the call's *nature* is still a decorative/advisory probe
  (rule 2's "probe that only toggles display" — the switcher list filters an already-usable
  view, it is not supposed to gate the view's own load); the fix is **milestone-2
  (`offline-fixes`) work**: add an explicit `.catch` in `_initSwitcher()` so a miss degrades
  to `{available:false, teams:[]}` instead of rejecting, which is what would make the
  current SKIP classification actually true in practice. Until that fix lands, note that
  today's behavior does not match the SKIP contract ("not issued offline, raises nothing");
  this is a known, tracked gap, not a silent omission.
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
- **B18/B62 — kanban card/column "Edit"**: both chosen DISABLE because the framework does
  not gate the click on `isAvailableOffline` today — B18's card-edit link stays clickable
  offline (`o_disabled_offline` styling applied but no actual disabling) and B62's
  column-edit menu item opens a `FormViewDialog` whose own load is outside the view-level
  visited-tracking this framework keys offline availability on — so opening either an
  uncached lead (B18) or an uncached stage (B62) throws an unhandled `ConnectionLostError`.
  This is consistent with — and will be resolved by — architecture §3.2 item 10's planned
  uncached-record helper; see Notes #3.
- **B57/B58/B59 — stage delete/resequence**: chosen QUEUE on the same content-based reading
  as B8/B11/C7 above (bare ids, no onchange/wizard/chained id, on `crm.stage`), matching
  what the scrutiny review flagged as the correct target. The conservative alternative is
  DISABLE for the same reason B8/B11 could be downgraded: none of `orm.unlink`/
  `orm.webResequence` is one of the framework's four auto-queued producers, so today the
  click just throws uncaught offline instead of either queueing or being disabled — a
  reviewer who wants QUEUE reserved for calls the framework *already* auto-queues could
  downgrade all three to DISABLE with no ripple effect (same crm-side work either way: a
  new producer for QUEUE, or three new `data-available-offline`-less disablings for
  DISABLE).
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
- **Writes on non-`crm.lead`/`crm.stage`/`crm.team` models → DISABLE**: matches the two
  rows added this revision for editable lists on other models, B60 (`crm.recurring.plan`)
  and B61 (`crm.lost.reason`), and B55 (writes `crm.tag`, not a lead/stage/team field) —
  consistent with how every other out-of-scope-model row in this document (B45-B47 on
  `res.config.settings`, B42 on `res.partner`, B43/B44 on `utm.campaign`) is already
  DISABLE regardless of how simple the write would otherwise be.
- **Chained id → DISABLE, never QUEUE**: matches B56 (stage-column create via `name_create`,
  same family as B25's partner `name_create` and A25's share-target `name_create`) and B63
  (lead-form tag quick-create via `crm.tag.name_create`, same family), applying the
  chained-id rule exactly as it already does elsewhere in this document.
- **Navigation to data that may be unavailable offline → DISABLE**: A26 (team-switcher
  selection reload) joins A5 (Manage Teams) and the B30-B39/C17-C19 team-navigation family
  under this same reasoning; C21 (`action_primary_channel_button`) joins C18/C19 as a third
  read-only `crm.team` navigation method; B62 (column-menu "Edit") joins B18 as a second
  uncached-record-navigation control, see Notes #2.

### 4. Scrutiny round and bounded completeness pass (this revision)

A scrutiny review of the `a6a1ceef` commit found 7 blocking gaps, all confirmed against
source and closed above: A26 (team-switcher selection), B55 (lead tag-color editor), B56/
B57/B58 (pipeline stage-column create/delete/resequence), B59 (stage-list handle
resequence), B60/B61 (recurring-plan/lost-reason editable lists), C21
(`action_primary_channel_button`, with the "excluded" bullet in Section C's header removed),
and the corrected A6/C20 justification (no code change; the false "graceful fallback" claim
is replaced with the actual uncaught-rejection behavior, and the fix is flagged as
milestone-2 work). The bounded completeness pass for the same categories (editable lists,
handle/resequence widgets, kanban group-level controls, many2many_tags color/edit options,
component-level reload/selection handlers) across the rest of `addons/crm` found no further
rows beyond those 9: the four other `on_tag_click="edit_color"` occurrences and the two
plain `many2many_tags` (no color-click) fields are confirmed unreachable or non-actionable
(see "Excluded from Section B" and "Sweep method, round 2" above); the forecast kanban's
date-groupby never exposes group-level controls at all (same section); no other view in
`addons/crm` has an `editable=`, `widget="handle"`, or non-default `group_create`/
`group_delete`/`group_edit`/`archivable` attribute (confirmed by the round-2 `rg` commands
above matching only the rows already added); no other component under `static/src` has an
`onSelect`/`_notify`-style reload handler (confirmed by the same sweep).
**Correction (round 2 fix):** that last claim about `group_edit` was incomplete — the
round-2 `rg` command for `group_create|group_delete|group_edit|archivable=` did match
`group_edit`'s absence on the same `<kanban>` tag as `group_create`/`group_delete`, but no
row was drawn from it at the time; see Notes #5 and B62 below.

### 5. Scrutiny round 2 (round 2 fix)

A second scrutiny round against `6e6de2b8` found 4 blocking gaps: two same-category
Section B controls the round-1 completeness pass still missed, and two inaccuracies in how
B58/B59 and their Notes #1 entries described producer work. Closed above: B62 (pipeline
kanban column config-menu "Edit", the same `group_edit` default this document's own
round-2 grep had already matched but not acted on) and B63 (the lead form's tag
quick-create via `crm.tag.name_create`, distinct from B55's color-edit popover on the same
field). B58/B59's call descriptions and their Notes #1 entries no longer spell out an exact
`scheduleORM`/`webResequence` argument list, kwargs, or `specification` payload — this
document classifies entry points, not implementation call recipes, so those rows and notes
now name the producer at the method level only (what model/method a future
`OfflinePlugin.scheduleORM` call must queue), while still stating, as the QUEUE
classification requires, that the full argument list — including `web_resequence`'s
`specification` kwarg — is resolvable purely from client-known state. No other row in this
document stated an executable `scheduleORM` call with a full options/extras argument, so no
further row needed the same correction.

### 6. Scrutiny round 3 and the relational-field create/edit sweep (this revision)

A third scrutiny round against `cf127d42` found 3 blocking gaps, all in one previously
unswept category — a many2one/many2many/many2many_tags/one2many field, in an editable
context, whose create/edit mechanism is distinct from the host record's own form/list save:
the Leads/Opportunities multi-edit lists' `tag_ids` color-edit + quick-create
(`crm_lead_views.xml:353,753`), the Stages multi-edit list's `team_ids` quick-create
(`crm_stage_views.xml:26`), and the PLS-update wizard's `pls_fields` quick-create
(`wizard/crm_lead_pls_update_views.xml:12`) — all three previously dismissed as
unreachable/display-only, corrected above (see the "Excluded from Section B" and round-2
"Sweep method" corrections) and resolved as BR1, BR2+BR4 (BR3 is the second `tag_ids`
occurrence), BR5, and BR6. Rather than patch those three in place, the whole category was
re-derived from scratch with a dedicated throwaway script (`/tmp/rel_field_sweep.py`, not
committed; its selection logic is restated in "Sweep method, round 4" above so the result
is reproducible without the script) and organized as the new Section B-REL, rather than
folded into Section B, because its rows share a selection method and a classification
rule (chained-id DISABLE, or the Many2XAutocomplete blanket offline-hiding noted in the new
section's header) distinct from Section B's button-click-driven rows.

The script surfaced 2 further occurrences beyond the three named findings, both resolved as
DISABLE and debatable only on how much weight to give a mechanism this document cannot
exercise in a browser (document-only milestone, no QA performed here):
- **BR7 — Opportunities list's `list_activity` widget**: DISABLE is consistent with the
  already-settled B17/B23 (`kanban_activity`, same underlying `ActivityButton` component)
  rather than a new judgment call; listed here only because it is a *new* occurrence of an
  *already-debated* control (see Notes #2's B17/B23 entry), not a new debate.
- **BR8 — lead form's `partner_id` with `widget="res_partner_many2one"`**: DISABLE because
  creating/matching a partner through the external IAP lookup still ends at `openRecord` on
  a new/matched `res.partner` (same reasoning as B2/B25, and the exact "no create option
  offline" question architecture.md itself flags as needing proof, not an assumption). What
  is **not** verified here, and is explicitly out of scope for a document-only inventory: whether
  `partnerAutocomplete.autocomplete()`'s own network call (an IAP RPC, not an ORM call
  through `orm.call`) fails silently or throws uncaught when offline — `otherSources` is not
  reached through `Many2XAutocomplete.suggest()`'s offline gate (`relational_utils.js:450-454`,
  stated in Section B-REL's header), so this control's offline behavior rests entirely on
  how that one network call degrades, which milestone 2's browser QA should confirm one way
  or the other.

Two further asymmetries the sweep surfaced are flagged, not rowed, because they do not
change any classification: `team_id`'s `no_create` is set on the lead form
(`crm_lead_views.xml:293`) but not on either Leads/Opportunities multi-edit list
(`:345`, `:733`), and `recurring_plan`'s `no_create`+`no_open` are set on the lead form
(`:81`, `:119`, `:445`) but not on the Opportunities list (`:748`) — in both cases the list
occurrence is still DISABLE today only because it is covered by the Many2XAutocomplete
blanket rule, not because of a matching `no_create` option, so a future milestone that ever
needs to re-enable list quick-create for either field first needs the matching option added
for parity with the form (see "Excluded from Section B-REL" above).
