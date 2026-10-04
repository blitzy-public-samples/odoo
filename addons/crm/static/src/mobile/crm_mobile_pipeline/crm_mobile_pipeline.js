import { Component, t, useProps } from "@odoo/owl";
import { AnimatedNumber } from "@web/views/view_components/animated_number";

/**
 * VAL-MOBILE-003 / architecture.md §3.4: the fixed header
 * `CrmKanbanRenderer`'s small-screen branch delegates to for whichever one
 * stage it currently shows -- stage name, lead count, the server-computed
 * `expected_revenue` group total, and the prev/next controls. Purely
 * presentational: `CrmKanbanRenderer` owns which stage is "current" and
 * whether to step to another one (`group`/`hasPrev`/`hasNext`/`onPrev`/
 * `onNext` are all it needs), so this component never touches the offline
 * hooks module itself (that lives on the renderer, next to the `isFolded`/
 * `group.toggle()` decision VAL-MOBILE-006 needs).
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
    });

    /**
     * `{title, value}` or `{value, currencies}`/`{title, value,
     * currencies}` (`ProgressBarState.getAggregateValue`'s own shapes,
     * see progress_bar_hook.js) for `AnimatedNumber`, or `null` before the
     * progress bar's own `loadProgressBar` resolves (`isReady` false --
     * only possible for a frame right after mount, never once the
     * surrounding kanban controller's `onWillLoadRoot` has settled).
     */
    get groupAggregate() {
        const { progressBarState, group } = this.props;
        if (!progressBarState) {
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
            return null;
        }
        const { sumField } = progressBarState.progressAttributes;
        return progressBarState.getAggregateValue(group, sumField);
    }
}
