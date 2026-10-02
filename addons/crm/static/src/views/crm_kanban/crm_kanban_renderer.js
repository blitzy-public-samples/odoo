import { CrmColumnProgress } from "./crm_column_progress";
import { RottingKanbanHeader } from "@mail/js/rotting_mixin/rotting_kanban_header";
import { RottingKanbanRenderer } from "@mail/js/rotting_mixin/rotting_kanban_renderer";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

class CrmKanbanHeader extends RottingKanbanHeader {
    static components = {
        ...RottingKanbanHeader.components,
        ColumnProgress: CrmColumnProgress,
    };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    /**
     * @override
     *
     * B80 / VAL-SKIP-004: `loadTooltip` (addons/web's `kanban_header.js`) is
     * `memoize`d with no arguments, so its first outcome -- success or
     * rejection -- is cached for the component's whole life. Never let a
     * `ConnectionLostError` reach it while offline, or the tooltip would
     * stay broken even after reconnecting; skip the call entirely instead
     * of catching it, the same "skip, don't catch" rule as every other
     * offline probe in this addon (architecture.md §2).
     */
    async onTitleMouseEnter(ev) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.onTitleMouseEnter(...arguments);
    }

    /**
     * @override
     *
     * B91 / VAL-DIS-029: the rotting badge is a plain `<div>`
     * (`mail.RottingColumnProgress`'s template), not a `<button>`, so the
     * framework's `SELECTORS_TO_DISABLE` pass never reaches it. Clicking it
     * calls `RottingProgressBarState.toggleFilterRotten()`, which calls
     * `group.applyFilter()` -- a genuine `list.load()` round trip, not one
     * of the four auto-queued producers -- so block it the same way as the
     * other DISABLE rows instead of letting a `ConnectionLostError` surface
     * as an uncaught rejection.
     */
    onRotIconClicked(group) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.onRotIconClicked(group);
    }

    /**
     * @override
     *
     * B79 / VAL-DIS-029: the progress-bar segments are plain
     * `<div role="progressbar">`s (`column_progress.xml`), not
     * `<button>`s; the base template only adds `pe-none` to their
     * wrapper offline, which blocks a pointer hit but not a direct call
     * to this handler. `onBarClicked` -> `ProgressBarState.selectBar` ->
     * `group.applyFilter()` is a genuine `list.load()` round trip, the
     * same "block the handler, don't let a `ConnectionLostError` surface"
     * rule as `onRotIconClicked` above.
     */
    onBarClicked(value) {
        if (this.crmOffline.isOffline()) {
            return;
        }
        return super.onBarClicked(value);
    }
}

export class CrmKanbanRenderer extends RottingKanbanRenderer {
    static components = {
        ...RottingKanbanRenderer.components,
        KanbanHeader: CrmKanbanHeader,
    };

    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    /**
     * @override
     *
     * B56 / VAL-DIS-015: the "Add a column" quick-create's `createGroup()`
     * (`relational_model/dynamic_group_list.js`) calls `crm.stage.name_create`
     * and then uses the *id that call returns* to resequence and configure
     * the new column -- an id produced by the call itself, so it can never
     * be queued verbatim (architecture.md §3.7's chained-id rule). Hide the
     * whole "Add a column" area instead of adding a queue hook for it.
     * Reading `isOffline()` here (a reactive signal) during render means an
     * area already unfolded before going offline disappears too, instead
     * of staying open and able to be submitted.
     */
    canCreateGroup() {
        return !this.crmOffline.isOffline() && super.canCreateGroup();
    }

    /**
     * @override
     *
     * B58/B71/B73 / VAL-DIS-015/016: dropping a dragged stage or other
     * group-by column calls the shared `resequence()` util, which issues
     * `orm.webResequence` -- not one of the framework's four auto-queued
     * producers (architecture.md §3.7). Block the drag from starting at
     * all instead of adding a queue hook for it; `useSortable`'s `enable`
     * callback (`core/utils/draggable_hook_builder.js`) is re-evaluated on
     * every drag attempt, so this also covers a drag attempted right after
     * going offline. Not gated on which field the view is grouped by: the
     * base getter already covers every group-by, stage or not.
     */
    get canResequenceGroups() {
        return !this.crmOffline.isOffline() && super.canResequenceGroups;
    }
}
