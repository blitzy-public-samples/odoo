import { PriorityField } from "@web/views/fields/priority/priority_field";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";
import { blocksMultiEditOffline } from "./list_renderer_offline_patch";

/**
 * Finding 18 (VAL-DIS-030, row B54's "always-editable widget on a
 * checked row" case): the priority star carries `data-available-offline`
 * on its own `<button>` (`priority_field.xml`), so the framework's
 * `SELECTORS_TO_DISABLE` pass never touches it, and `onStarClicked` calls
 * `updateRecord` -> `this.props.record.update()` directly -- a different
 * entry point from `ListRenderer.onCellClicked`/`onCellKeydownReadOnlyMode`
 * (`list_renderer_offline_patch.js`), which this widget's own click
 * handler never reaches at all (`t-on-click.stop`). On a checked row of a
 * multi-edit list, `Record._update()` routes straight to
 * `DynamicList._multiSave()` (`record.js`), which has no offline branch
 * and discards the edit on error -- the exact unqueued path
 * `list_renderer_offline_patch.js` exists to keep crm.lead/crm.stage/
 * crm.team list cell edits away from. Guard the widget's own write entry
 * point with the same `blocksMultiEditOffline` predicate (scoped to the
 * same three models, the same selected+multi-edit condition) so a
 * standalone priority star -- a kanban card, a form, or an *unchecked*
 * list row -- keeps queueing exactly as before (B22/B53/B54's existing
 * per-record `web_save({priority})` producer), and only the checked-row
 * list case is blocked, with no visible change and nothing queued.
 */
patch(PriorityField.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    /** @override */
    async updateRecord(value) {
        if (blocksMultiEditOffline(this.crmOffline, this.props.record)) {
            return;
        }
        return super.updateRecord(value);
    },
});
