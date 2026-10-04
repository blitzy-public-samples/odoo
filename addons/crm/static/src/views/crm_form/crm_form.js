import { effect, onMounted, onPatched, onWillDestroy } from "@odoo/owl";
import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";
import { registry } from "@web/core/registry";
import { getScheduleORMExtras } from "@web/model/relational_model/utils";
import { formView } from "@web/views/form/form_view";

// B8/B11 (offline_inventory.md): the AI-probability switch exists twice in
// the lead form arch (desktop and touch layouts), both as a plain `<a>`.
const AI_SWITCH_SELECTOR = "a[name='action_set_automated_probability']";

// m3-activity-panel (VAL-DATA-008): the Won button itself.
const WON_BUTTON_SELECTOR = "button[name='action_set_won_rainbowman']";

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
            // VAL-DATA-008: the button carries a static
            // `data-available-offline` in the arch (so it stays clickable
            // offline on an *already-synced* lead -- the normal Won
            // case), which also keeps `OfflinePlugin.SELECTORS_TO_DISABLE`
            // from ever touching it. A lead created offline has no server
            // id yet (`record.resId` stays falsy until the queued create
            // syncs, `record.js`'s `_offlineSave`), and `action_set_won`
            // has nothing to replay against in that case
            // (`beforeExecuteActionButton` below already blocks queuing
            // it); this reflects that in the DOM too, same technique as
            // the AI-switch above, so the control reads as actually
            // disabled rather than silently inert.
            //
            // m5-fix-online-guards (VAL-REPO-013 clause (b)): this runs on
            // every patch *and* on every `isOffline()` change, online
            // included, so it must never unconditionally assign
            // `el.disabled`: web's `executeButtonCallback`
            // (addons/web/static/src/views/view_button/view_button_hook.js)
            // disables every enabled button in the view while this same
            // button's own action (action_set_won_rainbowman) is in flight,
            // to close a double-submit window, and only re-enables them
            // once it settles. Overwriting `disabled` here regardless would
            // clear that in-flight disable on any stray run during the
            // action (a patch, or a connectivity blip) and reopen the
            // window. The `crmDisabledOffline` dataset flag records that
            // *this* code set the disable, so it only ever clears a
            // disable it put there itself.
            const resId = this.model.root.resId;
            for (const el of rootEl.querySelectorAll(WON_BUTTON_SELECTOR)) {
                if (offline && !resId) {
                    el.disabled = true;
                    el.dataset.crmDisabledOffline = "1";
                } else if (el.dataset.crmDisabledOffline) {
                    el.disabled = false;
                    delete el.dataset.crmDisabledOffline;
                }
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
     * B1/C6 (architecture.md §3.3, offline_inventory.md rows B1/C6,
     * VAL-DATA-005): the "Won" button is `type="object"` and bound to
     * `action_set_won_rainbowman`, which itself runs a heavy SQL read
     * (`get_rainbowman_message`) and returns an effect action needing a
     * live round trip (C8, DISABLE as a method). The approved offline
     * producer bypasses that wrapper and queues the plain `action_set_won`
     * (C6, QUEUE) directly, exactly like Restore bypasses nothing but
     * queues its own bare `[[id]]` call -- same reasoning as the Restore
     * doc below, same guard-before-`super()` requirement.
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
            if (
                clickParams.type === "object" &&
                clickParams.name === "action_set_won_rainbowman"
            ) {
                if (!this.model.root.resId) {
                    // VAL-DATA-008: a lead created offline has no server
                    // id yet; `action_set_won([[id]])` has nothing to
                    // replay against, so block before even attempting
                    // `record.save()` -- nothing is queued for this
                    // click at all, not even the record's own pending
                    // create (which is already queued separately, from
                    // whichever save created it).
                    return false;
                }
                // Same save-first reasoning as Restore just below: a dirty
                // edit made before clicking Won must not be lost, and an
                // invalid form must queue nothing, not even Won.
                const saved = await this.model.root.save();
                if (!saved) {
                    return false;
                }
                this._queueWonOffline();
                return false; // skip the real action_set_won_rainbowman RPC: no rainbowman lookup offline
            }
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

    /**
     * Shared plumbing for every bare `crm.lead` `[[id]]` call this
     * controller queues itself offline (Restore, Won): queues `method`
     * through `useCrmOffline()`, breaking a `Date.now()` tie against this
     * record's own pending offline save first.
     *
     * Scrutiny finding (VAL-QUEUE-005): `record.save()` in
     * `beforeExecuteActionButton` just before this call may have queued a
     * `web_save` for this very lead, stamped with `Date.now()` at the
     * moment it was queued (`record.js` `_offlineSave`'s
     * `_offlineTimeStamp`). This call's own `getScheduleORMExtras` below
     * stamps its own `Date.now()` independently, and `_syncORM` orders
     * replay by `extras.timeStamp` alone (`offline_plugin.js`) after
     * reloading entries from IndexedDB in hash-key order, not insertion
     * order -- so an equal millisecond timestamp is a real tie, not just a
     * same-array ordering coincidence, and could let this call replay
     * before the save it depends on. Read the pending save's actual
     * queued timestamp back from the queue (`record.offlineId` is the
     * public key `_offlineSave` scheduled it under) and force this
     * timestamp strictly after it when they'd otherwise tie, without
     * touching `_syncORM`'s own sort (framework replay semantics
     * unchanged).
     */
    _queueLeadCallOffline(method) {
        const record = this.model.root;
        const extras = getScheduleORMExtras(this.model, [record]);
        const pendingSaveKey = record.offlineId;
        const pendingSave = pendingSaveKey
            ? this.model.offlinePlugin._ormToSync()[pendingSaveKey]
            : undefined;
        if (pendingSave) {
            extras.timeStamp = Math.max(extras.timeStamp, pendingSave.value.extras.timeStamp + 1);
        }
        this.crmOffline.queueCall(
            "crm.lead",
            method,
            [[record.resId]],
            { context: record.context },
            extras
        );
    }

    _queueRestoreOffline() {
        this._queueLeadCallOffline("action_restore");
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
        const record = this.model.root;
        record.data.active = true;
        record.data.won_status = "pending";
        record._setEvalContext();
    }

    /**
     * B1/C6 (architecture.md §3.3, VAL-DATA-005): queues `action_set_won`
     * (not the rainbowman-wrapped `action_set_won_rainbowman` the button
     * itself names -- no rainbow-man lookup offline, SKIP already covers
     * the rainbowman call) and shows the won state immediately.
     */
    _queueWonOffline() {
        this._queueLeadCallOffline("action_set_won");
        // Optimistic UI, same reasoning and the same `record.data`-only
        // technique as `_queueRestoreOffline` above: `action_set_won`
        // moves the lead to a won stage and sets probability to 100
        // server-side (models/crm_lead.py), but which stage is only known
        // server-side, so only `won_status` -- what the ribbon's own
        // `invisible="won_status != 'won'"` actually reads -- is mirrored
        // locally. Not written into `record._changes` for the same reason
        // as Restore: `won_status` is compute+store with no inverse, so a
        // later `web_save` that happened to include it would be rejected.
        const record = this.model.root;
        record.data.won_status = "won";
        record._setEvalContext();
    }
}

registry.category("views").add("crm_form", {
    ...formView,
    Model: CrmFormModel,
    Controller: CrmFormController,
});
