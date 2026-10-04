import { Component, signal, t, useProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { ConnectionLostError } from "@web/core/network/rpc";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * VAL-MOBILE-009..011 (architecture.md §3.4): the mobile pipeline's quick
 * create, opened as a bottom sheet (`usePopover(CrmMobileQuickCreate, {
 * useBottomSheet: true })`, from `CrmMobilePipeline`'s "+" control --
 * `crm_kanban_renderer.js` owns the popover). Exactly six fixed field
 * controls (no dynamic quick-create arch, no onchange, no relational-model
 * `Record`), so saving never issues anything beyond the one `web_save`
 * call this component makes itself: it mirrors `record.js`'s own
 * online-then-offline-fallback shape (`_save` tries `orm.webSave`, catches
 * `ConnectionLostError`, falls back to queuing) instead of adding a new
 * offline path -- the same producer, just without a `Record` object
 * backing it, because the sheet's fixed six fields need neither the
 * dynamic quick-create view (`web.KanbanRecordQuickCreate`) nor its
 * onchange support.
 *
 * `stages`/`defaultStageId`/`context` all come from the mobile pipeline's
 * own, already-loaded group data (`CrmKanbanRenderer.mobilePipelineGroups`
 * /`.mobilePipelineGroup.context` -- the exact `group.context` desktop's
 * own kanban quick create uses, VAL-MOBILE-010): picking a stage here is a
 * plain `<select>` over data this device already has, online or offline,
 * never a `Many2One` autocomplete (which would need a fresh
 * `web_name_search`).
 */
export class CrmMobileQuickCreate extends Component {
    static template = "crm.CrmMobileQuickCreate";
    props = useProps({
        close: t.function(),
        resModel: t.string(),
        context: t.object(),
        stages: t.array(t.object()),
        defaultStageId: t.number().optional(),
        // orchestrator-triage.md blocker 1 (VAL-MOBILE-001): `actionId`/
        // `actionName`/`viewType`, built by `CrmKanbanRenderer` from its own
        // `env.config` -- the same three fields `getScheduleORMExtras`
        // (relational_model/utils.js) puts on every *other* producer's
        // queued extras. Without them the offline systray's `groupEntries`
        // computed throws on this entry the moment its dropdown opens
        // (`offline_systray.js` dereferences `extras.changes`, below, for
        // every `web_save`; `isClickable` also reads `extras.viewType`).
        queueExtras: t.object(),
        onCreated: t.function().optional(),
    });

    name = signal("");
    contactName = signal("");
    phone = signal("");
    email = signal("");
    expectedRevenue = signal("");
    stageId = signal(/** @type {number|false} */ (false));
    isSaving = signal(false);

    setup() {
        this.orm = useService("orm");
        this.crmOffline = useCrmOffline();
        this.stageId.set(this.props.defaultStageId ?? this.props.stages[0]?.id ?? false);
    }

    get canSave() {
        return Boolean(this.name().trim()) && !this.isSaving();
    }

    /**
     * VAL-MOBILE-010/011: exactly one `crm.lead` `web_save` either way.
     * Online it goes straight to the server through `orm.webSave` (the
     * same convenience wrapper `record.js`'s own save path calls:
     * `addons/web/static/src/core/orm_plugin.js`'s `webSave` is just
     * `call(model, "web_save", [ids, data], kwargs)`). Offline, that same
     * call's underlying RPC rejects with `ConnectionLostError` (mocked in
     * tests, real under an actual lost connection) -- caught here exactly
     * like `record.js`'s `_save` catches it for its own `_offlineSave`
     * fallback, and queued verbatim through the shared hooks module
     * (`queueCall`) instead of a second queue. No onchange, no
     * `name_create`: the vals are built straight from this component's own
     * six signals, nothing else is ever called.
     */
    async onSave() {
        if (!this.canSave) {
            return;
        }
        const vals = {
            name: this.name().trim(),
            contact_name: this.contactName().trim() || false,
            phone: this.phone().trim() || false,
            email_from: this.email().trim() || false,
            expected_revenue: Number(this.expectedRevenue()) || 0,
            stage_id: this.stageId(),
        };
        const kwargs = { context: this.props.context, specification: {} };
        this.isSaving.set(true);
        try {
            let leadId = null;
            try {
                const [record] = await this.orm.webSave(this.props.resModel, [], vals, kwargs);
                leadId = record.id;
            } catch (e) {
                if (!(e instanceof ConnectionLostError)) {
                    throw e;
                }
                // orchestrator-triage.md blocker 1: the extras shape
                // `record.js`'s own `_offlineSave` builds for every other
                // offline create -- `changes` (many2one as `{id,
                // display_name}`, the systray tooltip's own
                // `v?.display_name ?? v` read) and `originalValues: {}`
                // (there is no "before" for a create) -- plus the
                // `queueExtras` the renderer supplies above.
                const stage = this.props.stages.find((s) => s.id === vals.stage_id);
                this.crmOffline.queueCall(this.props.resModel, "web_save", [[], vals], kwargs, {
                    ...this.props.queueExtras,
                    displayName: vals.name,
                    changes: {
                        ...vals,
                        stage_id: stage ? { id: stage.id, display_name: stage.displayName } : false,
                    },
                    originalValues: {},
                });
            }
            this.props.onCreated?.({ leadId, stageId: vals.stage_id });
            this.props.close();
        } finally {
            this.isSaving.set(false);
        }
    }

    onCancel() {
        this.props.close();
    }
}
