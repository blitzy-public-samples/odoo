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
argument list, kwargs, and options/extras left to milestone 2. **Superseded (milestone-2
user review, VAL-INV-011):** no such producer was ever written or scheduled — B57/B58/B59
were reclassified **DISABLE** (Notes #9): the framework has no queue producer for
`orm.unlink`/`webResequence` on a group, so crm adds no new producer at all, there, and none
is planned. "Left to milestone 2" describes a plan milestone 2 did not take; kept only as
sweep history, not as an open item. The two new rows are B62 and
B63, appended per this document's existing convention (no row renumbered). HEAD for this
round's re-verification is `6e6de2b8` (no crm source changed by this fix either); every
citation — old and new — was re-read again at this HEAD.

**This round-3 fix** closes 3 further scrutiny findings against `cf127d42` (the commit the
round-2 fix above landed as), all in the same "relational-field create/edit" category: the
Leads/Opportunities multi-edit lists' tag color-edit and quick-create
(`crm_lead_views.xml:354,754`, both falsely excluded as unreachable), the Stages multi-edit
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
and cross-checked file by file so files with zero hits are confirmed empty, not skipped. A
bare `useService("orm")`/`useService("action")` assignment that only acquires a service
handle, with no call on that line, is excluded here and gets no row of its own
(user-testing fix): acquiring a handle issues no server call by itself, only the calls
later made *through* it do, and each of those already has its own row below.

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
  `views/fill_temporal_service.js` (pure date arithmetic), `webclient/share_target/
  crm_share_target_item.xml`, `components/breadcrumbs/crm_breadcrumbs.xml`,
  `components/team_switcher/team_switcher.xml` (markup only, no calls of its own),
  `components/lead_generation_dropdown/lead_generation_dropdown.xml` (markup only),
  `views/crm_form/crm_pls_tooltip_button.xml` (markup only), `views/crm_kanban/
  crm_column_progress.xml` (markup only), `views/forecast_kanban/
  forecast_kanban_renderer.xml` (markup only).

**Correction (round-4 fix):** `forecast_kanban_model.js` was wrongly in the zero-match list
above — "only calls `super.*`" was true literally but wrong in substance, since the
`super.*` it calls is `RelationalModel._webReadGroup`, a real server read-group call. Moved
to its own row, A27, below.

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
(`views/crm_lead_views.xml:243,245`, desktop and touch header layouts) and one inside the
quick-create form (`:441`); unlike the kanban/list occurrences (B22, B53, B54), a form field
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
`views/crm_lead_views.xml:354` (Leads list), `:371` (Leads mobile kanban card), `:543`
(pipeline kanban card) and `:754` (Opportunities list). `many2many_tags_field.js`'s
`onTagClick()` (`addons/web`) opens the color popover only
`if (this.props.record.isInEdition)`; kanban records default to `mode: "readonly"`
(`dynamic_record_list.js`), so `:371` and `:543` (both kanban cards) are correctly excluded
regardless of anything else on the page. **Correction (round-3 fix):** `:354` and `:754`
are **not** excluded — both lists (`crm_case_tree_view_leads`/`crm_case_tree_view_oppor`)
are `multi_edit="1"` (`:321`, `:708`), and `list_renderer.js`'s `onCellClicked()` enters a
*selected* row into edit mode on a cell click even with no `editable=` attribute (confirmed
by reading `:1520-1557` at HEAD — the `multiEdit && record.selected` branch is checked
before the `editable=`-only branch), making `record.isInEdition` true for that row exactly
as it already is for the form; see Section B-REL's BR1-BR4 for the color-edit and
quick-create rows this adds, replacing the earlier "no-op" claim for these two occurrences.
The pipeline kanban's `group_create`/`group_delete`/
`group_edit` (B56/B57/B62) and resequence (B58) and the stage list's `widget="handle"`
resequence (B59) are likewise control-level additions; see their own rows for the exact
mechanism. The lead form's tag field (`:246`) also exposes a quick-create "Create" option
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
- `crm.lead`: `search_fetch` (ORM override, not a button target),
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

  **Correction (round-4 fix):** `action_unarchive` and `copy_data` were also wrongly listed
  here. `action_unarchive` is not "only called internally": `DynamicList`'s `_toggleArchive`
  (used by `getStaticActionMenuItems()`'s "Unarchive" item, **B69**) calls
  `orm.call("crm.lead", "action_unarchive", [selectedIds])` directly from the selected-record
  Action menu — it now gets its own row, **C22**. `copy_data` is not called by a Duplicate
  "context-menu action [that] is not an in-scope crm view control" — the Action-menu
  "Duplicate" item (**B66**) *is* an in-scope crm view control (it is rendered on the lead
  form/lists/kanbans by `getActiveActions()`'s `duplicate: true` default) and calls
  `record.duplicate()`/`list.root.duplicateRecords()` → `orm.call("crm.lead", "copy", [ids])`,
  which calls `copy_data` server-side — it now gets its own row, **C23**.

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
Findings beyond the 7 confirmed gaps: the pipeline kanban (`crm_lead_views.xml:504`) has no
`group_create`/`group_delete` attribute, so both default to enabled
(`kanban_arch_parser.js:18-19` in `addons/web`) — the column-level create/delete rows (B56,
B57) and the column-drag resequence (B58) all follow from that same `<kanban>` tag; the
stage list's `widget="handle"` (`crm_stage_views.xml:23`) adds a fourth row (B59). The
`editable="bottom"` sweep found exactly the two models named in the scrutiny findings
(`crm.recurring.plan`, `crm.lost.reason` — B60/B61) and no third; `crm.stage`'s own list
(B40) is `multi_edit="1"`, not `editable=`, and was already a row. The `many2many_tags`/
`on_tag_click` sweep found the lead's five occurrences discussed above (one new row, B55,
plus the four siblings, two of which — `:371`, `:543` — are confirmed-unreachable kanban
cards; see the round-3 fix's correction for `:354`/`:754` above and BR1-BR4) and two more
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
(`crm_lead_view_kanban_forecast`, `crm_lead_views.xml:566-601`) groups by `date_deadline`,
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
(`crm_lead_views.xml:246`, only `no_create_edit: True`) shows
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
**Superseded (milestone-2 user review, VAL-INV-011):** no such future producer was written
or scheduled for B57/B58/B59 — all three were reclassified **DISABLE** (see their current
rows and Notes #9): the framework has no queue producer for group-level `unlink`/
`webResequence`, so crm adds no new producer and none is planned. This paragraph is kept as
sweep history only.

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
occurrences in an editable context.

**Correction (round-4 fix): the "52 candidates partition into 44 blanket-covered + 8 BR
rows" claim this paragraph originally made is not a valid exhaustive accounting, for four
independent reasons the round-4 relational-create-family review identified, and is removed
rather than replaced with a new precise split:**
1. **Rows and field occurrences are not the same unit, and the original split conflated
   them inconsistently.** BR1/BR2 are two *controls* (color-edit, quick-create) on the
   *same* field occurrence (`tag_ids:353`), and BR3/BR4 the same for `tag_ids:753` — four
   rows, two occurrences. BR8 is the reverse: *one* row covering *two* separately defined
   `partner_id` fields (`:167` and `:187`, mutually exclusive by `invisible` condition) —
   one row, two occurrences. The 8 BR rows that existed before this fix are 7 field
   occurrences, not 8, and the "44" bucket undercounts by the same kind of error in the
   other direction.
2. **The "44 blanket-covered" bucket wrongly recounted occurrences that already have their
   own, non-blanket row elsewhere in this document**: the lead form's `tag_ids` (`:246`,
   already B55/B63), the quick-create `partner_id` (`:409`, already B25), and the stage
   form's `team_ids` (`:48`, already excluded with a reason, not "blanket-covered" — it has
   no create path at all, a different bucket entirely per the sweep's own step 5/6 logic).
3. **The merge wizard's `opportunity_ids` (`:19-32`) was in the 52 at all**, despite being a
   one2many whose own inline `<list>` has no `editable=`/`multi_edit` and whose Add-a-line
   control (now **B85**) does not go through `Many2XAutocomplete` — it should never have
   been counted toward a Many2XAutocomplete-coverage partition in the first place.
4. **The denominator itself (52) is incomplete**: the parser only walked `addons/crm/`'s own
   `<record>`s, so it never descended into the inherited CRM team form's retained
   `member_ids`/`crm_team_member_ids` fields (now **BR12**) — occurrences that exist in a
   view this addon customizes (`sales_team_form_view_in_crm`) but whose *base* arch content
   lives in `addons/sales_team`.

The authoritative, reconciled count of relational-field create/edit **rows** (not raw field
occurrences, which the above shows is the wrong unit to partition by) is Section B-REL's
own row count — **BR1-BR12**, independently verified against the Counts tables above (12
rows, all DISABLE). No attempt is made here to also restate a corrected raw-occurrence
denominator for the 52 candidates: doing so would repeat the same category error (rows vs.
occurrences) this correction is removing, and the task's actual completeness requirement is
about control rows, not about reproducing the throwaway script's own internal tally.

## Section A — JS/XML ORM, rpc, action-service and group/access-probe calls (`static/src/**`)

| # | File | Line | Call / control | Class | Justification |
|---|---|---|---|---|---|
| A1 | `static/src/activity_menu_patch.js` | 39 | `this.action.loadAction("crm.crm_lead_action_my_activities")` | DISABLE | Activity-menu CRM entry (contract: DISABLE); disk-cached action, but its search state (activity filters, `active in [true,false]`) is unlikely to be visited, and the promise has no `.catch`. |
| A2 | `static/src/activity_menu_patch.js` | 45 | `this.action.doAction(action, {...})` | DISABLE | Same activity-menu CRM entry path as A1. |
| A4 | `static/src/components/team_switcher/team_switcher.js` | 21 | `await user.hasGroup("sales_team.group_sale_manager")` | SKIP | Team-switcher sales-manager probe (contract: SKIP); only toggles "Manage Teams" visibility. |
| A5 | `static/src/components/team_switcher/team_switcher.js` | 46 | `this.actionService.doAction("sales_team.crm_team_action_config")` | DISABLE | "Manage Teams" navigation (contract: DISABLE); manager-only admin area, its `DropdownItem` is not auto-disabled. |
| A6 | `static/src/views/crm_search_model.js` | 130-142 | `this.orm.cache({type:"disk",update:"always",callback}).call("crm.team","get_team_switcher_data")` | SKIP | Feeds the switcher list/domain; SKIP is the *target* disposition (a probe that only decorates/filters an already-loaded view), but **correction (this revision)**: today it does not degrade gracefully on a cache miss. `_initSwitcher()` (`crm_search_model.js:125-145`) `await`s this call with no `.catch`, and `load()` (`:42-47`) `await`s `_initSwitcher()` with no `.catch` either; `RPCCache.read()` (`addons/web/static/src/core/network/rpc_cache.js`) rejects its returned promise when there is no ram/disk value to fall back on, so an offline cache miss rejects `_initSwitcher()`, which rejects the whole `CrmSearchModel.load()` — aborting the view's load, not silently falling back to "All Teams". The file's "Offline Mode" section (`:210-250`) only re-exports/restores the team **facet** on an already-loaded search state (`applySearch`/`getCurrentSearch`); it has no bearing on this cache-miss path. Making this call actually skip silently on a miss (the behavior this row's SKIP classification assumes) is milestone-2 (`offline-fixes`) work, not yet done — see Notes #2. |
| A7 | `static/src/views/crm_kanban/crm_column_progress.js` | 14 | `await user.hasGroup("crm.group_use_recurring_revenues")` | SKIP | Recurring-revenue (MRR) group probe (contract: SKIP); only toggles the MRR aggregate line. |
| A9 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 45 | `await this.props.record.save()` | QUEUE | Framework's `web_save` producer (`record.js` `_offlineSave`); queues any pending changes before the tooltip computation, same generic mechanism as any form save. |
| A10 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 51 | `await this.orm.call("crm.lead","prepare_pls_tooltip_data",[this.props.record.resId])` | DISABLE | PLS tooltip lookup (contract: DISABLE). |
| A11 | `static/src/views/crm_form/crm_pls_tooltip_button.js` | 57 | `await this.props.record.load()` | DISABLE | Refresh tied to the same disabled PLS-tooltip flow (reloads the server-recomputed probability); not merely decorative, so it does not qualify for SKIP, and it is unreachable once the control is disabled per A10/B9/B10. |
| A12 | `static/src/views/check_rainbowman_message.js` | 2 | `await orm.call("crm.lead","get_rainbowman_message",[[recordId]])` | SKIP | Post-save rainbowman lookup (contract: SKIP, known defect 1). |
| A13 | `static/src/views/crm_form/crm_form.js` | 49 | `const res = await super._save(...arguments)` | QUEUE | Framework's `orm.webSave("crm.lead",...)` producer, reached from the form Save button, statusbar stage click, or breadcrumb leave. |
| A14 | `static/src/views/crm_form/crm_form.js` | 51 | `await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId)` | SKIP | Rainbowman lookup call site (defect 1) after a stage-changing form save. |
| A15 | `static/src/views/crm_kanban/crm_kanban_model.js` | 25 | `await super.moveRecords(...arguments)` | QUEUE | Framework's per-record `web_save({stage_id})` producer for a kanban drag; also the only kanban "mark-won" path (dropping into an `is_won` stage). |
| A16 | `static/src/views/crm_kanban/crm_kanban_model.js` | 29 | `await checkRainbowmanMessage(this.model.orm, this.model.effect, movedLeads[0].resId)` | SKIP | Rainbowman lookup call site (defect 1) after a kanban stage drop. |
| A19 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 137-143 | `await this.orm.cache().searchRead("ir.module.module",[["name","in",moduleNames]],["id","name","shortdesc"])` | DISABLE | Lead generation (contract: DISABLE); module-install lookup, and the Generate button already lacks `data-available-offline`. |
| A20 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 165 | `await user.checkAccessRight(model,"create")` | DISABLE | Lead generation (contract: DISABLE); access probe gating install/access-request UI (dead code today: no `dropdownContentElements` entry sets `model`). |
| A21 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 206 | `await this.orm.silent.call("ir.module.module","button_immediate_install",[id])` | DISABLE | Lead generation, module install (contract: DISABLE). |
| A22 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 241 | `this.action.doAction({type:"ir.actions.client",tag:"import",...})` | DISABLE | Lead generation, CSV/Excel import client action (contract: DISABLE). |
| A23 | `static/src/components/lead_generation_dropdown/lead_generation_dropdown.js` | 257 | `this.action.doAction({type:"ir.actions.act_window",res_model:"base.module.install.request",...})` | DISABLE | Lead generation, transient access-request wizard (contract: DISABLE). |
| A24 | `static/src/views/forecast_kanban/forecast_kanban_renderer.js` | 48 | `await this.props.list.load()` | DISABLE | Forecast kanban "add next period" column (contract: forecast views DISABLE); the new `fill_temporal` read-group context is never cached. |
| A25 | `static/src/webclient/share_target/crm_share_target_item.js` | 18-22 | `this.state.teams = await this.orm.webSearchRead("crm.team", this.teamsDomain, {...}).then(...)` | DISABLE | PWA share-target team lookup; the whole share-to-lead flow needs a server-produced id from `name_create` on `res.partner` before an `ir.attachment` write — a chained id, DISABLE per the chained-id rule. |
| A26 | `static/src/components/team_switcher/team_switcher.js` | 56-60 | `onSelect(teamId) { ... this.env.searchModel._updateSwitcherSelection(teamId); }` | DISABLE | **New row (this revision)**, missed by the original Section A grep (no `orm.`/`rpc(`/`doAction`/`hasGroup` token on these lines). Reached only through a `DropdownItem` inside the switcher's `Dropdown`, whose toggle is `<button class="o_cp_team_switcher">` (`team_switcher.xml:6`) with no `data-available-offline`; the framework's `SELECTORS_TO_DISABLE` (`button:not([data-available-offline]):not([disabled])`) disables that exact button offline — the same mechanism A5 relies on for "Manage Teams" — so the dropdown cannot be opened to reach this handler at all. Even if it were reached, `_updateSwitcherSelection` changes the search domain/context and calls `_notify()`, which drives the view controller to reload the kanban/list for the newly selected team; that reload may hit crm.lead/crm.stage data never visited offline for that team, so this is navigation to possibly-unavailable data, not a bare resolvable write — DISABLE per the catch-all rule, matching the scrutiny finding. |
| A27 | `static/src/views/forecast_kanban/forecast_kanban_model.js` | 12-31 | `async _webReadGroup(config) { ...fillTemporalPeriod(config)-derived context/domain...; return super._webReadGroup(...arguments); }` (same override pattern in `_loadGroupedList`, `:33-41`) | DISABLE | **New row (round-4 fix).** Resolves round-4 scrutiny finding on the forecast read-group override. Corrects the "Excluded from Section A" entry above: `super._webReadGroup` is web's `RelationalModel._webReadGroup` (`addons/web/static/src/model/relational_model/relational_model.js:1003-1010`), which issues `orm.webReadGroup` with this override's forecast-specific `fill_temporal` context/domain — a server-computed, date-grouped read that is never cached offline, the same reasoning A24 already uses for the "add next period" reload on the same view. DISABLE, forecast-views family (A24, B37-B39, B48). |

## Section B — view, wizard and report buttons/controls with a server side effect

| # | File | Line | Call / control | Class | Justification |
|---|---|---|---|---|---|
| B1 | `views/crm_lead_views.xml` | 9-11 | Form header button `action_set_won_rainbowman` ("Won"), type=object | QUEUE | Bare `[[id]]` write path to `action_set_won` server-side; a CRM producer must call `action_set_won` directly (not this `_rainbowman` wrapper) per architecture — see Notes #1. |
| B2 | `views/crm_lead_views.xml` | 12-13 | Form header button `action_convert_to_opportunity`, type=object | DISABLE | Creates/matches a `res.partner` server-side and the UI expects a reload; not a bare resolvable write. |
| B3 | `views/crm_lead_views.xml` | 14-16 | Form header button `action_restore`, type=object | QUEUE | Bare `[[id]]` write (`action_unarchive` + probability reset); needs a CRM-side producer — see Notes #1. |
| B4 | `views/crm_lead_views.xml` | 17-18 | Form header button `%(crm.crm_lead_lost_action)d` ("Lost"), type=action | DISABLE | Opens the transient `crm.lead.lost` wizard (contract: mark-lost wizard DISABLE). |
| B5 | `views/crm_lead_views.xml` | 19-22 | `<field name="stage_id" widget="rotting_statusbar_duration">` (clickable statusbar) | QUEUE | Framework `web_save({stage_id})` producer on form save. |
| B6 | `views/crm_lead_views.xml` | 34-42 | Stat button `action_schedule_meeting` | DISABLE | Calendar-event scheduling (contract: DISABLE); returns a calendar action built server-side. |
| B7 | `views/crm_lead_views.xml` | 43-51 | Stat button `action_show_potential_duplicates` | DISABLE | Navigation to a server-computed duplicate-lead action; read-only, not resolvable client-side. |
| B8 | `views/crm_lead_views.xml` | 90-91 | `<a type="object" name="action_set_automated_probability">` (AI switch, desktop layout) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Notes #2's QUEUE/DISABLE debate is resolved against QUEUE: predictive scoring is out of scope and the probability only recomputes on the server, so no optimistic UI is possible (user review decision, architecture.md §3.7). The `<a>` is not auto-disabled by the framework (`SELECTORS_TO_DISABLE` matches only `<button>`), so crm must disable this control itself. |
| B9 | `views/crm_lead_views.xml` | 100 | `<widget name="pls_tooltip_button">` (desktop layout) | DISABLE | PLS tooltip control (contract: DISABLE). |
| B10 | `views/crm_lead_views.xml` | 132 | `<widget name="pls_tooltip_button">` (touch/mobile layout) | DISABLE | Same PLS tooltip control, second occurrence. |
| B11 | `views/crm_lead_views.xml` | 139-140 | `<a type="object" name="action_set_automated_probability">` (touch/mobile layout) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Same control as B8, second occurrence, resolved the same way: no optimistic UI is possible for a server-only probability recompute (user review decision, architecture.md §3.7); the `<a>` needs crm's own disabling since the framework only auto-disables `<button>`s. |
| B12 | `views/crm_lead_views.xml` | 213-216 | Button `mail_action_blacklist_remove` | DISABLE | Opens the transient `mail.blacklist.remove` wizard. |
| B13 | `views/crm_lead_views.xml` | 226-229 | Button `phone_action_blacklist_remove` | DISABLE | Opens the transient `phone.blacklist.remove` wizard. |
| B14 | `views/crm_lead_views.xml` | 301 | `<chatter reload_on_post="True"/>` | DISABLE | Chatter write controls (contract: DISABLE); mail's post/log/attachments/followers/schedule all need the server and are not crm-owned. |
| B15 | `views/crm_lead_views.xml` | 324 | List header button `%(action_crm_send_mass_convert)d` ("Convert to Opportunities") | DISABLE | Mass-convert transient wizard (contract: DISABLE). |
| B16 | `views/crm_lead_views.xml` | 325 | List header button `%(crm.crm_lead_lost_action)d` ("Mark Lost") | DISABLE | Mark-lost wizard (contract: DISABLE). |
| B17 | `views/crm_lead_views.xml` | 375 | `<field name="activity_ids" widget="kanban_activity"/>` (Leads mobile kanban card footer) | DISABLE | Opens mail's `ActivityButton` popover: "Schedule" opens the transient `mail.activity.schedule` wizard; "Done" calls `mail.activity.action_feedback([[id]], {feedback, attachment_ids})` (`activity_model_patch.js:50-54`, **round-4 correction**: not a bare `action_done` as previously written) and would be bare-id resolvable but is mail's control with no crm-side offline handling designed yet — debatable, see Notes #2. The popover's "Edit" and "Done & Schedule Next" sub-controls get their own rows, **B86**/**B87** (round-4 fix). |
| B18 | `views/crm_lead_views.xml` | 518 | `<a role="menuitem" type="open">` (kanban card menu "Edit") | DISABLE | **Corrected (m2-fix-view-guards).** Previously read: "today the framework does not gate this click on `isAvailableOffline`, so an uncached lead throws `ConnectionLostError` silently" — stale, and never the whole story. This item compiles to `KanbanRecord.triggerAction({type:'open'})` → `openRecord(record)`, the same guarded function the card body uses: `CrmKanbanController.openRecord`'s uncached-lead check (VAL-UNCACHED-001/-003) already renders `OfflineActionHelper` instead of throwing for a fresh open. But a card menu opened online and still open when the connection drops bypasses the toggler-disable pass entirely — `DropdownItem`s are `<span>`/`<a>`, never `<button>` — so a handler-level guard is also needed for that case. `kanban_record_offline_patch.js`'s `triggerAction` patch (scoped to `crm.lead`/`crm.team`) now blocks this item's handler directly, covering both the fresh-open and already-open cases. DISABLE either way. |
| B19 | `views/crm_lead_views.xml` | 519 | `<a role="menuitem" type="delete">` (kanban card menu "Delete") | DISABLE | **Reclassified to DISABLE (milestone-2 user review); corrected (m2-fix-view-guards).** This control's primary entry point is the card menu toggler (`addons/web/static/src/views/kanban/kanban_record.xml:26`, `<button class="btn btn-light o-no-caret px-2">`), a `<button>` with no `data-available-offline` that the framework's `SELECTORS_TO_DISABLE` already disables offline; crm does not add the attribute to it, so a *fresh* open of the menu — and "Delete" inside it — is unreachable offline, by click, keyboard or hotkey. **The previous text stopped there and overstated it as "cannot be opened at all offline": a menu already open before the connection drops bypasses the toggler-disable pass entirely, since "Delete" is a `DropdownItem` (`<span>`/`<a role="menuitem">`), never a `<button>`.** Clicking it directly reaches `triggerAction({type:'delete'})` → `deleteRecord(record)`, which the framework does not gate, so without a handler-level guard confirming it would queue `web_unlink` offline. `kanban_record_offline_patch.js`'s `triggerAction` patch (scoped to `crm.lead`/`crm.team`) now blocks this item's handler directly, closing that gap too. The framework's own `web_unlink` producer stays unused by this specific control; lead delete stays available offline through the Action-menu path instead (**B67**, QUEUE). |
| B20 | `views/crm_lead_views.xml` | 521 | `<field name="color" widget="kanban_color_picker"/>` (kanban card menu) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Same reasoning as B19: reached only through the same disabled card-menu toggler (`kanban_record.xml:26`), so the color picker inside the menu cannot be opened offline either. The framework's own `web_save({color})` producer stays unused by this specific control. |
| B21 | `views/crm_lead_views.xml` | 504 | Drag-and-drop between stage columns (pipeline kanban, `crm_case_kanban_view_leads`) | QUEUE | Framework per-record `web_save({stage_id})` producer (same mechanism as A15); also the kanban's only mark-won path (drop into an `is_won` stage). |
| B22 | `views/crm_lead_views.xml` | 547 | `<field name="priority" widget="priority"/>` (pipeline kanban card) | QUEUE | Framework `web_save({priority})` producer. |
| B23 | `views/crm_lead_views.xml` | 548 | `<field name="activity_ids" widget="kanban_activity"/>` (pipeline kanban card footer) | DISABLE | Same control as B17, second occurrence (pipeline kanban instead of Leads kanban). |
| B24 | `views/crm_lead_views.xml` | 504 | `on_create="quick_create" quick_create_view="crm.quick_create_opportunity_form"` (pipeline kanban) | QUEUE | New-record quick create → framework `web_save([], vals)` create producer; the crm quick-create form has no onchange dependency for its editable fields. **Note (milestone-2 user review):** the per-column "+" quick-add button that triggers this (`addons/web/static/src/views/kanban/kanban_header.xml:21`, `<button class="o_kanban_quick_add" ...>`) is itself a `<button>` with no `data-available-offline`, so the framework's `SELECTORS_TO_DISABLE` already disables it offline; crm does not add the attribute. This QUEUE row documents what *would* be queued if the button were enabled, but today it is framework-disabled offline — the control-panel New button is the offline entry point instead (accepted, no crm change). See B65 for the same note on the forecast kanban's quick-add. |
| B25 | `views/crm_lead_views.xml` | 409 | `<field name="partner_id">` "Create" option inside `crm.quick_create_opportunity_form` | DISABLE | Creating a new `res.partner` from the quick create needs a server-produced id — chained-id rule; picking an already-cached partner still falls under B24's QUEUE path. |
| B26 | `views/crm_lead_views.xml` | 711 | Opportunities list header button `%(crm.crm_lead_lost_action)d` ("Mark Lost") | DISABLE | Mark-lost wizard (contract: DISABLE). |
| B27 | `views/crm_lead_views.xml` | 712 | Opportunities list header button `%(crm.action_lead_mass_mail)d` ("Email") | DISABLE | Transient `mail.compose.message` mass-mail wizard. |
| B28 | `views/crm_lead_views.xml` | 760 | `<widget name="mail_activity_mixin_list_reschedule_dropdown"/>` (Opportunities list) | DISABLE | Calls `mail.activity` reschedule methods with a date-picker UI not designed for offline; debatable, see Notes #2. |
| B29 | `views/crm_lead_views.xml` | 761 | Opportunities list row button `%(crm.action_lead_mail_compose)d` ("Email") | DISABLE | Transient `mail.compose.message` wizard. |
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
| B40 | `views/crm_stage_views.xml` | 22 | `crm_stage_tree` multi-edit list cell edits (`multi_edit="1"`, no `editable`) | DISABLE | **Reclassified (milestone-2 list-cell-edit-disable fix, user decision).** List cell edits on this `multi_edit="1"` list go through `addons/web`'s `DynamicList._multiSave`, which the offline framework does not queue (user decision during milestone 2); offline, the record is edited from its form instead, whose save queues `web_save` (see **B92**, split out of this row for the form's own field edits). **This row no longer covers `crm_stage_form` field edits** (`:37`): that control reaches `write` through the generic form `web_save` producer, unaffected by `_multiSave`'s gap, so it keeps its own classification in the new row **B92** rather than sharing this one — a row needs exactly one class. |
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
| B53 | `views/crm_lead_views.xml` | 374 | `<field name="priority" widget="priority"/>` (Leads mobile kanban card footer) | QUEUE | Framework `web_save({priority})` producer, same mechanism as B22, second kanban view (Leads instead of pipeline). |
| B54 | `views/crm_lead_views.xml` | 735 | `<field name="priority" optional="hide" widget="priority"/>` (Opportunities list column) | QUEUE | Framework `web_save({priority})` producer; list-view click-to-save widget, same mechanism as B22/B53, third occurrence. |
| B55 | `views/crm_lead_views.xml` | 246 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color', ...}"/>` (lead form) | DISABLE | **New row (this revision)**. The form record is always `isInEdition` (an existing record being viewed in a non-readonly form), so clicking a tag opens `Many2ManyTagsFieldColorListPopover`; picking a color calls `many2many_tags_field.js`'s `switchTagColor()` → `tagRecord.update({[colorField]: colorIndex}); tagRecord.save();` — a direct write to `crm.tag`, not `crm.lead`/`crm.stage`/`crm.team`, so DISABLE. Two of the four other `on_tag_click="edit_color"` occurrences in this file (`:371`, `:543`) are kanban cards, always `mode: "readonly"`, and stay unreachable (see "Excluded from Section B" above); the other two (`:354`, `:754`, both `multi_edit="1"` lists) are reachable through row selection and get their own rows — see Section B-REL's BR1/BR3 (**correction, round-3 fix**: the original document wrongly excluded these two as well). |
| B56 | `views/crm_lead_views.xml` | 504 | Pipeline kanban "Add a column..." (stage-column create; `group_create` not set on this `<kanban>`, defaults to enabled per `kanban_arch_parser.js:18`) | DISABLE | **New row (this revision)**. Submitting the column-create input calls `dynamic_group_list.js`'s `createGroup(groupName)` → `_createGroup()`, which does `orm.call("crm.stage", "name_create", [groupName])` and then uses the **returned id** to set `default_<field>` context on the new group's config and to resequence the new column after the last one — an id produced by this very call, so DISABLE per the chained-id rule, never QUEUE, regardless of `crm.stage` being otherwise QUEUE-eligible. |
| B57 | `views/crm_lead_views.xml` | 504 | Pipeline kanban column config-menu "Delete" (stage-column delete; `group_delete` not set, defaults to enabled per `kanban_arch_parser.js:19`) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Calls `dynamic_group_list.js`'s `deleteGroups([group])` → `_deleteGroups()` → `_unlinkGroups()` → a plain `orm.unlink("crm.stage", [stageId])`, but `_unlinkGroups()` is **not** one of the framework's four auto-queued producers (`web_save`/`web_unlink`/`action_archive`/`action_unarchive`) and has no `ConnectionLostError` catch. Per the user's milestone-1 review and the mission's principle (architecture.md §3.7, mission AGENTS.md): "when the framework does not queue something (`orm.unlink` on a group, `webResequence`, ...), CRM does NOT add a queue hook; it disables the control offline" and the gap is listed in the PR's known limits. Disabled offline instead of queued. |
| B58 | `views/crm_lead_views.xml` | 504 | Pipeline kanban stage-column drag (resequencing stage columns themselves, not cards; `groups_draggable` not overridden, defaults to enabled for a many2one groupby) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Dropping a dragged column calls `dynamic_group_list.js`'s `resequence()` → the shared `resequence()` util (`relational_model/utils.js:794-866`) → `orm.webResequence` on `crm.stage` — not one of the framework's four auto-queued producers. Same user-review decision and framework fact as B57: the framework has no queue producer for `webResequence`, so crm adds no new queue hook and disables the control offline instead (architecture.md §3.7, mission AGENTS.md); the gap is a PR known limit. Distinct from B21 (per-record `web_save({stage_id})` when a *card* is dropped into a different column, still framework-auto-queued and unaffected by this change). |
| B59 | `views/crm_stage_views.xml` | 23 | `<field name="sequence" widget="handle"/>` (Stages list drag-to-reorder) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Dragging a row by its handle calls the same `resequence()` util as B58 → the same `orm.webResequence` call on `crm.stage`. Same user-review decision and framework fact as B57/B58: `webResequence` has no framework queue producer, so crm adds no new hook and disables the handle drag offline instead; the gap is a PR known limit. |
| B60 | `views/crm_recurring_plan_views.xml` | 8-9 | `<list editable="bottom">` + `<field name="sequence" widget="handle"/>` (crm.recurring.plan: inline create/edit/resequence) | DISABLE | **New row (this revision)**. An editable-list row's inline edit/create would auto-queue via the framework's `web_save` producer like any form, and the handle's resequence would go through the same `webResequence` path as B58/B59 — but the model is `crm.recurring.plan`, not `crm.lead`/`crm.stage`/`crm.team` or a lead's `mail.activity`, so rule 1 does not apply at all regardless of mechanism — DISABLE. |
| B61 | `views/crm_lost_reason_views.xml` | 49 | `<list string="Channel" editable="bottom">` (crm.lost.reason: inline create/edit) | DISABLE | **New row (this revision)**. Same reasoning as B60: inline edits on an editable list would auto-queue via `web_save`, but `crm.lost.reason` is outside rule 1's model scope — DISABLE. |
| B62 | `views/crm_lead_views.xml` | 504 | Pipeline kanban column config-menu "Edit" (stage-column edit; `group_edit` not set on this `<kanban>`, defaults to enabled per `kanban_arch_parser.js:20`) | DISABLE | **New row (round 2 fix)**. The same column config menu that renders Delete (B57) also renders an "Edit" item (`group_config_menu.js`'s `edit_group` entry, `:87-98`, gated by `canEditGroup()`, `:80-84`); choosing it calls `editGroup()` (`:61-72`), which opens a `FormViewDialog` on the clicked stage's own id (`resModel: groupByField.relation`, i.e. `crm.stage`) and, on save, calls `this.props.list.load()` to reload the kanban. The dialog loads that specific `crm.stage` record outside the view-level `actionId`/`viewType` tracking `OfflinePlugin.isAvailableOffline` keys offline availability on, so opening the dialog for a stage never visited offline throws `ConnectionLostError` — the same uncached-record-navigation reasoning as B18's kanban-card "Edit" menu item, plus a second round-trip on save. Not a bare resolvable write: DISABLE per the navigation-unavailable-offline rule, distinct from B92 (the stage form's own direct field edits, QUEUE); B57 (Delete) was QUEUE at the time this row was written but is now also DISABLE, reclassified by the milestone-2 user review (see B57's current row and Notes #9) — both are DISABLE today, for independent reasons (B57: no framework queue producer for `unlink` on a group; B62: uncached-record navigation). **Correction (milestone-2 list-cell-edit-disable fix):** this row's contrast target was originally B40 (then QUEUE, covering both the stage list and form); B40 is now DISABLE (list only) and the form half is split into B92 (QUEUE), so the contrast above is restated against B92. |
| B63 | `views/crm_lead_views.xml` | 246 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color', 'no_create_edit': True}"/>` (lead form, tag quick-create) | DISABLE | **New row (round 2 fix)**. Only `no_create_edit` is set on this field, not `no_create` or `no_quick_create`; `many2many_tags_field.js`'s `extractProps` therefore computes `canQuickCreate = canCreate && !noQuickCreate` as true, so typing an unmatched tag name in the autocomplete offers a "Create" suggestion (`relational_utils.js:483-515`) whose handler calls `this.orm.call("crm.tag", "name_create", [name], ...)` and immediately links the **returned id** to the lead (`many2many_tags_field.js:127-132`) — an id produced by this very call, so DISABLE per the chained-id rule, same family as B25/B56. Distinct from B55, which classifies the color-edit popover on this same field (an existing tag's `write`, not a `name_create`). **Addendum (round-3 fix):** this "Create" suggestion is itself already hidden offline by the framework before a user could ever select it — `Many2XAutocomplete.suggest()` only adds the create/create-and-edit/search-more suggestions `if (!this.offlinePlugin.isOffline())` (`relational_utils.js:450-454`), and `many2many_tags_field.xml:23` wires this field's `quickCreate` into that same `Many2XAutocomplete`; see Section B-REL's header for the full blanket-coverage statement this row is one instance of. The row is kept (as it already was) for completeness and defense in depth, not because the control is reachable offline today. |
| B64 | `views/crm_lead_views.xml` | 504, 566-576 | Forecast kanban (`crm_lead_view_kanban_forecast` inherits `crm_case_kanban_view_leads` at `:504`) card drag between `date_deadline` columns | QUEUE | **New row (round-4 fix).** `forecast_kanban_renderer.js`'s `isMovableField()` (`:32-34`) explicitly allows dragging a card on `date_deadline` in addition to the base `stage_id`; a successful drop still goes through `CrmKanbanModel.moveRecords` (A15) → the framework's per-record `web_save({date_deadline:...})` producer, the same already-auto-queued mechanism B21's stage-column drag uses, just a different field. Entering the forecast view itself stays DISABLE (A24/A27: its `fill_temporal` read-group is never cached), but a drag inside an already-rendered, previously-cached forecast board is a bare, client-resolvable write — QUEUE by rule 1, no new crm producer needed (framework-auto-queued like B21). |
| B65 | `views/crm_lead_views.xml` | 504 | Forecast kanban record quick-create on a `date_deadline` column (`on_create="quick_create"` inherited from `:504`, enabled for the date groupby by `forecast_kanban_controller.js`'s `isQuickCreateField()`, `:4-6`) | QUEUE | **New row (round-4 fix).** Same quick-create producer as B24 (`web_save([], vals)`), reached through the forecast board instead of the pipeline; `ForecastKanbanController.isQuickCreateField` (`:4-6`) extends the base check so a date-grouped column also offers the quick-create row. QUEUE by the same reasoning as B24 (the quick-create form has no onchange dependency for its editable fields); distinct from `canCreateGroup`'s *group-level* "add next period" column (`forecast_kanban_renderer.js:21-23`, already DISABLE via A24/A27 — adding a new date **group**, not a new **lead**, needs the uncached `fill_temporal` read). **Note (milestone-2 user review):** the per-column "+" quick-add button that triggers this (`addons/web/static/src/views/kanban/kanban_header.xml:21`, `<button class="o_kanban_quick_add" ...>`, same control family as B24's) is itself a `<button>` with no `data-available-offline`, so the framework's `SELECTORS_TO_DISABLE` already disables it offline; crm does not add the attribute. This QUEUE row documents what *would* be queued if the button were enabled, but today it is framework-disabled offline — the control-panel New button is the offline entry point instead (accepted, no crm change). See B24 for the same note. |
| B66 | `views/crm_lead_views.xml`; `views/crm_stage_views.xml`; `views/crm_team_views.xml`; `views/crm_recurring_plan_views.xml`; `views/crm_lost_reason_views.xml` | 7, 321, 365, 504, 708; 22, 37; 123, 134; 8; 49 | Selected-record Action-menu "Duplicate" (framework default, not an XML attribute) on every in-scope editable root: lead form (`:7`)/Leads list (`:321`)/Leads kanban (`:365`)/pipeline kanban (`:504`)/Opportunities list (`:708`); stage list/form (`:22`/`:37`); inherited team list/form (`:123`/`:134`); recurring-plan list (`:8`); lost-reason list (`:49`) | DISABLE | **New row (round-4 fix).** `getActiveActions()` (`addons/web/static/src/views/utils.js:160-169`) defaults `duplicate: true` whenever `create` is true and the arch does not set `duplicate="0"`; none of these roots do. `form_controller.js`'s, `list_controller.js`'s and `kanban_controller.js`'s `getStaticActionMenuItems()` each wire a visible "Duplicate" item to `record.duplicate()`/`list.root.duplicateRecords()`, which call `orm.call(model, "copy", [ids])` (`relational_model/record.js`, `dynamic_list.js`) — the server **creates a new record** and the UI reloads/navigates to the returned id(s): a chained id defeats rule 1 regardless of model, so every one of these roots is DISABLE, including the three (`crm.lead`/`crm.stage`/`crm.team`) that are otherwise QUEUE-eligible. The team occurrences are its CRM-inherited list/form (`sales_team.crm_team_view_tree`/`crm_team_view_form`, retained unchanged by `crm_team_view_tree`'s/`sales_team_form_view_in_crm`'s additive `<xpath>`s). Resolves the Duplicate half of the round-4 Action-menu finding; see also C23 (`copy_data`, no longer excluded). |
| B67 | `views/crm_lead_views.xml`; `views/crm_stage_views.xml`; `views/crm_team_views.xml` | 7, 321, 365, 504, 708; 22, 37; 123, 134 | Selected-record Action-menu "Delete" on `crm.lead`/`crm.stage`/`crm.team` roots | QUEUE | **New row (round-4 fix).** Same `getStaticActionMenuItems()` wiring as B66, this time to `record.remove()`/`list.root.deleteRecords()` → the framework's `web_unlink` producer (`relational_model/record.js`, `dynamic_list.js`'s `_deleteRecords`) — the same already-auto-queued mechanism C3/C14/C16 already classify QUEUE for a bare `unlink([ids])` on these three models; this row is the missing **Action-menu entry point** for that call, distinct from any per-row delete icon. **Correction (m2-closeout):** this QUEUE disposition is reached from the list and form Action menus, where `list_controller.js`/`form_controller.js` mark the item `availableOffline: true`. The kanban lines cited above (`:365`, `:504`) share the same `getStaticActionMenuItems()` call but `kanban_controller.js` sets no `availableOffline` on its copy, so `action_menus.xml`/`cog_menu.xml` grey the item out offline there — a framework gap in `addons/web`, not a crm choice (known limit, architecture.md §3.8); crm does not change it. |
| B68 | `views/crm_recurring_plan_views.xml`; `views/crm_lost_reason_views.xml` | 8; 49 | Selected-record Action-menu "Delete"/"Archive"/"Unarchive" on `crm.recurring.plan`/`crm.lost.reason` (both have a plain `active` field, confirmed in `models/crm_recurring_plan.py` and `models/crm_lost_reason.py`) | DISABLE | **New row (round-4 fix).** Same framework wiring as B66-B67/B69, but on the two out-of-scope models the editable lists B60/B61 already classify DISABLE: `unlink`/`action_archive`/`action_unarchive` all reach the server, but `crm.recurring.plan`/`crm.lost.reason` are outside rule 1's model scope regardless of mechanism — DISABLE, same reasoning as B60/B61. |
| B69 | `views/crm_lead_views.xml`; `views/crm_team_views.xml` | 7, 321, 365, 504, 708; 123, 134 | Selected-record Action-menu "Archive"/"Unarchive" on `crm.lead`/`crm.team` roots | QUEUE | **New row (round-4 fix).** Same `getStaticActionMenuItems()` wiring as B66-B68, to `record.archive()`/`record.unarchive()`/the list equivalents → the framework's `action_archive`/`action_unarchive` producers (AGENTS.md section 2's "Producers" list), already auto-queued with no new crm-side wiring needed — the missing piece was the Action-menu entry point, same as B67. See also C22 (`action_unarchive`, no longer excluded). **Correction (m2-closeout):** same kanban caveat as B67 — this QUEUE disposition is reached from the list and form Action menus (`availableOffline: true` there); on kanban (`:365`, `:504`) `kanban_controller.js` sets no `availableOffline`, so the item is greyed out offline instead (framework gap in `addons/web`, known limit, architecture.md §3.8). |
| B70 | `views/crm_lead_views.xml` | 321, 365, 504, 708 | List/kanban "select all N matching records" (domain selection, `isDomainSelected`/`selectDomain` in `dynamic_list.js`) feeding any of B66-B69's Action-menu operations | DISABLE | **New row (round-4 fix).** Selecting *all records matching the current search domain* (not just the loaded page) resolves ids with a server-side `search()` the UI never shows the caller, and the resulting Duplicate/Delete/Archive/Unarchive call then operates on an id set that was never individually bare-id-verified by the user offline — the selection step itself needs a live server round-trip before any of B66-B69 can even be attempted, so this path is DISABLE regardless of which of those rows' dispositions would otherwise apply to the subset the user actually intended. |
| B71 | `views/crm_lead_views.xml` | 504, 654-661, 975-984 | Pipeline/Leads kanban column, or a grouped-list header, grouped by `team_id` (via the Leads/Opportunities search filters at `:654-661`/`:975-984`) — column/header "Delete" + sequence-handle drag resequence | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** `GroupConfigMenu`'s "Delete" (`group_config_menu.js:102-113`, `deleteGroup()`) calls `orm.unlink("crm.team", [groupId])` and column/header drag-resequence calls the shared `web_resequence` util — neither is one of the framework's four auto-queued producers. Same user-review decision and framework fact as B57-B59: the framework does not queue group-level `unlink`/`webResequence`, so crm adds no new queue hook and disables these column/header controls offline instead (architecture.md §3.7, mission AGENTS.md); the gap is a PR known limit, same family as the stage-column controls. |
| B72 | `views/crm_lead_views.xml`; `report/crm_activity_report_views.xml` | 504, 654-661, 658, 975-984, 981; 30-33, 70-78 | Pipeline/Leads kanban column, or a grouped-list header, grouped by any relation other than `stage_id` (`team_id`, `user_id`, `country_id`, `company_id`, `utm.campaign`/`medium`/`source`, `lost_reason_id`) — column/header "Edit"; the `crm.activity.report` grouped list's own header "Edit" for any of its seven relational group-bys (`mail_activity_type_id`, `subtype_id`, `author_id`, `user_id`, `team_id`, `stage_id`, `company_id`) | DISABLE | **New row (round-4 fix).** Same `GroupConfigMenu` "Edit" mechanism B62 already classifies DISABLE for a stage column, generalized: `editGroup()` opens a `FormViewDialog` on the clicked group's own id for whichever relation the view is currently grouped by, on a model whose record was never individually visited offline for that view/action — DISABLE per the same navigation-unavailable-offline reasoning as B62, now covering every other group-by relation and both the kanban-column and the grouped-list-header renderings of the same `GroupConfigMenu` component. **Correction (round-5 fix):** the Leads search's and the Opportunities search's `<filter string="Company" name="company" context="{'group_by':'company_id'}" groups="base.group_multi_company"/>` (`:658`, `:981`, both already inside this row's cited `654-661`/`975-984` ranges but not named individually) is a `company_id` (`res.company`) group-by, gated by `base.group_multi_company` rather than any CRM access right; it reaches the identical `editGroup()` mechanism as every other relation this row already covers, so it is folded into this row's relation list rather than given its own. **Extension (user-testing fix):** the identical mechanism also covers `report/crm_activity_report_views.xml`'s own grouped list (`:30-33`, `action="action_open_lead" type="object"`), whose search view exposes seven relational group-by filters (`:70-78`); unlike `crm_lead_views.xml`, this report has no separate stage-only Edit row (no B62 equivalent for this file), so this row's DISABLE disposition covers all seven of the report's relations, including `team_id`/`stage_id` — their Delete/resequence counterpart is a different control with a model-dependent disposition; see B73 (the other five relations) and B89 (`team_id`/`stage_id` — QUEUE when this row was written, reclassified **DISABLE** by the milestone-2 user review, see B89's current row and Notes #9). Resolves VAL-INV-005. |
| B73 | `views/crm_lead_views.xml`; `report/crm_activity_report_views.xml` | 654-661, 658, 975-984, 981; 30-33, 70-72, 75, 78 | Grouped kanban column / grouped-list header "Delete" + resequence, grouped by `user_id`, `country_id`, `company_id`, `utm.campaign`/`medium`/`source`, or `lost_reason_id`; the `crm.activity.report` grouped list's own header "Delete" + resequence, grouped by `mail_activity_type_id`, `subtype_id`, `author_id`, `user_id`, or `company_id` | DISABLE | **New row (round-4 fix).** Same `deleteGroup()`/resequence mechanism as B71, but on models outside rule 1's scope (`res.users`, `res.country`, `res.company`, `utm.campaign`, `utm.medium`, `utm.source`, `crm.lost.reason`) — DISABLE regardless of mechanism, same reasoning as B68. **Correction (round-5 fix):** `company_id` (`res.company`, the same `:658`/`:981` multi-company group-by B72 now names) was missing from this relation list even though it is already outside rule 1's model scope exactly like the others here; added for the same reasoning, no mechanism change. **Extension (user-testing fix):** the identical `deleteGroup()`/resequence mechanism also covers `report/crm_activity_report_views.xml`'s own grouped list (`:30-33`) for its five relational group-bys outside rule 1's scope — `mail_activity_type_id` (→ `mail.activity.type`), `subtype_id` (→ `mail.message.subtype`), `author_id` (→ `res.partner`), `user_id` (→ `res.users`), `company_id` (→ `res.company`), confirmed in `report/crm_activity_report.py`'s own field definitions — DISABLE regardless of mechanism, same reasoning as above. The report's other two relations, `team_id`/`stage_id`, are in rule 1's model scope and got their own row, B89 — QUEUE when this row was written, reclassified **DISABLE** by the milestone-2 user review (no framework queue producer for group-level `unlink`/`webResequence`; see B89's current row and Notes #9). Resolves VAL-INV-005. |
| B74 | `views/crm_team_views.xml` | 123 | Inherited CRM team list (`sales_team.crm_team_view_tree`, `addons/sales_team/views/crm_team_views.xml:95-109`, retained unchanged by this file's additive `<xpath>` at `:123`): `multi_edit="1"` cell edits only (`:99`) | DISABLE | **Narrowed (milestone-2 user review); reclassified (milestone-2 list-cell-edit-disable fix, user decision).** This row previously read QUEUE because ordinary cell edits on this inherited list auto-queue through the same multi-edit producer as B40/B60/B61/B88 — but that producer is `DynamicList._multiSave`, which the offline framework does not queue (user decision during milestone 2). Offline, the record is edited from the inherited team form instead, whose Save queues `web_save` (**B75**). **This row still does not cover the handle-drag sequence resequence** (`:100`): that control is split out to its own row, **B90** (DISABLE, for the unrelated `webResequence` framework gap), and this row covers only the list's ordinary multi-edit cell edits. |
| B75 | `views/crm_team_views.xml` | 134 | Inherited CRM team form (`sales_team.crm_team_view_form`, `addons/sales_team/views/crm_team_views.xml:21-94`, retained with crm's own additive fields by `sales_team_form_view_in_crm` at `:134`) Save | QUEUE | **New row (round-4 fix).** The form's own Save is the generic form producer already covered in substance by C15's "`crm.team` write, inherited unchanged"; this row gives it its own Section B entry so the control (not just the model method) is listed, consistent with how every other in-scope form (B1, B92, etc.) has its own row. |
| B76 | `views/crm_team_views.xml` | 256 | Inherited Sales Team dashboard color picker (`kanban_color_picker` on `crm.team`, `addons/sales_team/views/crm_team_views.xml:157`, retained unchanged by this file's `crm_team_view_kanban_dashboard` record, which inherits `sales_team.crm_team_view_kanban_dashboard` at `:259`) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** This control's only entry point is the same generic kanban card-menu toggler B19/B20 rely on (`addons/web/static/src/views/kanban/kanban_record.xml:26`, `<button class="btn btn-light o-no-caret px-2">`), a `<button>` with no `data-available-offline` that the framework already disables offline; crm does not add the attribute to it, so the menu — and this color picker inside it — cannot be opened at all offline. The framework's card-menu disable stays, matching B19/B20's reclassification and reinforcing B77's ("Configuration" link, same menu) already-DISABLE disposition. |
| B77 | `views/crm_team_views.xml` | 256 | Inherited Sales Team dashboard "Configuration" link (`<a class="dropdown-item" type="open">`, `addons/sales_team/views/crm_team_views.xml:160`, same retained-unchanged `crm_team_view_kanban_dashboard` inherit as B76) | DISABLE | **Corrected (m2-fix-view-guards).** A plain record-open navigation to the team's own form; if that specific team was never visited in form view offline, `isAvailableOffline` returns false and opening would throw — same uncached-record-navigation reasoning as B18/B62. Being `type="open"` rather than `type="object"`, this compiles to `KanbanRecord.triggerAction({type:'open'})` directly, not a `ViewButton`, so it is reached by neither `kanban_action_button_patch.js`'s `beforeExecuteActionButton` guard nor `kanban_record_offline_patch.js`'s `onGlobalClick` card-body guard (same B18 family: a card menu opened online and still open when the connection drops leaves this item fully clickable, since the toggler-disable pass can't reach a `DropdownItem` that already rendered). `kanban_record_offline_patch.js`'s `triggerAction` patch (scoped to `crm.lead`/`crm.team`) now blocks this item's handler directly, covering the fresh-open (toggler disabled) and already-open cases alike. DISABLE either way. |
| B78 | `views/crm_team_views.xml` | 134 | Inherited CRM team form "Activate Multi-team" button (`name="crm_team_activate_multi_membership"`, `addons/sales_team/views/crm_team_views.xml:30`, retained unchanged by `sales_team_form_view_in_crm` at `:134`) | DISABLE | **New row (round-4 fix).** `crm_team_form.js`'s `beforeExecuteActionButton` override writes `ir.config_parameter` (a transient, non-rule-1 model) via `orm.call("ir.config_parameter","set_param",...)` and then reloads the current action — a config-level toggle with an immediate action reload, not a bare-id lead/stage/team write — DISABLE per the catch-all rule, same family as A20's access-probe/config-toggle controls. |
| B79 | `views/crm_lead_views.xml` | 366, 513-515 | Leads/pipeline kanban activity-state progressbar segment click (filters the kanban by activity state) | DISABLE | **New row (round-4 fix).** Clicking a progressbar segment calls `kanban_header.js`'s `onBarClicked`, which changes the column's active filter and triggers `this.props.list.load()` with a different domain — the same "reload with a domain/context that may hit uncached data" reasoning as A26/B62, not a bare resolvable write. DISABLE. |
| B80 | `views/crm_lead_views.xml` | 506 | Pipeline kanban stage column header `group_by_tooltip` (hover-only read of per-stage aggregate text) | SKIP | **New row (round-4 fix).** A decorative hover tooltip, not a click handler. **Correction (round-5 fix):** the previous "no additional RPC" claim was wrong — hovering the header debounces into `onTitleMouseEnter`, which `await`s `KanbanHeader.loadTooltip()` (`addons/web/static/src/views/kanban/kanban_header.js:119-127`), a `memoize`d handler that issues `await this.orm.silent.read(resModel, [this.group.value], ["display_name", ...fieldNames])` against the group's own related record (here, the hovered `crm.stage`) to fetch the fields named in `tooltipInfo`, then formats them into the tooltip text. SKIP is kept, not changed to DISABLE: nothing in `onTitleMouseEnter`/`loadTooltip` awaits or surfaces this call's result beyond deciding whether to open the popover, so a `ConnectionLostError` offline reaches the same global `lostConnectionHandler` (`offline_error.js`) every other uncaught offline RPC in this document already relies on — it marks offline and prevents the default error dialog (AGENTS.md section 2's "error handlers" bullet), not something this control does specially; the user sees no tooltip and no error, matching rule 2's "skipped silently offline, never queued" contract via a live server read rather than mere client-side formatting. This corrects the justification only; the row's classification, line, and control are unchanged. |
| B81 | `views/crm_lead_views.xml` | 474 | `<activity js_class="crm_activity">` arch's own Schedule-activity/empty-cell/Send-Mail/record-open controls | DISABLE | **New row (round-4 fix).** The activity view is a distinct, separately-registered arch (not the kanban/list/form card controls already rowed) whose cells open the same transient `mail.activity.schedule` wizard (DISABLE family, B17/B23/BR7) or navigate to a specific lead's form not tracked as visited for this view type — DISABLE per the uncached-navigation and transient-wizard reasoning already used elsewhere in this document. |
| B82 | `views/crm_lead_views.xml` | 390 | `<calendar js_class="crm_calendar">` arch's event-click/double-click navigation to the underlying lead's form | DISABLE | **New row (round-4 fix).** Opening an event navigates to a `crm.lead` form that may never have been visited offline for the calendar's own `actionId`/`viewType` key — same uncached-record-navigation reasoning as B18/B62/B77. DISABLE. |
| B83 | `views/crm_lead_views.xml` | 250 | Lead-form Properties field "Edit Properties" (cog icon on `lead_properties`) definition-access probe | DISABLE | **New row (round-4 fix).** `properties_field.js`'s `checkDefinitionWriteAccess()` calls `user.checkAccessRight(definitionRecordModel, "write", definitionRecordId)` before allowing the definition editor to open; `crm_lead.py:117-118`'s `lead_properties` field resolves `definitionRecordModel` to `crm.team` via `definition="team_id.lead_properties_definition"`. A live access-right RPC gating a shared `crm.team` property-definition edit (not the lead's own Save) — DISABLE per the catch-all rule, same access-probe family as A20. |
| B84 | `views/crm_lead_views.xml`; `wizard/crm_merge_opportunities_views.xml`; `wizard/crm_lead_lost_views.xml` | 675-696, 1268-1275; 41-48; 22-33 | Binding-model (`binding_model_id`) Action-menu openers with no explicit view `<button>`/`<a>`: Send Email / mass mail (`:675-696`), Add/Remove Followers (`mail_followers_edit_action_from_lead`, `:1268-1275`); the merge-opportunities wizard opener (`crm_merge_opportunities_views.xml:41-48`); the Lost wizard's binding entry (`crm_lead_lost_views.xml:22-33`) | DISABLE | **New row (round-4 fix).** All four open a transient composer/wizard (`mail.compose.message`, `crm.merge.opportunity`, `crm.lead.lost`) reached only through the Action menu's dynamic `binding_model_id` list, not an XML-authored button — same DISABLE reasoning as every other transient-wizard opener in this document (B2's convert wizard, B9's lost wizard button, BR5/BR6's merge/mass-convert openers), just via the Action-menu path instead of a view button. |
| B85 | `wizard/crm_merge_opportunities_views.xml` | 19-32 | Merge wizard `opportunity_ids` X2Many list "Add a line" / inline "Create" / "Edit" (no `create="false"`/`add-label` suppression on this X2Many, unlike the mass-convert wizard's `duplicated_lead_ids`, which does set `create="false"`) | DISABLE | **New row (round-4 fix).** `x2many_field.js`'s `onAdd`/`onCreateEdit` open a `SelectCreateDialog`/record form scoped to `crm.lead` ids not already on the wizard, and the wizard itself is transient (`crm.merge.opportunity`, never queueable per AGENTS.md section 2's "transient-model wizard" exclusion) — DISABLE regardless of the X2Many's own target model being otherwise in-scope. |
| B86 | `views/crm_lead_views.xml` | 375, 548, 736 | Mail activity popover (`widget="kanban_activity"`/`widget="list_activity"` on `activity_ids`) "Edit" sub-control (opens the existing activity's own edit form) | DISABLE | **New row (round-4 fix).** Distinct from the popover's "Schedule" and "Mark Done" sub-controls B17/B23/BR7 already classify; "Edit" re-opens a specific, already-created `mail.activity` record's form, a navigation to a record not tracked by `isAvailableOffline` for this widget — DISABLE, same uncached-navigation family as B18/B62/B77/B82. |
| B87 | `views/crm_lead_views.xml` | 375, 548, 736 | Mail activity popover "Done & Schedule Next" sub-control (`action_feedback_schedule_next`, `activity_model_patch.js`) | DISABLE | **New row (round-4 fix).** Returns a transient `mail.activity.schedule` wizard action (same family as the popover's own "Schedule" sub-control, B17/B23/BR7) rather than a bare resolvable write — DISABLE. |
| B88 | `views/crm_lead_views.xml` | 321, 708 | Ordinary (non-tag, non-priority) multi-edit cell Save on the Leads list (`:321`) / Opportunities list (`:708`) | DISABLE | **Reclassified whole (milestone-2 list-cell-edit-disable fix, user decision); not split.** This row already covered only the list's multi-edit cell edits (nothing else is bundled into it), so the reclassification applies to the whole row rather than peeling off a sub-part. List cell edits go through `DynamicList._multiSave`, which the offline framework does not queue (user decision during milestone 2); offline, the record is edited from its form instead, whose save queues `web_save`. The inherited reporting/forecast-list variants (`report/crm_opportunity_report_views.xml`'s `crm_lead_view_tree_opportunity_reporting`, `crm_lead_views.xml:767-782`'s `crm_lead_view_tree_forecast`) inherit this same `multi_edit="1"` list unchanged and need no separate row; see "Round-4 findings not added" above (also updated to DISABLE). |
| B89 | `report/crm_activity_report_views.xml` | 30-33, 76-77 | `crm.activity.report` grouped list header "Delete" + resequence, grouped by `team_id` ("Sales Team" filter, `:76`) or `stage_id` ("Stage" filter, `:77`) | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Resolves VAL-INV-005. Same `GroupConfigMenu`/`deleteGroup()` mechanism as B71: `dynamic_group_list.js`'s `_unlinkGroups()` calls `orm.unlink(groupByField.relation, groupResIds)` and the resequence counterpart calls `webResequence` — neither is one of the framework's four auto-queued producers. Same user-review decision and framework fact as B57-B59/B71: the framework does not queue group-level `unlink`/`webResequence`, so crm adds no new queue hook and disables this report's grouped-list header controls offline instead for both relations here (architecture.md §3.7, mission AGENTS.md); the gap is a PR known limit, same family as B71. |
| B90 | `views/crm_team_views.xml` | 123 | Inherited CRM team list (`sales_team.crm_team_view_tree`, `addons/sales_team/views/crm_team_views.xml:95-109`, retained unchanged by `:123`'s additive `<xpath>`): `widget="handle"` sequence-drag resequence (`:100`) | DISABLE | **New row (milestone-2 user review).** Split out of B74 for an independent reason: dragging the handle calls the same `resequence()` util as B58/B59/B71/B89 → `orm.webResequence` on `crm.team` — not one of the framework's four auto-queued producers (`web_save`/`web_unlink`/`action_archive`/`action_unarchive`). The user approved this as DISABLE: per the mission's principle (architecture.md §3.7, mission AGENTS.md), crm adds no new queue hook for anything the framework does not already queue, so this control is disabled offline instead and the gap is listed in the PR's known limits, same family as B57-B59/B71/B89. **Note (milestone-2 list-cell-edit-disable fix):** B74 itself (the list's remaining ordinary multi-edit cell edits) is now *also* DISABLE, but for the unrelated `_multiSave` framework gap — the two rows share no classification reasoning even though both ended up DISABLE. |
| B91 | `addons/mail/static/src/js/rotting_mixin/rotting_column_progress.xml` | 6 | Mail's rotting badge on pipeline kanban column headers: `<div t-if="rottingAggregate.value > 0" t-on-click="this.onRottingIconClick" ...>`, inherited unchanged into the pipeline kanban's column headers via `crm.ColumnProgress` (`views/crm_kanban/crm_column_progress.xml:3`, `t-inherit="mail.RottingColumnProgress"`), rendered by `CrmColumnProgress extends RottingColumnProgress` (`views/crm_kanban/crm_column_progress.js`), which `crm_kanban_renderer.js` wires in as the kanban's `ColumnProgress` component | DISABLE | **New row (milestone-2 user review), approved by the user as DISABLE.** `onRottingIconClick()` calls `this.props.onRotIconClicked(this.props.group)`, which toggles a rotting-state filter and reloads the column from the server (a `web_read_group`/`web_search_read` with a different domain) — not a bare resolvable write, and not queueable. The clickable element is a `<div>`, not a `<button>`, so the framework's `SELECTORS_TO_DISABLE` does not auto-disable it; crm has not added `data-available-offline`/a guard to it, so it must be disabled from crm (scoped to the crm pipeline kanban) — same reasoning as B79's progressbar-segment filter, which this row joins in VAL-DIS-029. |
| B92 | `views/crm_stage_views.xml` | 37 | `crm_stage_form` field edits (Save) | QUEUE | **New row (milestone-2 list-cell-edit-disable fix), split out of B40.** The form's own Save is the generic `web_save` form producer (`record.js`), bare-id resolvable on `crm.stage`, unaffected by `_multiSave`'s offline gap because a form save never goes through `DynamicList`. Write access is manager-only, so a salesman's queued edit is parked with an `AccessError` by the framework (no rule change) — the same reasoning the combined B40 row previously stated. |

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
with how this document already keeps framework-covered QUEUE rows (Notes #1's B21/B22
bullet) — not because the control is reachable offline today.

| # | File | Line | Field + widget/options | Class | Justification |
|---|---|---|---|---|---|
| BR1 | `views/crm_lead_views.xml` | 354 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>` (Leads list, color-edit) | DISABLE | **New row.** Resolves round-3 scrutiny finding #1 (part A). `crm_case_tree_view_leads` is `multi_edit="1"` (`:321`); `list_renderer.js`'s `onCellClicked()` (`:1520-1557`) checks `multiEdit && record.selected` before the `editable=`-only branch, and on a match calls `this.props.list.enterEditMode(record)` (`:1552`) — selecting the row, then clicking a cell, puts that record in `mode: "edit"`, so `record.isInEdition` (`record.js:148-154`) becomes true for the same reason B55's form occurrence always is. `many2many_tags_field.js`'s `onTagClick()` (`:169`) only early-returns `if (!this.props.record.isInEdition)`; once true, clicking an existing tag opens the color popover, and `switchTagColor()` (`:256-262`) writes `crm.tag` directly — same mechanism and DISABLE reasoning as B55, reached through row selection instead of a form. **Not** covered by the blanket Many2XAutocomplete rule above: the color popover never goes through that component. |
| BR2 | `views/crm_lead_views.xml` | 354 | same field, quick-create | DISABLE | **New row.** Resolves round-3 scrutiny finding #1 (part B). Once the row is in edit mode (BR1), the field's own autocomplete is also live; this occurrence sets no `no_create`/`no_quick_create`/`no_create_edit`, so (same `extractProps` formula as B63) `canQuickCreate` is true and typing an unmatched name offers "Create" → `name_create` on `crm.tag`, consuming the returned id — chained-id DISABLE, same family as B63. **Is** covered by the blanket Many2XAutocomplete rule above: the "Create" suggestion itself never renders offline. Row kept for completeness, same as B63. |
| BR3 | `views/crm_lead_views.xml` | 754 | `<field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>` (Opportunities list, color-edit) | DISABLE | **New row.** Same control and reasoning as BR1, second occurrence: `crm_case_tree_view_oppor` is also `multi_edit="1"` (`:708`). |
| BR4 | `views/crm_lead_views.xml` | 754 | same field, quick-create | DISABLE | **New row.** Same control and reasoning as BR2, second occurrence; covered by the blanket rule. |
| BR5 | `views/crm_stage_views.xml` | 26 | `<field name="team_ids" widget="many2many_tags"/>` (Stages multi-edit list, quick-create) | DISABLE | **New row.** Resolves round-3 scrutiny finding #2. `crm_stage_tree` is `multi_edit="1"` (`:22`); `team_ids` here carries no `no_create`/`no_quick_create`/`no_create_edit` option at all — unlike the stage *form*'s own `team_ids` (`:48`, `no_open`+`no_create` both set, genuinely has no create path; the earlier "both display-only" framing wrongly conflated the two). Once a row is selected and a cell clicked (same mechanism as BR1), typing an unmatched team name offers "Create" → `crm.team.name_create`, consuming the returned id — chained-id DISABLE, same family as B56/B63. No `on_tag_click` option is set here, so there is no paired color-edit control. Covered by the blanket Many2XAutocomplete rule; row kept for completeness, correcting the original "display-only" claim. |
| BR6 | `wizard/crm_lead_pls_update_views.xml` | 12 | `<field name="pls_fields" widget="many2many_tags" options="{'color_field': 'color'}"/>` (PLS-update wizard, quick-create) | DISABLE | **New row.** Resolves round-3 scrutiny finding #3. `pls_fields` sets only `color_field`, no `no_create`/`no_quick_create`, no `on_tag_click`; the wizard's own form is always an editable context, so typing an unmatched value offers "Create" → `name_create` on `crm.lead.scoring.frequency.field`, consuming the returned id — chained-id DISABLE, same family as BR2/BR5/B63, regardless of whether a read-only ACL would reject the create server-side (an ACL rejection does not make the request disappear). Covered by the blanket Many2XAutocomplete rule, **and** doubly unreachable today because the wizard's own opening button (`res_config_settings_views.xml:47-49`, B46) and "Update" footer button (B50) are both already DISABLE with no `data-available-offline`. Row kept for completeness, correcting the original "display-only" claim. |
| BR7 | `views/crm_lead_views.xml` | 736 | `<field name="activity_ids" optional="hide" widget="list_activity"/>` (Opportunities list) | DISABLE | **New row** (completeness pass, not a named round-3 finding). `list_activity.js` (`addons/mail`) renders the same `ActivityButton` component (`@mail/core/web/activity_button`) as the `kanban_activity` widget already classified DISABLE at B17/B23 — confirmed by reading both widget registrations (`kanban_activity.js:1,9`; `list_activity.js:1,9`). One2many (`activity_ids` → `mail.activity`) inline-create control (the popover's "Schedule" action); reachable here on a direct click, independent of the list's own edit mode (unlike BR1-BR5). Same DISABLE reasoning as B17/B23: "Schedule" opens the transient `mail.activity.schedule` wizard; "Done" calls `action_feedback` (**round-4 correction**, not a bare `action_done`) and is bare-id resolvable but has no crm-owned offline handling yet (debatable, same family as B17/B23 — see Notes #2). Same **B86**/**B87** Edit/Done-&-Schedule-Next sub-control rows apply here too (third occurrence, `:736`). |
| BR8 | `views/crm_lead_views.xml` | 168, 188 | `<field name="partner_id" widget="res_partner_many2one" .../>` (lead form; `:168` for `type == 'lead'`, `:188` for `type == 'opportunity'`, one always rendered) | DISABLE | **New row** (completeness pass). `PartnerAutoCompleteMany2one` (`partner_autocomplete_many2one.js`) wraps the standard `Many2One`/`Many2XAutocomplete` — its base "Create"/"Create and edit" suggestion is covered by the blanket rule above — **and additionally** injects an `otherSources` entry (`:67-91`) that queries the external IAP partner-autocomplete service directly; selecting a suggestion calls `onSelectPartnerAutocompleteOption()` (`:97-114`), which opens a prefilled *new* `res.partner` form via `openRecord({context})` (not a bare `name_create`, but still DISABLE under the same reasoning as B2/B25 — creates/matches a partner, needs an explicit follow-up Save; architecture.md §3.3's "Contact lookup" bullet makes the same call for this exact field — "no create option offline (web already hides it — prove it)"). `otherSources` bypasses `suggest()` entirely (`relational_utils.js:307`: `[this.optionsSource, ...this.props.otherSources]`), so it is **not** covered by the blanket rule; whether the external lookup's own network call fails gracefully offline (silently empty, or an uncaught rejection) is **not verified here** — this is a document-only milestone with no browser QA — meaning this row is exactly the "prove it" architecture.md asks for, only partially proven: the base Many2XAutocomplete half is proven (confirmed covered by the blanket rule), the `otherSources` half is not. |

| BR9 | `views/crm_lead_views.xml`; `wizard/crm_merge_opportunities_views.xml` | 235, 238-239, 265, 282, 283, 284, 338, 340, 344-345, 346, 348, 350, 351, 723, 727, 729, 732-733, 734, 737, 739, 740, 741, 749, 750, 753; 11, 15 | Every many2one/many2many field occurrence the "Covered by the blanket Many2XAutocomplete rule" bullet below lists, named individually: lead-form `lost_reason_id`/avatar `user_id`/`state_id`/`campaign_id`/`medium_id`/`source_id`; Leads-list `company_id`/`state_id`/avatar `user_id`/`team_id`/`campaign_id`/`medium_id`/`source_id`; Opportunities-list `partner_id`/`company_id`/`state_id`/avatar `user_id`/`activity_user_id`/`team_id`/`campaign_id`/`medium_id`/`source_id`/`recurring_plan`/`stage_id` (rotting)/`lost_reason_id`; merge wizard `user_id`/`team_id` | DISABLE | **New row (round-4 fix).** The task's per-occurrence requirement is explicit: a field being covered by the blanket `Many2XAutocomplete.suggest()` offline gate (`relational_utils.js:450-458`, `if (!this.offlinePlugin.isOffline())` around the whole create/create-and-edit/search-more/`actionSuggestions` block — confirmed to also wrap subclass overrides like the avatar widget's "Invite teammates" entry, `avatar_many2x_autocomplete.js`) means the control is **unreachable offline today**, not that it has no server-bound entry point online: selecting an unmatched name online still issues `name_create`/opens an Invite dialog and consumes a returned id on a model other than `crm.lead`/`crm.stage`/`crm.team` — DISABLE per the chained-id rule, same family as B63/BR2/BR4/BR5/BR6, for every occurrence. Rows kept for completeness and defense in depth, exactly as B63/BR2 already are; the field list and line numbers are unchanged from the header's own blanket-coverage statement, now given a disposition of their own instead of "no row needed". |
| BR10 | `views/crm_lead_views.xml`; `wizard/crm_merge_opportunities_views.xml`; `wizard/crm_lead_to_opportunity_mass_views.xml` | 168, 188, 235, 238-239, 282, 283, 284, 290, 338, 340, 346, 348, 350, 351, 409, 723, 727, 729, 734, 739, 740, 741, 749, 753; 11, 15; 23 | Many2One's own existing-record open/edit navigation link (readonly `<a class="o_form_uri">` or editable-mode `<button class="o_external_button">`, `many2one.xml:19-36`), a mechanism distinct from and not reached by `Many2XAutocomplete.suggest()`'s offline gate, on every occurrence with `canOpen` true (no `no_open` set) | DISABLE | **New row (round-4 fix).** `openRecordInAction()` (`many2one.js:233-258`) calls `get_record_default_action` on the related model then `doAction` to open its form — navigation to a record whose own `actionId`/`viewType`/`resId` triple was very possibly never visited offline, same `isAvailableOffline` reasoning as B18/B62/B77/B82, regardless of whether the rendered element is the always-auto-disabled button or the not-auto-disabled readonly anchor. `state_id` (`:265` form, `:750` Opportunities-list "rotting" variant) and the lead form's `team_id` (`:294`) explicitly set `no_open` and are correctly excluded; the avatar widget's list-cell occurrences (`user_id`/`activity_user_id`) default `canOpen` to `false` outside a form and are also excluded — see "Round-4 findings not added" above. The two `res_partner_many2one` lead-form occurrences BR8 already rows (`:168`, `:188`) inherit this same link path in addition to BR8's own external-IAP-lookup finding; BR8's text is not changed; this row is the independent disposition that path needed. **Correction (round-5 fix):** the merge wizard's `user_id` (`crm_merge_opportunities_views.xml:11`, `widget="many2one_avatar_user"`, no `no_open` set) is added to this row. `Many2OneAvatarUserField`'s `extractProps` (`addons/mail/static/src/views/web/fields/many2one_avatar_user_field/many2one_avatar_user_field.js`) computes `canOpen: "no_open" in staticInfo.options ? !staticInfo.options.no_open : staticInfo.viewType === "form"` — the same formula the lead form's avatar occurrence already in this row (`:238-239`) relies on — and the merge wizard's own arch is a plain `<form>` (`viewType === "form"`), so `canOpen` is true there exactly as it is on any other form, regardless of the form being dialog-opened from an Action-menu binding (B84) rather than a view's own action; `many2one.js:202` renders the external-link button for any existing value once `canOpen` is true. This was previously left out (see "Round-4 findings not added" below, now corrected) on the stated but unverified doubt that a dialog-opened form might render differently; `extractProps` shows no such special case. |
| BR11 | `views/crm_lead_views.xml` | 246, 354, 754 | `<field name="tag_ids" widget="many2many_tags" .../>`'s popover "Hide in Kanban" checkbox (`many2many_tags_field.xml:40-44`), independent of the color-list B55/BR1/BR3 already classify | DISABLE | **New row (round-4 fix).** `onTagVisibilityChange()` (`many2many_tags_field.js:200-212`) directly calls `tagRecord.update({color: 0 or previousColor}); tagRecord.save();` on `crm.tag` without going through the autocomplete or the color list at all — same DISABLE reasoning and same three occurrences (lead form `:246`, Leads list `:354`, Opportunities list `:754`) as B55/BR1/BR3, just a second, independently selectable control inside the same popover. The two readonly kanban-card tag fields (`:371`, `:543`) stay excluded for the same reason B55/BR1/BR3 already exclude them: `onTagClick` requires `isInEdition`. |
| BR12 | `views/crm_team_views.xml` | 134 | Inherited CRM team form (`sales_team_form_view_in_crm` at `:134`) `member_ids` (many2many to `res.users`) and `crm_team_member_ids` (one2many to `crm.team.member`) X2Many Add/Create/Delete, made reachable (not merely present) by this file's own visibility-toggle at `:199-204` (`invisible="not assignment_enabled"`, replacing the base view's tautological `is_membership_multi or not is_membership_multi`) | DISABLE | **New row (round-4 fix).** `member_ids` (`addons/sales_team/views/crm_team_views.xml:59-76`) is a many2many whose `X2ManyField` renders Add/select plus a "Create" dialog (`relational_utils.js`'s `useSelectCreate`) opening a new `res.users` form; `crm_team_member_ids` (`:77-85`) is a one2many to `crm.team.member` whose kanban-without-control-block still exposes Add (`x2many_field.js`'s `onAdd`/`onCreateEdit`) and its own delete path (a `DELETE` x2many command, distinct from `crm.team`'s own `write`). Both target a model other than `crm.lead`/`crm.stage`/`crm.team` (or need a chained id for the new-record case) — DISABLE, same family as B85/BR9. Distinct from and in addition to C15's generic `crm.team` write and B75's form-Save row, neither of which describes these two fields' own controls. |

**Excluded from B-REL** (occurrences the sweep script found in an editable context, with no
individual row because they fall under the blanket rule above, have no create/edit path at
all, or are unreachable through a different gate):
- Covered by the blanket Many2XAutocomplete rule (plain many2one/many2many fields, no
  distinct widget-level mechanism). **Round-4 correction**: these are no longer "no row
  needed beyond the header statement" — the fix feature's per-occurrence requirement gives
  each one its own disposition at **BR9**, reusing exactly this field list: lead-form
  `lost_reason_id` (`:235`), `user_id`/`many2one_avatar_leader_user` (`:238-239`), `state_id`
  (`:265`, `no_open` only), `campaign_id` (`:282`), `medium_id` (`:283`), `source_id`
  (`:284`); Leads-list `company_id` (`:338`), `state_id` (`:340`), `user_id` (`:344-345`),
  `team_id` (`:346`), `campaign_id` (`:348`), `medium_id` (`:350`), `source_id` (`:351`);
  Opportunities-list `partner_id` (`:723`), `company_id` (`:727`), `state_id` (`:729`),
  `user_id` (`:732-733`), `team_id` (`:734`), `activity_user_id` (`:737`), `campaign_id` (`:739`),
  `medium_id` (`:740`), `source_id` (`:741`), `recurring_plan` (`:749`), `stage_id`/`rotting`
  (`:750`, `no_open` only), `lost_reason_id` (`:753`); merge-wizard `user_id` (`:11`) and
  `team_id` (`:15`) (reachable via BR9 even though the wizard's own opener was wrongly
  believed to be its only gate — see B84, the opener is itself DISABLE for an unrelated
  reason, not because the wizard can't be reached at all). Most of this same field list is
  **also** in **BR10** (the independent existing-record navigation link, a different
  mechanism the blanket autocomplete rule never gated) except where `no_open` suppresses it
  — see BR10's own row for the exact subset. Two of these fields are only create-capable in
  a *list*, not the *form*, for the same field: `team_id` has `no_create`+`no_open` on the
  lead form (`:294`) but no such option on either multi-edit list (`:346`, `:734`);
  `recurring_plan` has `no_create`+`no_open` on the form (`:82`, `:120`, `:446`) but neither
  on the Opportunities list (`:749`). This form/list asymmetry is a genuine inconsistency
  worth a reviewer's attention for milestone 2 but does not change either occurrence's
  classification (both still DISABLE, both still covered by BR9) — flagged in Notes #6.
- No create path at all (option(s) fully suppress it; excluded without a row, not merely
  folded into the blanket statement): lead-form `recurring_plan` (`:82`, `:120`, `:446`,
  `no_create`+`no_open`), `country_id` (`:267`, `no_create`+`no_open`), `lang_id` (`:270`,
  `no_quick_create`+`no_create_edit` both set — equivalent to no create path at all),
  `company_id` (`:290`, `no_create` only — still nav-capable, see BR10), `team_id` (`:294`,
  `no_create`+`no_open` — also excluded from BR10, unlike `company_id`); Leads/Opportunities
  lists' `country_id` (`:341`, `:730`, `no_create`+`no_open`); stage form `team_ids` (`:48`,
  `no_open`+`no_create`, genuinely display-only); `crm.lead.lost`'s `lost_reason_id`
  (`:9`, `widget="badges_many2one"`, whose own component hard-codes
  `activeActions: { create: false }` in `badges_many2one_field.js:53-59`, regardless of any
  XML option); `crm_lead_to_opportunity_mass`'s `user_ids` (`:22`, `no_create`) and `team_id`
  (`:23`, `no_create`); `crm_lead_to_opportunity_mass`'s `duplicated_lead_ids` (`:36`, its
  inline `<list create="false">` disables creation outright). Form field `stage_id`
  (`:19-22`, same occurrence as B5, `widget="rotting_statusbar_duration"`) is a pure
  status-bar/selection widget (`rotting_statusbar.js:8`'s `RottingStatusBarDurationField`
  extends `StatusBarDurationField` (`statusbar_duration_field.js:6`), which extends
  `StatusBarField`, not `Many2OneField`) — it offers no autocomplete and no create path at
  all, unlike the Opportunities list's `stage_id`
  (`:750`, plain `widget="rotting"`, which does extend `Many2OneField` and is in the
  blanket-coverage list above).
- Unreachable because the field's own host wizard is already DISABLE at the entry point
  (its opening Action-menu/button lacks `data-available-offline`, so the framework disables
  it offline before the wizard can even open): `crm.merge.opportunity`'s `user_id`/`team_id`
  (opened via the Action-menu binding at `crm_merge_opportunities_views.xml:41-48`, **B84**
  — **round-4 correction**: the previous version of this bullet wrongly named B52, the
  wizard's own footer *submit* button, as its opener; B52 is reached only after the wizard
  is already open) and `crm.lead2opportunity.partner.mass`'s `user_ids`/`team_id`/
  `duplicated_lead_ids`/`lead_tomerge_ids` (opened only via B15, DISABLE) — each is
  additionally covered by one of the two bullets above (or by BR9/BR10/BR12) regardless, so
  this is a second, independent reason none of them gets a row. `opportunity_ids` is the one
  field in this family that is **not** unreachable: round-4 scrutiny found its own
  Add-a-line/Create/Edit controls (B85) are not actually gated by the opener at all, since
  the opener is a selected-row Action-menu entry, not a per-field attribute.
- `wizard/crm_lead_lost_views.xml`'s `lead_ids` (`:8`) is `invisible="1"` (context-only,
  never rendered) — excluded by the script's invisible filter, no row needed.

## Section C — public `crm.lead` / `crm.stage` / `crm.team` methods reachable from a button

| # | File | Line | Method | Class | Justification |
|---|---|---|---|---|---|
| C1 | `models/crm_lead.py` | 729 | `create(vals_list)` | QUEUE | Reachable via any Save on a new record or the pipeline quick create (B24); framework `web_save`/create producer, bare vals resolvable client-side. |
| C2 | `models/crm_lead.py` | 760 | `write(vals)` | QUEUE | Reachable via any Save/edit/stage-move/priority control (B5, B21, B22); framework `web_save` producer; stage-change side effects (`date_last_stage_update`, won-stage forcing) run fully server-side on replay. **Correction (milestone-2 user review):** no longer reachable via the kanban card-menu color picker (B20, reclassified DISABLE — its only entry point, the card-menu toggler, is framework-disabled offline); the list above drops that reference. **Correction (milestone-2 list-cell-edit-disable fix):** no longer reachable via the Leads/Opportunities list's multi-edit cell Save either (B88, reclassified DISABLE — `_multiSave` is not a framework queue producer); the list above drops that reference too, since the only remaining list-level path to this method offline is B21's per-record drag save. |
| C3 | `models/crm_lead.py` | 971 | `unlink()` | QUEUE | Reachable via the selected-record Action-menu "Delete" (**B67**); framework `web_unlink` producer (bare ids); a salesman's queued delete is parked with an `AccessError` since salesmen have no unlink rights (no rule change). **Correction (milestone-2 user review):** no longer reachable via the kanban card-menu "Delete" (B19, reclassified DISABLE — its only entry point, the card-menu toggler, is framework-disabled offline and crm does not enable it); lead delete stays available offline through B67/B69's QUEUE path instead. |
| C4 | `models/crm_lead.py` | 1042 | `action_restore()` | QUEUE | Reachable via the "Restore" button (B3); bare `[[id]]` write; needs a CRM-side `scheduleORM` producer — see Notes #1. |
| C5 | `models/crm_lead.py` | 1051 | `action_set_lost(**additional_values)` | DISABLE | Reachable today only indirectly, through the transient `crm.lead.lost` wizard's `action_lost_reason_apply` (B49), itself DISABLE; no crm view calls this method directly. A hypothetical direct `action_set_lost([[id]],{lost_reason_id})` call would be bare-args QUEUE-able, but no button reaches it that way today — see Notes #2. |
| C6 | `models/crm_lead.py` | 1057 | `action_set_won()` | QUEUE | Reachable indirectly via the "Won" button (B1), which today calls `action_set_won_rainbowman` (C8); architecture's approved Won producer must call this method directly instead — see Notes #1. |
| C7 | `models/crm_lead.py` | 1083 | `action_set_automated_probability()` | DISABLE | **Reclassified to DISABLE (milestone-2 user review).** Reachable only via the AI-switch `<a>` controls B8/B11, both reclassified to DISABLE by the user's milestone-1 review: predictive scoring is out of scope and the probability only recomputes on the server, so no optimistic UI is possible (architecture.md §3.7). The method itself is `ensure_one`, bare `[[id]]`, and would otherwise be a plain QUEUE-eligible write, but it is unreached by any in-scope button once B8/B11 are disabled. |
| C8 | `models/crm_lead.py` | 1089 | `action_set_won_rainbowman()` | DISABLE | The button-bound method itself (B1's `name=` target); it calls `get_rainbowman_message` (a heavy SQL read) and returns an effect action needing a live round-trip — not itself a resolvable producer. The button (B1) is still QUEUE because the *intended* producer bypasses this wrapper and calls `action_set_won` (C6) directly — see Notes #1/#2. |
| C9 | `models/crm_lead.py` | 1105 | `get_rainbowman_message()` | SKIP | Reachable via the JS calls after any stage-changing save/drag (A12, A14, A16); rainbowman lookup (contract: SKIP, known defect 1). |
| C10 | `models/crm_lead.py` | 1197 | `action_schedule_meeting(smart_calendar=True)` | DISABLE | Reachable via the "Meeting" stat button (B6); calendar-event scheduling (contract: DISABLE). |
| C11 | `models/crm_lead.py` | 1307 | `action_show_potential_duplicates()` | DISABLE | Reachable via the stat button (B7); navigation, read-only server action. |
| C12 | `models/crm_lead.py` | 1320 | `action_convert_to_opportunity()` | DISABLE | Reachable via the "Convert to Opportunity" button (B2); creates/matches a `res.partner` server-side. |
| C13 | `models/crm_lead.py` | 2794 | `prepare_pls_tooltip_data()` | DISABLE | Reachable via the PLS tooltip widget (A10, B9, B10); PLS tooltip lookup (contract: DISABLE). |
| C14 | `models/crm_stage.py` | 70 | `write(vals)` | QUEUE | Reachable via the stage form's Save (**B92**); framework `web_save` producer; write access is manager-only (no rule change; a salesman's queued edit is parked with an `AccessError`, matching current online behavior). **Correction (milestone-2 list-cell-edit-disable fix):** no longer reachable via the stage list's multi-edit cell edits (B40, reclassified DISABLE and split into B92 for the form — `_multiSave` is not a framework queue producer); B40 is dropped from this row's reachability list. |
| C15 | `models/crm_team.py` | 120 | `write(vals)` | QUEUE | Reachable via any team form Save (inherited `sales_team` form, edited in-scope by `sales_team_form_view_in_crm`); framework `web_save` producer (updates the alias when `use_leads`/`use_opportunities` change). |
| C16 | `models/crm_team.py` | 131 | `unlink()` | QUEUE | Reachable via the team list/kanban Delete action (inherited from `sales_team`, the override itself lives in this crm file); framework `web_unlink` producer. |
| C17 | `models/crm_team.py` | 211 | `action_assign_leads()` | DISABLE | Reachable via the "Assign Leads" button (B30); mass assignment across many leads, posts a note, returns a notification action. |
| C18 | `models/crm_team.py` | 762 | `action_open_opportunities()` | DISABLE | Reachable via the stat button (B31); navigation, read-only. |
| C19 | `models/crm_team.py` | 770 | `action_open_unassigned_opportunities()` | DISABLE | Reachable via the dashboard `<a>` (B32); navigation, read-only. |
| C20 | `models/crm_team.py` | 794 | `get_team_switcher_data()` | SKIP | Reachable via the JS call (A6); SKIP is the target disposition, but **correction (this revision)**: today an offline cache miss rejects the whole search-model load rather than falling back to "All Teams" — see A6's corrected justification and Notes #2. |
| C21 | `models/crm_team.py` | 783 | `action_primary_channel_button()` | DISABLE | **New row (this revision)**. Previously excluded as "dead from crm's own UI"; that was wrong — this addon's `crm_team_view_kanban_dashboard` (`views/crm_team_views.xml:259`) inherits `sales_team.crm_team_view_kanban_dashboard`, whose kanban root carries `action="action_primary_channel_button" type="object"` (`addons/sales_team/views/crm_team_views.xml:132`); the inherited view's `<xpath>` edits never touch that attribute, so clicking a team card on the Teams dashboard reaches this crm override. It returns `self.action_open_opportunities()` when `use_opportunities` (otherwise `super()`'s own navigation) — a read-only navigation action, same reasoning as C18/C19 — DISABLE. |
| C22 | `models/crm_lead.py` | 1031 | `action_unarchive()` | QUEUE | **New row (round-4 fix).** Corrects the "Excluded from Section C" exclusion above. Reached by the selected-record Action-menu "Unarchive" item (**B69**), the framework's already-auto-queued `action_unarchive` producer (AGENTS.md section 2) — bare-id resolvable, QUEUE, same family as C3's `unlink`/C14's `write`. |
| C23 | `models/crm_lead.py` | 954 | `copy_data(default=None)` | DISABLE | **New row (round-4 fix).** Corrects the "Excluded from Section C" exclusion above. Reached by the selected-record Action-menu "Duplicate" item (**B66**), via `orm.call("crm.lead", "copy", [ids])` → `copy_data` → a **new** `crm.lead` id — chained-id DISABLE, same reasoning as B66/B25/B56, regardless of `copy_data`'s own body being a plain dict transform with no further RPC. |

## Counts

### Overall

| Classification | Count |
|---|---|
| QUEUE | 26 |
| SKIP | 9 |
| DISABLE | 115 |
| **Total** | **150** |

### Per section

| Section | Rows | QUEUE | SKIP | DISABLE |
|---|---|---|---|---|
| A — JS/XML calls | 23 | 3 (A9, A13, A15) | 6 (A4, A6, A7, A12, A14, A16) | 14 (A1, A2, A5, A10, A11, A19, A20, A21, A22, A23, A24, A25, A26, A27) |
| B — view/wizard/report buttons and controls | 92 | 14 (B1, B3, B5, B21, B22, B24, B53, B54, B64, B65, B67, B69, B75, B92) | 1 (B80) | 77 (B2, B4, B6, B7, B8-B20, B23, B25-B52, B55-B63, B66, B68, B70-B74, B76-B79, B81-B91) |
| B-REL — relational-field create/edit controls | 12 | 0 | 0 | 12 (BR1-BR12) |
| C — public model methods reachable from a button | 23 | 9 (C1, C2, C3, C4, C6, C14, C15, C16, C22) | 2 (C9, C20) | 12 (C5, C7, C8, C10, C11, C12, C13, C17, C18, C19, C21, C23) |
| **Total** | **150** | **26** | **9** | **115** |

(9 rows added in the round-1 fix: A26; B55-B61; C21. 2 more rows added in the round-2 fix:
B62, B63. 8 more rows added in the round-3 fix: BR1-BR8, the new B-REL subsection. 32 more
rows added in this round-4 fix: A27; B64-B88; BR9-BR12; C22-C23 — see Notes #7. The
user-testing fix (VAL-INV-005, VAL-INV-007 — see Notes #8) removed 4 rows (A3, A8, A17,
A18, bare service-handle acquisitions with no server call) and added 1 row (B89), extending
B72 and B73 to also cover `report/crm_activity_report_views.xml`'s grouped-list Edit/Delete,
landing as `01ccefaa` with the previous Total 147 (QUEUE 39 / SKIP 9 / DISABLE 99). The
milestone-2 user-review fix (see Notes #9) reclassifies 10 Section B rows and 1 Section C
row from QUEUE to DISABLE (B8, B11, B19, B20, B57, B58, B59, B71, B76, B89, and C7), adds 2
new DISABLE rows (B90, B91) and narrows B74's scope (no row-count or classification change
for B74 itself at that point) — a net of QUEUE −11, DISABLE +13, for a recomputed Total 149
(QUEUE 28 / SKIP 9 / DISABLE 112). The milestone-2 list-cell-edit-disable fix (see Notes #10)
reclassifies B40, B74 and B88 (the Stages list, the inherited Sales Team list and the
Leads/Opportunities lists' ordinary multi-edit cell edits) from QUEUE to DISABLE — list cell
edits go through `DynamicList._multiSave`, which the offline framework does not queue (user
decision during milestone 2) — and splits B40's bundled form-field-edits half into a new
row, **B92** (QUEUE, the stage form's own Save, unaffected by the `_multiSave` gap); B88 is
reclassified whole, not split (see B88's row). Net for this fix: QUEUE −3 +1 = −2, DISABLE
+3, Total +1 (B92), for a recomputed Total **150** (QUEUE **26** / SKIP **9** / DISABLE
**115**). Counts above are the recomputed totals, not a delta.)

## Notes for review

### 1. QUEUE rows that need a CRM-side `scheduleORM` producer beyond what the framework already queues

The web framework's own producers (`record.js`, `dynamic_list.js`) only ever issue
`web_save`, `web_unlink`, `action_archive`/`action_unarchive`. Every QUEUE row above that is
**not** one of those four is already reached today only through the *online* `orm.call`
path (a plain `type="object"` button dispatch), which throws `ConnectionLostError` offline
with nothing queued. A later milestone must add an explicit
`offline.scheduleORM(model, method, args, kwargs, options)` call from crm-owned JS for each
of these, gated on `isOffline()`, with optimistic UI. **Correction (round-4 fix)**: the
fifth positional argument is `options` (which carries `options.extras`, the systray-display
payload described in AGENTS.md section 2), not `extras` itself — flagged as non-blocking by
round-3 and round-4 scrutiny; fixed here, no row/classification changes:
- **B1/C6 — Won**: call `action_set_won` (not `action_set_won_rainbowman`/C8) with
  `[[record.resId]]`; no rainbowman effect offline (already SKIP per A12/A14/A16/C9).
- **B3/C4 — Restore**: `action_restore` with `[[record.resId]]`.
- **B21 — kanban drag**, **B22/B53/B54 — priority stars** (pipeline kanban, Leads kanban,
  Opportunities list), **B24/C1 — quick create** (and **B65**, the forecast kanban's own
  quick create), **B92/C14 — the stage form's own field edits (Save)**, **B67/C3 —
  Action-menu Delete**, **B69/C22 — Action-menu Archive/Unarchive**, **B75/C15 — the
  inherited team form's Save** are all *already* covered by the framework's own
  `web_save`/`web_unlink`/`action_archive`/`action_unarchive` producers (`record.js`,
  `dynamic_list.js`), so no new crm producer is needed for any of them — listed here only
  to make clear which QUEUE rows do and do not need new crm code. **(milestone-2
  list-cell-edit-disable fix)**: B40/C14 and B74/C15 previously appeared in this bullet for
  the *list's* multi-edit cell edits; that path is now DISABLE (see the next bullet and
  Notes #10) — B40 is split into the list part (DISABLE, no producer needed) and B92 (QUEUE,
  the form's Save, listed above); B74 covers only the list and is now wholly DISABLE.
- Outside this milestone's Section C scope (mail.activity is not `crm.lead`/`stage`/`team`),
  architecture §3.3 also calls for new producers for `mail.activity` `create` (schedule),
  `action_done` (done), and a new `crm.lead.action_log_call` (log a call) — flagged here
  because they are the other half of "QUEUE rows needing a producer" even though the
  triggering controls (B17/B23, kanban_activity widget) are classified DISABLE in *this*
  inventory since no crm-owned offline UI exists for them yet (see Notes #3).
- **No row below needs a producer (milestone-2 user review).** B8/B11/C7 (AI-probability
  switch), B57/B58/B59 (stage delete/resequence), B71/B89 (team/stage group delete and
  resequence from kanban columns and grouped-list headers), B19/B20 (kanban card-menu
  Delete/color picker, unreachable because the card-menu toggler itself is
  framework-disabled offline) and B76 (team dashboard card-menu color picker, same
  toggler) were all reclassified to **DISABLE** by the user's milestone-1 inventory review
  (architecture.md §3.7, mission AGENTS.md). The framework does not auto-queue `orm.unlink`
  on a kanban/list group or `orm.webResequence`, and the mission's principle is that crm
  adds no new queue hook for anything the framework does not already queue — these controls
  are disabled offline instead, and the gap is listed in the PR's known limits. **B90**
  (the inherited team list's handle-drag resequence, split out of B74) and **B91** (mail's
  rotting badge on pipeline column headers) are new rows added by the same review, both
  DISABLE for the same framework-gap reasoning. None of these nine rows needs, or will ever
  need, a crm-side `scheduleORM` producer; see Notes #2 and #9.
- **B40, B74, B88's multi-edit part (milestone-2 list-cell-edit-disable fix).** The Stages
  list's (B40), the inherited Sales Team list's (B74) and the Leads/Opportunities lists'
  (B88, including their inherited report/forecast variants) ordinary multi-edit cell edits
  were reclassified to **DISABLE** by this fix, per the user's decision during milestone 2
  (architecture.md §3.7/§3.8). The reason is distinct from the B8/B11/C7/B57-B59/B71/B89
  family above: those lack a framework queue producer for `unlink`/`webResequence` on a
  *group*; these three instead go through `addons/web`'s `DynamicList._multiSave`, the
  per-record multi-edit list-save path, which likewise has no `ConnectionLostError`/offline
  branch and is explicitly *not* to be patched to add one (crm must not build a second save
  path for the same records a form already saves correctly). None of these three rows
  needs, or will ever need, a crm-side `scheduleORM` producer either — the record is edited
  from its form instead, whose Save already queues `web_save` (B92, B75, and the lead
  form's own Save respectively). See Notes #10.
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
- **B8/B11/C7 — `action_set_automated_probability`** — **resolved (milestone-2 user
  review).** This was previously debatable between QUEUE (content-based: bare `[[id]]`,
  fully resolvable, no onchange/wizard/chained id) and DISABLE (the `<a>` elements are not
  matched by `SELECTORS_TO_DISABLE`, so they need crm-added disabling work regardless, and
  the control is low-value — an "undo my probability override" toggle). The user resolved
  the debate to **DISABLE**: predictive scoring is out of scope and the probability only
  recomputes on the server, so no optimistic UI is possible (architecture.md §3.7). See the
  current B8/B11/C7 rows and Notes #9.
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
- **B57/B58/B59 — stage delete/resequence** — **resolved (milestone-2 user review).** This
  was previously debatable between QUEUE (content-based: bare ids, no onchange/wizard/
  chained id, on `crm.stage`) and the conservative DISABLE alternative (none of
  `orm.unlink`/`orm.webResequence` is one of the framework's four auto-queued producers, so
  the click just throws uncaught offline instead of either queueing or being disabled). The
  user resolved the debate to **DISABLE**, citing the framework fact that stage delete and
  resequence are not queued by the offline framework: crm adds no new queue hook for
  anything the framework does not already queue (architecture.md §3.7, mission AGENTS.md);
  the gap is a PR known limit. The same resolution extends to the same-family rows B71, B89
  (team/stage group delete and resequence) and the new B90 (team list handle resequence) —
  see the current rows and Notes #9.
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

**Superseded (milestone-2 user review, VAL-INV-011):** this paragraph's "future
`OfflinePlugin.scheduleORM` call"/"QUEUE classification" framing no longer applies to
B58/B59. Both were reclassified **DISABLE** by the milestone-2 user review (see their
current rows and Notes #9): the framework has no queue producer for `webResequence`, so crm
adds no `scheduleORM` call for stage-column resequence at all, and none is planned. The
paragraph above is left unedited as sweep history (it was accurate when B58/B59 were still
QUEUE); it does not describe the current or any planned behavior.

### 6. Scrutiny round 3 and the relational-field create/edit sweep (this revision)

A third scrutiny round against `cf127d42` found 3 blocking gaps, all in one previously
unswept category — a many2one/many2many/many2many_tags/one2many field, in an editable
context, whose create/edit mechanism is distinct from the host record's own form/list save:
the Leads/Opportunities multi-edit lists' `tag_ids` color-edit + quick-create
(`crm_lead_views.xml:354,754`), the Stages multi-edit list's `team_ids` quick-create
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
(`crm_lead_views.xml:294`) but not on either Leads/Opportunities multi-edit list
(`:346`, `:734`), and `recurring_plan`'s `no_create`+`no_open` are set on the lead form
(`:82`, `:120`, `:446`) but not on the Opportunities list (`:749`) — in both cases the list
occurrence is still DISABLE today only because it is covered by the Many2XAutocomplete
blanket rule, not because of a matching `no_create` option, so a future milestone that ever
needs to re-enable list quick-create for either field first needs the matching option added
for parity with the form (see "Excluded from Section B-REL" above).

### 7. Round-4 scrutiny close-out (this fix)

A fourth scrutiny round, synthesizing three parallel specialist reviews against `0fc11ef3`
(the commit the round-3 fix above landed as; no crm source changed since, so this fix's
re-verification is against the same HEAD), found 13 blocking control families, grouped
below by the new rows that close them. Every cited file:line was re-opened at this HEAD
(scripted check in "Self-verification"); none is copied uncritically from the review text.
Rows that gather several occurrences of the **same** control across more than one file use
a `;`-separated File/Line pairing (file *i* pairs with line-group *i*), the same convention
`A6`'s multi-line citation already uses within one file, extended across files only where
the task's "one row per distinct control, every file:line listed" allowance applies —
exactly the three families below with cross-view occurrence lists (duplicate/delete/
archive, the two blanket-covered relational families, and the inherited team controls).

1. **Forecast read-group override (Section A)** — `forecast_kanban_model.js:12-43`'s
   `_webReadGroup`/`_loadGroupedList` override was wrongly listed as a zero-hit file in
   "Excluded from Section A"; it reaches a real server `webReadGroup` through
   `super.*` with a forecast-modified context/domain. Closed by **A27** (DISABLE); the
   "Excluded from Section A" bullet is corrected below.
2. **Ordinary multi-edit saves on the Leads/Opportunities lists** — selecting a row and
   editing an ordinary (non-tag, non-priority) cell was never given its own row; closed by
   **B88** (QUEUE at the time), which also cross-references the inherited
   reporting/forecast-list variants (`report/crm_opportunity_report_views.xml`,
   `crm_lead_views.xml:767-782`) that inherit the same `multi_edit="1"` list unchanged,
   needing no separate row. **Correction (milestone-2 list-cell-edit-disable fix):** B88 is
   reclassified **DISABLE** (whole row, not split — see B88's current row and Notes #10):
   `DynamicList._multiSave` is not a framework queue producer, by the user's milestone-2
   decision.
3. **Selected-record Action-menu Duplicate/Delete/Archive/Unarchive, and the matching
   Section C exclusions** — the framework's default-enabled action-menu items on every
   in-scope editable root (lead form/lists/kanbans, stage list/form, inherited team
   list/form, recurring-plan list, lost-reason list) had no Section B rows, and
   `action_unarchive`/`copy_data` were wrongly excluded from Section C. Closed by **B66**
   (Duplicate, DISABLE), **B67** (Delete on `crm.lead`/`crm.stage`/`crm.team`, QUEUE),
   **B68** (Delete/Archive/Unarchive on `crm.recurring.plan`/`crm.lost.reason`, DISABLE),
   **B69** (Archive/Unarchive on `crm.lead`/`crm.team`, QUEUE), **B70** (list/kanban
   select-all-domain selection feeding any of the above, DISABLE), **C22**
   (`action_unarchive`, QUEUE) and **C23** (`copy_data`, DISABLE); the Section C exclusion
   bullet is corrected below.
4. **Non-stage group-bys, grouped-list header menus, and the forecast kanban's own card
   controls** — B56-B58/B62 assumed the pipeline/Leads kanban only ever groups by stage,
   and no row covered a grouped **list** header's config menu or the forecast kanban's
   drag/quick-create. Closed by **B64**/**B65** (forecast card drag and quick-create,
   QUEUE), **B71** (group delete/resequence on a `crm.team` group, QUEUE at the time),
   **B72** (group Edit dialog for any other relation, kanban column or list header,
   DISABLE), **B73** (group delete/resequence on an out-of-scope relation, DISABLE).
   **Correction (milestone-2 user review):** B71 is reclassified **DISABLE** (no framework
   queue producer for group-level `unlink`/`webResequence`; see B71's current row and
   Notes #9).
5. **Inherited Sales Team list/form/dashboard controls** — the CRM-inherited team views
   retain several `sales_team`-owned controls with no row of their own. Closed by **B74**
   (inherited list multi-edit + resequence handle, QUEUE at the time), **B75** (inherited
   form Save, QUEUE, matching the already-existing C15), **B76** (dashboard color picker,
   QUEUE at the time), **B77** (dashboard "Configuration" link, DISABLE), **B78**
   ("Activate Multi-team" button, DISABLE). **Correction (milestone-2 user review):** B74's
   handle-drag resequence is split out to its own row, **B90** (DISABLE); B74 itself is
   narrowed to the list's multi-edit cell edits only. **Correction (milestone-2
   list-cell-edit-disable fix):** B74's remaining multi-edit cell edits are now also
   reclassified **DISABLE** (`_multiSave` is not a framework queue producer, by the user's
   milestone-2 decision; see B74's current row and Notes #10) — B74 no longer stays QUEUE at
   all; it is DISABLE for a reason independent of B90's. B76 is reclassified
   **DISABLE** (its only entry point, the kanban card-menu toggler, is framework-disabled
   offline and crm does not enable it, same as B19/B20; see B76's current row and
   Notes #9).
6. **Binding-model Action-menu openers with no view button, and the merge wizard's own
   X2Many** — Send Email, mass mail, Add/Remove Followers, and the merge/Lost wizard
   openers reach their transient targets only through `binding_model_id`, with no explicit
   `<button>`/`<a>` row; the merge wizard's `opportunity_ids` X2Many also has no
   `create="false"` and exposes its own Add-a-line/Create/Edit. Closed by **B84** (openers,
   DISABLE) and **B85** (merge wizard X2Many, DISABLE).
7. **Blanket-covered many2one/many2many create and Invite occurrences, named individually**
   — the existing Many2XAutocomplete blanket-coverage statement correctly describes the
   mechanism but round-4 requires every occurrence it covers to still get its own
   disposition. Closed by **BR9** (DISABLE), reusing exactly the field list the "Excluded
   from B-REL" bullet already enumerated (see the correction below) plus the merge/
   mass-convert wizard's `user_id`/`team_id`.
8. **Many2one existing-record open/edit navigation link** — distinct from the
   create-suggestion gate: a plain many2one's readonly anchor (`<a class="o_form_uri">`) or
   editable-mode external-link button navigates to a related record's form, a mechanism
   `Many2XAutocomplete.suggest()`'s offline gate never reaches. Closed by **BR10**
   (DISABLE); the "no row needed" framing for `BR8`'s two `partner_id` occurrences is
   corrected to note they are also covered by BR10.
9. **Tag "Hide in Kanban" visibility checkbox** — a second, independent control on the same
   `tag_ids` popover B55/BR1/BR3 already classify (color only); writes `crm.tag` through a
   different handler. Closed by **BR11** (DISABLE).
10. **Activity-state progressbar filters, the stage group-by tooltip, the activity view, and
    the calendar view** — none of the Leads/pipeline kanban's clickable progressbar filter,
    the pipeline's stage group-by-tooltip hover read, the in-scope `<activity>` arch's own
    Schedule/empty-cell/Send-Mail/record-open controls, or the `<calendar>` arch's
    event-open/double-click navigation had a row. Closed by **B79** (progressbar filters,
    DISABLE), **B80** (group-by tooltip, SKIP), **B81** (activity view, DISABLE), **B82**
    (calendar view, DISABLE).
11. **Lead-form Properties "Edit Properties" definition-access probe** — a server
    `checkAccessRight` gating a shared `crm.team` property-definition edit, distinct from
    the lead's own Save. Closed by **B83** (DISABLE).
12. **Mail activity widget's precise sub-controls** — B17/B23/BR7's "Schedule/Mark Done"
    framing undersold the widget: "Mark Done" actually calls `action_feedback` (corrected
    in B17/B23/BR7's text below, no reclassification), and "Edit"/"Done & Schedule Next"
    are separate, previously unrowed sub-controls. Closed by **B86** (Edit, DISABLE) and
    **B87** (Done & Schedule Next, DISABLE).
13. **Inherited team X2Many create/delete, and the false 52/44/8 relational occurrence
    partition** — `member_ids`/`crm_team_member_ids` on the CRM-inherited team form are
    one2manys with their own Add/Create/Delete, outside the "plain many2one" sweep; and
    the round-3 fix's "52 candidates = 44 blanket-covered + 8 BR rows" partition is
    arithmetically wrong (BR1-BR4/BR8 are not one-field-one-row, and the parser skipped
    inherited roots). Closed by **BR12** (team X2Many Add/Create/Delete, DISABLE) and the corrected
    occurrence-count paragraph replacing "Sweep method, round 4"'s partition claim, in
    Notes #6 above.

**Round-4 findings not added (with reason):**
- The avatar-widget many2one occurrences in the Leads/Opportunities **list** cells
  (`user_id` at `crm_lead_views.xml:344-345`, `activity_user_id` at `:737`) are *not* added
  to BR10's navigation-link family: `many2one_avatar_user_field.js`'s `extractProps`
  computes `canOpen: "no_open" in options ? !no_open : viewType === "form"` — with no
  `no_open` option set on either occurrence, `canOpen` defaults to `false` outside a form,
  so neither renders the readonly anchor or the external-link button in a list. The lead
  **form**'s avatar occurrence (`user_id`, `:238-239`, `widget="many2one_avatar_leader_user"`,
  which extends the same base field) has no such suppression (`viewType === "form"`) and
  *is* in BR10.
- The ordinary multi-edit cell save's two inherited reporting/forecast-list variants
  (`report/crm_opportunity_report_views.xml:5-11`'s `crm_lead_view_tree_opportunity_reporting`
  and `crm_lead_views.xml:767-782`'s `crm_lead_view_tree_forecast`) are not given separate
  rows: both inherit `crm_case_tree_view_oppor`'s `multi_edit="1"` list (B88) unchanged —
  neither `<xpath>` touches that attribute or any editable field — so B88's disposition
  already covers them (**DISABLE** since the milestone-2 list-cell-edit-disable fix); see
  B88's justification.
- The mail activity popover's "optional assign/upload controls" the round-4 relational
  review mentioned in passing (alongside Edit and Done & Schedule Next) are not given their
  own row: the review gave no file:line for them beyond the parent widget's own three
  occurrences (already B17/B23/BR7/B86/B87), so there is nothing further to independently
  verify or cite.
- The mass-convert wizard's `user_ids` (`crm_lead_to_opportunity_mass_views.xml:22`) is in
  BR9's create-suggestion family but not BR10's navigation-link family: it is a
  `many2many_avatar_user` **X2Many** chip widget, not a many2one, so there is no single
  readonly anchor/external-link button to check (BR10 is a many2one-only family, same scope
  as BR8). **Correction (round-5 fix):** the merge wizard's `user_id`
  (`crm_merge_opportunities_views.xml:11`) was previously grouped with this same bullet and
  kept out of BR10 on the stated doubt that whether it renders a link inside the wizard's
  dialog-opened form was "not independently confirmed in a live browser". That doubt does
  not survive reading `extractProps` for `many2one_avatar_user`: `canOpen` depends only on
  the `no_open` option and `staticInfo.viewType`, with no special case for a dialog-opened
  form, and the merge wizard's own arch is a plain `<form>` like any other — so `user_id`
  does render the link exactly as the lead form's own avatar occurrence does. It is moved
  into **BR10** (DISABLE) and removed from this exclusion list; see BR10's row for the full
  reasoning.

### 8. User-testing fix (VAL-INV-005, VAL-INV-007)

A round of document/source-only user-testing validation against `4bdd42c3` (the commit the
round-5 fix above landed as; no crm source changed since, so this fix's re-verification is
against the same HEAD) found 2 blocking gaps, closed above.

**VAL-INV-005**: `report/crm_activity_report_views.xml`'s own grouped list (`:30-33`) had no
row for its `GroupConfigMenu` "Edit"/"Delete" controls across the seven relational
group-bys its search view exposes (`:70-78`) — the same `GroupConfigMenu` mechanism B71/B72/
B73 already classify for `crm_lead_views.xml`'s kanban/list, just unswept for this second
file. Closed by extending **B72** (Edit, all seven relations, DISABLE — this report has no
separate stage-only Edit row, unlike B62's `crm_lead_views.xml` case, so B72 alone covers
all seven here, including `team_id`/`stage_id`), extending **B73** (Delete/resequence on the
five relations outside rule 1's model scope, DISABLE), and adding **B89** (Delete/resequence
on `team_id`/`stage_id`; QUEUE at the time, same reasoning as B71 — a bare `orm.unlink` on a
client-known `crm.team`/`crm.stage` id). **Correction (milestone-2 user review):** B89 is
reclassified **DISABLE** for the same reason as B71 (no framework queue producer for
group-level `unlink`/`webResequence`); see B89's current row and Notes #9 below.

### 9. Milestone-2 user review (this fix)

The user reviewed the milestone-1 inventory (committed as `01ccefaa`) per mission.md
section 11 and architecture.md section 3.7, and resolved the open debates and reclassified
several rows:

- **B8, B11, C7 (AI-probability switch and its method) → DISABLE.** Resolves the Notes #2
  debate against QUEUE: predictive scoring is out of scope and the probability only
  recomputes on the server, so no optimistic UI is possible.
- **B57, B58, B59 (stage delete, pipeline column drag, stage-list handle resequence) →
  DISABLE.** Resolves the Notes #2 debate against QUEUE, citing the framework fact that
  stage delete and resequence are not queued by the offline framework. No new CRM queue
  hook is added for anything the framework does not queue; the gap goes into the PR's known
  limits.
- **B71, B89 (team/stage group delete and resequence from kanban columns and grouped-list
  headers) → DISABLE.** Same user-review decision and the same framework fact as B57-B59:
  group-level `unlink`/`webResequence` have no framework queue producer.
- **B19 (kanban card-menu "Delete"), B20 (kanban card-menu color picker), B76 (team
  dashboard card-menu color picker) → DISABLE.** The user approved this: these controls'
  only entry point, the kanban card-menu toggler (`addons/web/static/src/views/kanban/
  kanban_record.xml:26`), is a `<button>` the framework already disables offline, and crm
  does not add `data-available-offline` to it. The framework's card-menu disable stays;
  lead delete stays available offline through the Action-menu path instead (**B67**/**B69**,
  QUEUE).
- **B90 (new row): the inherited Sales Team list's `widget="handle"` sequence drag →
  `webResequence`, no framework producer → DISABLE.** The user approved this as DISABLE,
  split out of B74 for an independent reason (B74 at the time stayed QUEUE for the list's
  ordinary multi-edit cell edits; B74 is itself also reclassified DISABLE by the later
  milestone-2 list-cell-edit-disable fix, for the unrelated `_multiSave` gap — see Notes #10).
- **B91 (new row): mail's rotting badge on pipeline kanban column headers
  (`addons/mail/static/src/js/rotting_mixin/rotting_column_progress.xml:6`) → DISABLE.** The
  user approved this: the badge reloads the column from the server and is not disabled by
  the framework (it is a `<div>`, not a `<button>`).
- **B24, B65 (pipeline/forecast kanban quick create) — note added, no reclassification.**
  The per-column "+" quick-add button (`addons/web/static/src/views/kanban/
  kanban_header.xml:21`) is itself a framework-disabled `<button>` offline, so the
  control-panel New button is the offline entry point instead (accepted, no crm change).

No row below this point in the document still reads as needing a crm-side `scheduleORM`
producer for B8, B11, C7, B57, B58, B59, B71, B89, B19, B20 or B76 — see the corrected
cross-references throughout Section B/C and Notes #1/#2 above. B3/C4 (Restore) and B67/B69
(Action-menu Delete/Archive/Unarchive) are unaffected and stay QUEUE.

**VAL-INV-007**: four Section A rows (A3, A8, A17, A18) classified a bare
`useService("orm"/"action")` handle acquisition SKIP. Rule 2 reserves SKIP for a
decorative/advisory *read*; acquiring a handle issues no server call at all, so it is not an
entry point of any kind and was never eligible for a classification token in the first
place. Removed (not renumbered, per this document's existing no-reassignment convention —
see the top-of-document preamble). Every call actually made through each removed handle
already had, and keeps, its own row: A3's `this.actionService` handle → A5's
`doAction("sales_team.crm_team_action_config")`; A8's `this.orm` handle → A10's
`orm.call("crm.lead", "prepare_pls_tooltip_data", ...)` (A9/A11 use `this.props.record`, not
the removed handle); A17's `this.orm` handle → A19's `orm.cache().searchRead(...)` and A21's
`orm.silent.call("ir.module.module", "button_immediate_install", ...)`; A18's `this.action`
handle → A22's and A23's `this.action.doAction(...)`. The Section A sweep-method header now
states this exclusion once, matching how it already explains the `user.isAdmin`/
`fillTemporalService` exclusions.

### 10. Milestone-2 list-cell-edit-disable fix (this fix)

A further user decision during milestone 2 (architecture.md §3.7/§3.8, mission.md section
11): list cell editing is disabled offline, wholesale, in the `crm.lead` lists (Leads,
Opportunities, and the inherited report/forecast lists), the `crm.stage` list and the
inherited `crm.team` list. These lists are `multi_edit="1"` with no `editable` attribute, so
every cell edit on a selected row goes through `addons/web`'s `DynamicList._multiSave`
(`model/relational_model/dynamic_list.js`), which has no `ConnectionLostError`/offline
branch at all: it discards every selected record's in-progress edit and re-throws on any
save error, online or offline alike. Per the mission's AGENTS.md section 4 ("never build a
second offline engine" / "don't change the queue's conflict semantics"), `_multiSave` is
**not** patched to queue — doing so would mean maintaining a second, `addons/crm`-owned
save/queue path for the exact same records a form save already queues correctly through the
framework's existing `web_save` producer, duplicating logic the framework already owns.
Offline, the record is edited from its form instead; the form's Save is unaffected (it never
goes through `DynamicList`) and keeps queuing exactly one `web_save` per record, replayed on
reconnect like any other queued form save (**VAL-DIS-031**).

- **B40 (Stages list) → DISABLE, split.** The original row bundled the list's multi-edit
  cell edits (`crm_stage_tree`, `:22`) together with the form's own field edits
  (`crm_stage_form`, `:37`) under one classification. Since the list half and the form half
  now classify differently, the row is split: **B40** keeps the list half (DISABLE) and a
  new row, **B92**, takes the form half (QUEUE, unaffected by the `_multiSave` gap). This
  split was necessary for internal consistency (every row has exactly one class), not
  optional — see B40's and B92's current rows.
- **B74 (inherited Sales Team list) → DISABLE, not split further.** Already narrowed by the
  milestone-2 user review to cover only the list's ordinary multi-edit cell edits (the
  handle-drag resequence was already split out to B90 by that earlier fix); no further split
  is needed, the whole row's remaining scope reclassifies to DISABLE.
- **B88 (Leads/Opportunities lists) → DISABLE, reclassified whole, not split.** This row
  already covered only the lists' ordinary multi-edit cell edits (and the inherited
  reporting/forecast-list variants, which need no row of their own since they inherit the
  same `multi_edit="1"` list unchanged); there is no non-multi-edit part bundled into it to
  split off, so the whole row reclassifies.
- **Totals.** This fix's net change is QUEUE −3 (B40, B74, B88) +1 (B92, the new row split
  from B40) = −2, DISABLE +3 (B40, B74, B88), for one net new row (B92) — recomputed Total
  **150** (QUEUE **26** / SKIP **9** / DISABLE **115**), up from the prior Total 149 (QUEUE
  28 / SKIP 9 / DISABLE 112). See the Counts section above for the full per-section
  breakdown; the "150/26/9/115" numbers here are the recomputed totals, not a delta, and
  differ from the "149 if B88 is reclassified whole" estimate only because of B40's row
  split (not because of B88, which is whole) — see VAL-INV-010's note that the check is
  internal consistency, not these specific numbers.
- **Row selection and the action menu are unaffected.** Only the cell-editor entry points
  (`onCellClicked`'s multi-edit branch, `onCellKeydownReadOnlyMode`'s Enter handling in
  `addons/web`'s `list_renderer.js`) are blocked offline for these three models; row
  selection itself (`canSelectRecord`, `toggleRecordSelection`) is deliberately left alone,
  so the selected-record Action-menu Archive/Unarchive/Delete (B67/B69, `crm.lead`; the
  Section C/B rows for `crm.team`/`crm.stage` where applicable) keep queuing exactly as
  before (**VAL-QUEUE-007/-008**). This is why the fix replaces (not extends) the prior
  `m2-config-list-guards` feature's blunt `canSelectRecord=false` guard on `crm.stage`/
  `crm.team` with a cell-edit-scoped guard instead: disabling selection outright offline
  would have also disabled the action menu, which is explicitly required to keep working.
- **No crm producer is added or will be needed** for B40, B74 or B88's multi-edit part (see
  Notes #1's updated bullet); the gap belongs in the PR's known limits with the exact wording
  "List cell editing is disabled offline; edit records from their form." (architecture.md
  §3.8).
