import { Component, t, useProps } from "@odoo/owl";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * VAL-MOBILE-010 (architecture.md §3.4): the visual counterpart of a
 * queued lead create, rendered by `CrmKanbanRenderer`'s mobile-pipeline
 * branch. A queued create has no id yet (the producer's own `args[0] = []`
 * shape), so this is a plain presentational card over the queued vals
 * rather than `CrmMobileCard` (whose `isPendingSync` logic needs a real
 * `resId`) -- never clickable, since there is no record to open until the
 * create replays.
 *
 * orchestrator-triage.md blocker 6 (VAL-MOBILE-002/014): own directory,
 * files named after it, and -- unlike taking the display name as a `name`
 * prop threaded through the renderer -- reads its own queued entry from
 * the shared hooks module by `entryKey`, the same key the renderer's own
 * `t-foreach` already keys the DOM on, so there is exactly one place
 * (`useCrmOffline().pendingLeadCreates`) that ever reads the queue for
 * this content.
 */
export class CrmMobilePendingLeadCreate extends Component {
    static template = "crm.CrmMobilePendingLeadCreate";
    props = useProps({
        entryKey: t.string(),
    });

    setup() {
        this.crmOffline = useCrmOffline();
    }

    get name() {
        const entry = this.crmOffline
            .pendingLeadCreates()
            .find((e) => e.key === this.props.entryKey);
        return entry?.value.args[1]?.name ?? "";
    }
}
