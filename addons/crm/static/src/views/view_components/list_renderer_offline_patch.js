import { ListRenderer } from "@web/views/list/list_renderer";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B59/B90 (VAL-DIS-017): dragging a `widget="handle"` row (the Stages list,
 * `crm_stage_views.xml:23`, and the inherited Sales Team list,
 * `sales_team/views/crm_team_views.xml:100`, retained unchanged by
 * `crm_team_views.xml:123`) calls the same shared `resequence()` util as
 * the pipeline's column drag (B58/B71/B73, blocked offline the same way by
 * `CrmKanbanRenderer.canResequenceGroups` in `crm_kanban_renderer.js`) ->
 * `orm.webResequence`, never one of the framework's four auto-queued
 * producers (architecture.md §3.7).
 *
 * B60 (`crm.recurring.plan`, `crm_recurring_plan_views.xml:9`) has the same
 * handle field, so it's covered by the same list below.
 */
const HANDLE_DRAG_DISABLED_MODELS = ["crm.stage", "crm.recurring.plan", "crm.team"];

/**
 * B60/B61 (VAL-DIS-017): `crm.recurring.plan` and `crm.lost.reason` are
 * `editable="bottom"` lists, but neither is a lead, stage, team or lead
 * activity (rule 1's model scope, offline_inventory.md's classification
 * rules), so an inline edit's `web_save` must never be allowed to queue.
 * There is no handler on the save path itself to guard (the record isn't
 * saved until the row leaves edition), so entry into edition is blocked
 * instead: a cell click (or Enter) opens no editor at all.
 */
const READONLY_OFFLINE_MODELS = ["crm.recurring.plan", "crm.lost.reason"];

/**
 * B40/B74 (VAL-DIS-017 says these "still queue"; reclassified here to
 * DISABLE -- see the KNOWN-LIMIT in this feature's handoff): the Stages
 * list (`crm_stage_views.xml:22`) and the inherited Sales Team list
 * (`sales_team/views/crm_team_views.xml:100`) carry `multi_edit="1"` with
 * no `editable` attribute, so `ListRenderer.isInlineEditable`'s default
 * (`!!this.props.editable`) is false and the *only* way to edit a cell,
 * online or offline, is to check a row and let `Record._update` route
 * through `this.model.root._multiSave` (`model/relational_model/record.js`,
 * `this.selected && this.model.multiEdit`). Unlike every other save
 * producer -- `Record._save`'s own path (`_offlineSave`), `DynamicList
 * ._saveRecords`, `._deleteRecords`, `._toggleArchive` (all in
 * `model/relational_model/dynamic_list.js`) -- `DynamicList._multiSave`
 * has no `ConnectionLostError` branch: it discards the edit and re-throws
 * on any save error, offline or not. Queuing it would mean adding a new
 * catch there, i.e. patching a save path shared by every multi-edit list
 * in every installed app, not just these two crm models -- out of this
 * fix's addons/crm scope and against "never build a second offline
 * engine." Per architecture.md §3.7's own principle for an action the
 * framework doesn't queue, the control is disabled offline instead: no
 * row can be checked (`canSelectRecord`), so multi-edit, the only edit
 * entry point on these two lists, never triggers.
 */
const MULTI_EDIT_SELECTION_DISABLED_MODELS = ["crm.stage", "crm.team"];

patch(ListRenderer.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    /** @override */
    get canResequenceRows() {
        if (
            this.crmOffline.isOffline() &&
            HANDLE_DRAG_DISABLED_MODELS.includes(this.props.list.resModel)
        ) {
            return false;
        }
        return super.canResequenceRows;
    },

    /** @override */
    isInlineEditable(record) {
        if (this.crmOffline.isOffline() && READONLY_OFFLINE_MODELS.includes(record.resModel)) {
            return false;
        }
        return super.isInlineEditable(record);
    },

    /** @override */
    get canSelectRecord() {
        if (
            this.crmOffline.isOffline() &&
            MULTI_EDIT_SELECTION_DISABLED_MODELS.includes(this.props.list.resModel)
        ) {
            return false;
        }
        return super.canSelectRecord;
    },
});
