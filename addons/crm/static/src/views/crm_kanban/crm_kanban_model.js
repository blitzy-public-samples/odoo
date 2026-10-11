import { toRaw } from "@odoo/owl";
import { isOfflineModel } from "@crm/mobile/crm_offline_hooks";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { RelationalModel } from "@web/model/relational_model/relational_model";

export class CrmKanbanModel extends RelationalModel {
    setup(params, { effect }) {
        super.setup(...arguments);
        this.effect = effect;
    }
}

/**
 * Record of the CRM kanban models (pipeline, mobile pipeline and forecast).
 *
 * A `crm.lead` record exposes `serverStageId`: the stage id (or `false`) the record had in the
 * server or cache data it was last built from, i.e. the stage the loaded group aggregates (count,
 * expected revenue) count it in. `_setData` runs when the record is built (constructor), when it
 * is reloaded and after an online save, but not after an offline save, which commits its changes
 * locally through `_offlineSave` → `_commitSave`. So after an offline stage move `data.stage_id`
 * is the new stage while `serverStageId` is still the loaded one, and it follows the server again
 * on the next online save or reload. The framework keeps no other trace of that stage: the
 * offline commit overwrites `_values`, and coalesced offline saves of one record overwrite the
 * queued `extras.originalValues` with the intermediate stage.
 *
 * Read only by the mobile pipeline (`@crm/mobile/crm_mobile_pipeline/crm_mobile_pipeline`) to
 * derive pending stage placement and pending-aware totals; desktop never reads it, so desktop
 * behaviour is unchanged.
 *
 * It is captured on every screen size, because a record loaded on a large screen must carry it
 * if the small-screen pipeline is shown later without a reload. It is read and written on the raw
 * record (`toRaw`), so building a record creates no reactive proxy and notifies nothing. Its
 * readers still see every new value: `_setData` reassigns `data` through the reactive record in
 * the same synchronous call, and the pipeline reads `data.stage_id` together with it.
 */
export class CrmKanbanRecord extends RelationalModel.Record {
    /**
     * @override
     */
    _setData(data, options) {
        super._setData(...arguments);
        const raw = toRaw(this);
        // The model builds every record from this class, including group records (e.g.
        // `crm.stage`) and x2many records: only leads carry a stage to track.
        if (raw.resModel === "crm.lead") {
            raw.serverStageId = raw._values.stage_id?.id ?? false;
        }
    }
}

/** Number of group lists whose synchronous folded-record selection is in progress. */
let foldedSelections = 0;

export class CrmKanbanDynamicGroupList extends RelationalModel.DynamicGroupList {
    /**
     * @override
     *
     * The base getter lists the records of unfolded groups only. While `_withFoldedRecords` is
     * set on the raw datapoint (only during the synchronous selection of the records to move, see
     * `moveRecords` and `_moveRecords`), it also lists the records a folded group holds in memory,
     * such as a card just moved into the folded won stage while offline, so that card stays
     * movable without loading or unfolding its group. The flag lives on the raw object (`toRaw`):
     * toggling it notifies no observer. Outside a move's selection (`foldedSelections` is 0), the
     * getter returns the base result at once, without touching the datapoint.
     */
    get records() {
        if (foldedSelections > 0 && toRaw(this)._withFoldedRecords) {
            return this.groups.flatMap((group) => group.records);
        }
        return super.records;
    }

    /**
     * @override
     *
     * If the kanban view is grouped by stage_id check if the lead is won and display
     * a rainbowman message if that's the case.
     *
     * Offline, the lookup is skipped: the rainbowman is a visual effect only (a SKIP entry of the
     * offline inventory), and the move itself is already queued by the framework. Offline is read
     * once the move has returned, because a move whose save loses the connection queues the save
     * and switches the client offline on that response.
     */
    async moveRecords(recordIds, refId, targetGroupId) {
        const targetGroup = this.groups.find((group) => group.id === targetGroupId);
        // the leads that change stage, i.e. the ones not already in the target group, including
        // the ones held by a folded group (see `records`)
        let movedLeads;
        toRaw(this)._withFoldedRecords = true;
        foldedSelections++;
        try {
            movedLeads = this.records.filter(
                (r) => recordIds.includes(r.id) && r.group !== targetGroup
            );
        } finally {
            foldedSelections--;
            toRaw(this)._withFoldedRecords = false;
        }

        await super.moveRecords(...arguments);

        if (
            targetGroup &&
            movedLeads.length &&
            this.groupByField.name === "stage_id" &&
            !isOfflineModel(this.model)
        ) {
            // a single message, even when several leads were moved at once
            await checkRainbowmanMessage(this.model.orm, this.model.effect, movedLeads[0].resId);
        }
    }

    /**
     * @override
     *
     * The base method selects the records to move from `this.records` synchronously, before its
     * first `await`. The flag covers exactly that selection, so records held by a folded group can
     * be moved out of it; the group's `isFolded` and config are never touched, because they are
     * sent with the next `web_read_group` and changing them would change the cached request.
     * Deliberately not `async`: the base promise is returned as is, so callers await it and its
     * rejections propagate.
     */
    _moveRecords(...args) {
        toRaw(this)._withFoldedRecords = true;
        foldedSelections++;
        try {
            return super._moveRecords(...args);
        } finally {
            foldedSelections--;
            toRaw(this)._withFoldedRecords = false;
        }
    }
}

CrmKanbanModel.Record = CrmKanbanRecord;
CrmKanbanModel.DynamicGroupList = CrmKanbanDynamicGroupList;
CrmKanbanModel.services = [...RelationalModel.services, "effect"];
