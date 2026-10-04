import { Component, t, useProps } from "@odoo/owl";
import { AnimatedNumber } from "@web/views/view_components/animated_number";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * VAL-MOBILE-003 / architecture.md §3.4: the fixed header
 * `CrmKanbanRenderer`'s small-screen branch delegates to for whichever one
 * stage it currently shows -- stage name, lead count, the server-computed
 * `expected_revenue` group total, and the prev/next controls. Mostly
 * presentational: `CrmKanbanRenderer` owns which stage is "current" and
 * whether to step to another one (`group`/`hasPrev`/`hasNext`/`onPrev`/
 * `onNext` are all it needs for that, and it is the one that decides the
 * `isFolded`/`group.toggle()` branch VAL-MOBILE-006 needs). This
 * component does read the shared hooks module itself, though
 * (VAL-MOBILE-002, architecture.md §3.1), for the one piece of offline
 * state the header shows that isn't already in its props: how many of
 * this stage's leads are still only a queued, unsynced `web_save` (the
 * `pendingCreateCount` badge below) -- the same `pendingLeadCreates`
 * `CrmKanbanRenderer.mobilePipelinePendingLeadCreatesFor` uses to render
 * the per-lead pending cards underneath, so a user who has scrolled past
 * those still sees, in the sticky header, that this stage has leads not
 * yet on the server.
 *
 * The revenue total reuses `ProgressBarState.getGroupInfo`/
 * `getAggregateValue` -- exactly what desktop's `KanbanHeader.
 * groupAggregate` getter calls -- instead of summing `group.list.records`
 * itself: the pipeline arch's `<progressbar sum_field="expected_revenue"
 * .../>` already asked the server for that number in the same
 * `web_read_group` the whole column list came from, for every stage,
 * folded or not (only each stage's *records* differ by fold state, not
 * its count/aggregates -- see `_mobilePipelineGoTo`'s doc in
 * crm_kanban_renderer.js), so re-deriving it from loaded cards would both
 * duplicate the framework's own currency handling and read `0` for a
 * folded stage never unfolded this session.
 */
export class CrmMobilePipeline extends Component {
    static template = "crm.CrmMobilePipeline";
    static components = { AnimatedNumber };
    props = useProps({
        group: t.object(),
        hasPrev: t.boolean(),
        hasNext: t.boolean(),
        onPrev: t.function(),
        onNext: t.function(),
        progressBarState: t.any().optional(),
        // VAL-MOBILE-009 (architecture.md §3.4): the mobile pipeline's own
        // quick-create control -- `CrmKanbanRenderer` owns the actual
        // `usePopover(..., { useBottomSheet: true })` state (same split
        // as `onPrev`/`onNext`: this component stays purely
        // presentational, see the module doc above), this prop is just
        // the click handler it opens through, given the triggering
        // button so the popover can anchor/scope to it.
        onQuickCreate: t.function(),
    });

    setup() {
        // VAL-MOBILE-002: reads the framework through the shared hooks
        // module, never `usePlugin(OfflinePlugin)` directly.
        this.crmOffline = useCrmOffline();
    }

    /**
     * VAL-MOBILE-002/010: how many of this stage's leads exist only as a
     * queued `crm.lead` `web_save([], vals)` create, not yet replayed --
     * `0` (falsy) hides the header badge, matching `groupAggregate`'s own
     * `null` guard just below. `group.value` is the real `crm.stage` id
     * (`relational_model/utils.js`'s `getValueFromGroupData`), the same
     * one `CrmKanbanRenderer.mobilePipelinePendingLeadCreatesFor` and the
     * quick-create sheet's own `stage_id` compare against.
     */
    get pendingCreateCount() {
        return this.crmOffline.pendingLeadCreates(this.props.group.value).length;
    }

    /**
     * `{title, value}` or `{value, currencies}`/`{title, value,
     * currencies}` (`ProgressBarState.getAggregateValue`'s own shapes,
     * see progress_bar_hook.js) for `AnimatedNumber`.
     *
     * orchestrator-triage.md blocker 3 (VAL-MOBILE-003): `isReady` is
     * false whenever `_pbCounts` is null (progress_bar_hook.js's own
     * `getGroupInfo`), which is not only "a frame right after mount" --
     * `loadProgressBar` sets it back to null on a `ConnectionLostError`
     * too (e.g. an offline remount/reload), and it then stays null for
     * every group until the next successful `read_progress_bar`. The
     * stage's own `expected_revenue` total came from the one
     * `web_read_group` that loaded the board though (disk-cached,
     * architecture.md §2), already sitting in `group.aggregates` --
     * `_cachedAggregateValue` reads it directly in that same not-ready
     * case, instead of leaving the header blank.
     */
    get groupAggregate() {
        const { progressBarState, group } = this.props;
        if (!progressBarState) {
            return null;
        }
        const { sumField } = progressBarState.progressAttributes;
        if (!sumField) {
            return null;
        }
        // Warms `ProgressBarState`'s own `_aggregateValues`/`_groupsInfo`
        // cache for this group first, exactly like `KanbanHeader.
        // progressBar`'s getter does for the desktop header -- skipping
        // this call is what would make `getAggregateValue` below throw on
        // a stage this component is the first thing to ever render (e.g.
        // the pipeline's very first stage, which the base `getGroupClasses`
        // only warms for *unfolded* groups).
        const info = progressBarState.getGroupInfo(group);
        if (!info.isReady) {
            return this._cachedAggregateValue(group, sumField);
        }
        return progressBarState.getAggregateValue(group, sumField);
    }

    /**
     * The same `{title, value}`/`{value, currencies}` shape
     * `ProgressBarState.getAggregateValue` builds (progress_bar_hook.js),
     * read straight from `group.aggregates` instead of through that
     * method's own `activeBars`/`_aggregateValues` bookkeeping, which
     * `getGroupInfo` never populates while `isReady` is false.
     */
    _cachedAggregateValue(group, sumField) {
        const title = sumField.string;
        const value = group.aggregates?.[sumField.name] || 0;
        if (sumField.type === "monetary" && sumField.currency_field) {
            const currencies = group.aggregates?.[sumField.currency_field];
            if (currencies?.length > 1) {
                return { value, currencies };
            }
            if (currencies?.[0]) {
                return { title, value, currencies: [currencies[0]] };
            }
        }
        return { title, value };
    }
}
