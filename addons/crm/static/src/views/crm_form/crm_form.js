import { effect, onMounted, onPatched, onWillDestroy } from "@odoo/owl";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";
import { registry } from "@web/core/registry";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { formView } from "@web/views/form/form_view";

// B8/B11 (offline_inventory.md): the AI-probability switch exists twice in
// the lead form arch (desktop and touch layouts), both as a plain `<a>`.
const AI_SWITCH_SELECTOR = "a[name='action_set_automated_probability']";

// B1/C6 (offline_inventory.md): the `stage_id` statusbar's inline and
// dropdown buttons, see the comment at its usage below.
const STATUSBAR_BUTTON_SELECTOR = ".o_statusbar_status button";

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

        // B8/B11/C7 (architecture.md §3.7, offline_inventory.md rows
        // B8/B11/C7, VAL-DIS-002): the AI-probability switch is a plain
        // `<a>`, so `OfflinePlugin.SELECTORS_TO_DISABLE` (which only
        // matches `<button>`) never disables it. `beforeExecuteActionButton`
        // below already blocks the method call; this effect only gives the
        // control its visual offline-disabled state. `effect()` re-runs
        // whenever `isOffline()` changes, independently of whether anything
        // else causes this controller to re-render; `onPatched` additionally
        // reapplies the class after every render of this form (e.g. after a
        // save replaces the `<a>` node while already offline), since a
        // patch caused by an unrelated reactive read would not otherwise
        // retrigger the effect.
        const syncAiSwitchOfflineState = () => {
            const rootEl = this.rootRef();
            if (!rootEl) {
                return;
            }
            const offline = this.crmOffline.isOffline();
            for (const el of rootEl.querySelectorAll(AI_SWITCH_SELECTOR)) {
                el.classList.toggle("o_disabled_offline", offline);
            }
        };
        let disposeAiSwitchEffect = () => {};
        onMounted(() => {
            disposeAiSwitchEffect = effect(syncAiSwitchOfflineState);
        });
        onPatched(syncAiSwitchOfflineState);
        onWillDestroy(() => disposeAiSwitchEffect());

        // B1/C6 (architecture.md §3.2/§3.3, VAL-FIX-001): the stage
        // statusbar's own buttons -- `web.StatusBarField`'s inline
        // `<button t-att-data-value="...">` items and its before/after/
        // collapsed dropdown togglers, inherited unchanged by
        // `rotting_statusbar_duration` -- are plain `<button>`s with no
        // `data-available-offline`. Left alone,
        // `OfflinePlugin.SELECTORS_TO_DISABLE` disables every one of them
        // on going offline, so a click never runs its handler, the record
        // never becomes dirty, and the Save button never appears: stage
        // moves via the statusbar (desktop inline buttons, mobile dropdown
        // toggle) would silently stop working offline even though the
        // underlying `web_save` is already queueable. Tag them
        // unconditionally, online and offline alike: the framework only
        // checks the attribute's presence (both on its initial disable
        // pass and reactively, via its own `MutationObserver` on this same
        // attribute), so marking them ahead of time is what keeps the
        // buttons out of its disable pass entirely rather than racing it.
        const markStatusbarButtonsAvailableOffline = () => {
            const rootEl = this.rootRef();
            if (!rootEl || this.model.root.resModel !== "crm.lead") {
                return;
            }
            for (const el of rootEl.querySelectorAll(STATUSBAR_BUTTON_SELECTOR)) {
                if (!el.hasAttribute("data-available-offline")) {
                    el.setAttribute("data-available-offline", "");
                }
            }
        };
        onMounted(markStatusbarButtonsAvailableOffline);
        onPatched(markStatusbarButtonsAvailableOffline);
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
     * B8/B11/C7 (offline_inventory.md rows B8/B11/C7, VAL-DIS-002): the
     * AI-probability switch, reclassified to DISABLE by the milestone-2
     * user review -- predictive scoring is out of scope and the
     * probability only recomputes on the server, so unlike Restore/Won
     * there is no optimistic UI to apply, just a plain block. The check
     * must run (and return `false`) *before* `super()`: the base
     * `beforeExecuteActionButton` unconditionally calls `record.save()`
     * first for any non-"cancel" button, so returning late would still
     * save (and offline, queue) the record as an unwanted side effect of
     * a button that itself does nothing offline.
     *
     * @override
     */
    async beforeExecuteActionButton(clickParams) {
        if (this.crmOffline.isOffline() && this.model.root.resModel === "crm.lead") {
            if (clickParams.type === "object" && clickParams.name === "action_restore") {
                // Scrutiny finding 11 (VAL-QUEUE-005): online, the base
                // `beforeExecuteActionButton` saves the record before
                // every non-"cancel" button runs, so a dirty edit made
                // before clicking Restore is never lost. The offline
                // path must do the same -- `record.save()` resolves
                // `false` without touching the network when the form is
                // invalid (`Record._save`'s `_checkValidity` guard), so
                // nothing is queued at all in that case (not even
                // Restore); it resolves `true` without touching the
                // network when the form is clean, so only
                // `action_restore` ends up queued, exactly as before.
                // When the form is dirty and valid, `record.save()`
                // itself queues `web_save` (via `CrmFormRecord._save`
                // above) with an earlier `extras.timeStamp` than the
                // `action_restore` queued right after it, so the two
                // replay in save-then-restore order on reconnect.
                const saved = await this.model.root.save();
                if (!saved) {
                    return false; // invalid form: queue nothing, not even Restore
                }
                this._queueRestoreOffline();
                return false; // skip the real action_restore RPC
            }
            if (
                clickParams.type === "object" &&
                clickParams.name === "action_set_automated_probability"
            ) {
                return false; // no optimistic UI possible; just block, no save
            }
        }
        return super.beforeExecuteActionButton(clickParams);
    }

    _queueRestoreOffline() {
        const record = this.model.root;
        const extras = getScheduleORMExtras(this.model, [record]);
        // Scrutiny finding (VAL-QUEUE-005): `record.save()` just above may
        // have queued a `web_save` for this very lead, stamped with
        // `Date.now()` at the moment it was queued
        // (`record.js` `_offlineSave`'s `_offlineTimeStamp`). This call's
        // own `getScheduleORMExtras` above stamps its own `Date.now()`
        // independently, and `_syncORM` orders replay by `extras.timeStamp`
        // alone (`offline_plugin.js`) after reloading entries from
        // IndexedDB in hash-key order, not insertion order -- so an equal
        // millisecond timestamp is a real tie, not just a same-array
        // ordering coincidence, and could let Restore replay before the
        // save it depends on. Read the pending save's actual queued
        // timestamp back from the queue (`record.offlineId` is the public
        // key `_offlineSave` scheduled it under) and force this timestamp
        // strictly after it when they'd otherwise tie, without touching
        // `_syncORM`'s own sort (framework replay semantics unchanged).
        const pendingSaveKey = record.offlineId;
        const pendingSave = pendingSaveKey
            ? this.model.offlinePlugin._ormToSync()[pendingSaveKey]
            : undefined;
        if (pendingSave) {
            extras.timeStamp = Math.max(extras.timeStamp, pendingSave.value.extras.timeStamp + 1);
        }
        this.crmOffline.queueCall(
            "crm.lead",
            "action_restore",
            [[record.resId]],
            { context: record.context },
            extras
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
