import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";
import { registry } from "@web/core/registry";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { formView } from "@web/views/form/form_view";

class CrmFormRecord extends formView.Model.Record {
     /**
     * override of record _save mechanism intended to affect the main form record
     * We check if the stage_id field was altered and if we need to display a rainbowman
     * message.
     *
     * This method will also simulate a real "force_save" on the email and phone
     * when needed. The "force_save" attribute only works on readonly field. For our
     * use case, we need to write the email and the phone even if the user didn't
     * change them, to synchronize those values with the partner (so the email / phone
     * inverse method can be called).
     *
     * We base this synchronization on the value of "partner_phone_update"
     * and "partner_email_update", which are computed fields that hold a value
     * whenever we need to synch.
     *
     * @override
     */
    async _save() {
        if (this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        let changeStage = false;
        const needsSynchronizationEmail =
            this._changes.partner_email_update === undefined
                ? this._values.partner_email_update // original value
                : this._changes.partner_email_update; // new value

        const needsSynchronizationPhone =
            this._changes.partner_phone_update === undefined
                ? this._values.partner_phone_update // original value
                : this._changes.partner_phone_update; // new value

        if (needsSynchronizationEmail && this._changes.email_from === undefined && this._values.email_from) {
            this._changes.email_from = this._values.email_from;
        }
        if (needsSynchronizationPhone && this._changes.phone === undefined && this._values.phone) {
            this._changes.phone = this._values.phone;
        }

        if ("stage_id" in this._changes) {
            changeStage = this._values.stage_id !== this.data.stage_id;
        }

        const res = await super._save(...arguments);
        if (res && changeStage) {
            await checkRainbowmanMessage(
                this.model.orm,
                this.model.effect,
                this.resId,
                this.model.offlinePlugin
            );
        }
        return res;
    }
}

class CrmFormModel extends formView.Model {
    static Record = CrmFormRecord;
    static services = [...formView.Model.services, "effect"];

    setup(params, services) {
        super.setup(...arguments);
        this.effect = services.effect;
    }
}

class CrmFormController extends formView.Controller {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    }

    /**
     * B3/C4 (architecture.md §3.7, offline_inventory.md rows B3/C4,
     * VAL-QUEUE-005): the "Restore" button is `type="object"`, so without
     * this guard the base `FormController.beforeExecuteActionButton`
     * would still save (a no-op here) and then let `useViewButtons` call
     * `action.doActionButton(...)`, issuing a real `action_restore` RPC
     * that rejects offline with `ConnectionLostError` and is never queued
     * -- unlike `web_save`/`web_unlink`/`action_archive`/
     * `action_unarchive`, a bare `[[id]]` write like `action_restore` has
     * no framework producer, so crm must queue it itself.
     *
     * @override
     */
    async beforeExecuteActionButton(clickParams) {
        if (
            this.crmOffline.isOffline() &&
            this.model.root.resModel === "crm.lead" &&
            clickParams.type === "object" &&
            clickParams.name === "action_restore"
        ) {
            this._queueRestoreOffline();
            return false; // skip the real action_restore RPC
        }
        return super.beforeExecuteActionButton(clickParams);
    }

    _queueRestoreOffline() {
        const record = this.model.root;
        this.crmOffline.queueCall(
            "crm.lead",
            "action_restore",
            [[record.resId]],
            { context: record.context },
            getScheduleORMExtras(this.model, [record])
        );
        // Optimistic UI: mirror the server-side effect of `action_restore`
        // (action_unarchive + probability reset, see models/crm_lead.py)
        // directly on `record.data` so the Restore/Lost buttons' own
        // `invisible="won_status != ...` conditions flip immediately.
        // Deliberately not `record.update()`/`record._applyChanges()`:
        // both would also record these two fields in `record._changes`,
        // so they would be re-sent -- `won_status` is a compute+store
        // field with no inverse, so the server would reject a later
        // `web_save` that includes it. Mutating `record.data` directly
        // and refreshing `record.evalContext` by hand (`_setEvalContext`,
        // the same call `_applyChanges` itself makes) gets the same
        // visible effect with nothing queued for these two fields and no
        // onchange attempted (architecture.md §2: onchange is skipped
        // offline, never queued). `won_status` defaults to "pending", the
        // outcome in every case except the rare one where the automated
        // probability alone would already mark the lead won; that
        // discrepancy self-corrects once the queued call replays and the
        // view is reloaded.
        record.data.active = true;
        record.data.won_status = "pending";
        record._setEvalContext();
    }
}

registry.category("views").add("crm_form", {
    ...formView,
    Model: CrmFormModel,
    Controller: CrmFormController,
});
