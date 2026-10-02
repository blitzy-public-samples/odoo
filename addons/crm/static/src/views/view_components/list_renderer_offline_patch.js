import { effect, onMounted, onWillDestroy } from "@odoo/owl";
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
 * crm.lead, crm.stage and crm.team lists are `multi_edit="1"` with no
 * `editable` attribute, so the only way to open a cell editor at all,
 * online or offline, is to check a row first and let `onCellClicked`'s
 * `multiEdit && record.selected` branch (`list_renderer.js`) call
 * `list.enterEditMode()`, which routes the eventual save through
 * `DynamicList._multiSave` (`model/relational_model/dynamic_list.js`).
 * Unlike every other save producer, `_multiSave` has no
 * `ConnectionLostError` branch: on any save error, offline or not, it
 * discards the edit on every selected record and re-throws. Queuing it
 * would mean patching a save path shared by every multi-edit list in every
 * installed app, not just these three models -- out of addons/crm's scope
 * and against "never build a second offline engine" (AGENTS.md section 4).
 * architecture.md §3.7 records the resulting decision: disable cell
 * editing offline for these lists; the record is edited from its form
 * instead, whose save already queues a plain `web_save`.
 *
 * `onCellClicked`'s multi-edit branch is reached through `record.selected`
 * alone and never consults `canSelectRecord` (`list_renderer.js:1527`), so
 * disabling selection would not close this entry point for a row already
 * checked before going offline -- and row selection itself must stay
 * available offline (action-menu Archive/Unarchive/Delete still queue
 * through it). So the guard sits on the cell-edit entry points instead: a
 * click (`onCellClicked`) or Enter (`onCellKeydownReadOnlyMode`) on a
 * selected row's cell does nothing while offline, and the `effect` below
 * forces a row already mid-edit out of edition (discarding, never saving)
 * the moment the connection drops.
 */
export const CELL_EDIT_DISABLED_MODELS = ["crm.lead", "crm.stage", "crm.team"];

/**
 * True when `record`'s only possible editor offline on this list would be
 * the multi-edit one blocked above: offline, the model is in scope, the
 * list is in multi-edit mode and the record is checked. Shared by the
 * click guard, the keyboard guard and the mid-edit effect below so the
 * three can't drift from each other, and by `priority_field_offline_patch.js`
 * (finding 18: a widget that calls `record.update()` directly, bypassing
 * `onCellClicked` entirely, reaches the exact same `_multiSave` path for a
 * checked row). `record.resModel`/`record.model` are the same values the
 * record's own list exposes (`DataPoint.resModel` reads `config.resModel`,
 * and every record of a list shares that list's `model`), so a bare
 * `Record` is all either caller needs -- no separate `list` parameter.
 */
export function blocksMultiEditOffline(crmOffline, record) {
    return (
        crmOffline.isOffline() &&
        CELL_EDIT_DISABLED_MODELS.includes(record?.resModel) &&
        record?.model.multiEdit &&
        record?.selected
    );
}

/**
 * True when `record` must be forced out of edition offline for either
 * reason this file enforces: the multi-edit entry point above
 * (crm.lead/stage/team, checked row), or finding 17's distinct one --
 * `crm.recurring.plan`/`crm.lost.reason` are plain `editable="bottom"`
 * lists (no multi-edit involved at all), so a row already in inline
 * create or edit when the connection drops must leave edition too, not
 * just be blocked from *entering* it (`isInlineEditable` below only ever
 * gates a fresh click). Used only by the mid-edit effect, since
 * `onCellClicked`/`onCellKeydownReadOnlyMode` reach these two models
 * through `isInlineEditable` instead (never through multi-edit, as
 * neither list sets `multi_edit="1"`).
 */
function blocksEditOffline(crmOffline, list, record) {
    return (
        !!record &&
        (blocksMultiEditOffline(crmOffline, record) ||
            (crmOffline.isOffline() && READONLY_OFFLINE_MODELS.includes(list.resModel)))
    );
}

patch(ListRenderer.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();

        // A row can be mid cell-edit when the connection drops: checked
        // and multi-edited (crm.lead/stage/team) or inline-created/-edited
        // (crm.recurring.plan/crm.lost.reason, finding 17). Nothing on
        // either save path itself can be guarded (`_multiSave` has no
        // offline branch and is not patched -- see the comment above; the
        // other two models' lists have no handler on the save at all,
        // only on entry into edition), so the row is forced out of
        // edition the moment offline is detected: `leaveEditMode({
        // discard: true })` reverts the in-progress edit (or drops a
        // brand new, not-yet-saved row entirely) instead of leaving it to
        // be committed later, so nothing can ever look saved without
        // being sent or queued. `effect()` re-runs whenever `isOffline()`
        // changes, independently of any unrelated render (same pattern as
        // `crm_form.js`'s AI-switch guard).
        const forceLeaveEditModeOffline = () => {
            const list = this.props.list;
            const edited = list.editedRecord;
            if (blocksEditOffline(this.crmOffline, list, edited)) {
                list.leaveEditMode({ discard: true });
            }
        };
        let disposeEffect = () => {};
        onMounted(() => {
            disposeEffect = effect(forceLeaveEditModeOffline);
        });
        onWillDestroy(() => disposeEffect());
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
    async onCellClicked(record, column, ev, newWindow) {
        if (blocksMultiEditOffline(this.crmOffline, record)) {
            // Online, this is the *only* way `onCellClicked` opens a cell
            // editor on these three models (`multiEdit && record.selected`,
            // `list_renderer.js`, never gated by `canSelectRecord`). Doing
            // nothing here -- not even falling through to `super()` --
            // keeps the row selected and leaves it in readonly mode: no
            // RPC, nothing queued, no value shown as saved.
            return;
        }
        return super.onCellClicked(record, column, ev, newWindow);
    },

    /** @override */
    onCellKeydownReadOnlyMode(hotkey, cell, group, record) {
        if (hotkey === "enter" && blocksMultiEditOffline(this.crmOffline, record)) {
            // Same guard as `onCellClicked` for the keyboard path: Enter
            // on a selected row's cell opens no editor offline either.
            // Returning `true` (handled) only swallows the key
            // (`onCellKeydown`'s `preventDefault`/`stopPropagation`); it
            // does not call `enterEditMode`.
            return true;
        }
        return super.onCellKeydownReadOnlyMode(hotkey, cell, group, record);
    },
});
