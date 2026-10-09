import { checkRainbowmanMessage } from "@crm/views/check_rainbowman_message";
import { registry } from "@web/core/registry";
import { formView } from "@web/views/form/form_view";

import { isOfflineModel, useCrmOffline } from "@crm/mobile/crm_offline_hooks";
import { HtmlField } from "@html_editor/fields/html_field";
// Imported for its side effect, which must run before this module: it defines on
// `Chatter.prototype` the web chatter methods that the CRM chatter patch below wraps, so the CRM
// guards sit on top of them.
import "@mail/chatter/web/chatter_patch";
import { ScheduledMessage } from "@mail/chatter/web/scheduled_message";
import { Chatter } from "@mail/chatter/web_portal_project/chatter";
import { Composer } from "@mail/core/common/composer";
import { MessageAction } from "@mail/core/common/message_actions";
import { MessageDeleteDialog } from "@mail/core/common/message_delete_dialog";
import { MessageReactionList } from "@mail/core/common/message_reaction_list";
import { MessageReactionMenu } from "@mail/core/common/message_reaction_menu";
import { QuickReactionMenu } from "@mail/core/common/quick_reaction_menu";
import { Activity } from "@mail/core/web/activity";
import { ActivityAssignPopover } from "@mail/core/web/activity_assign_popover";
import { ActivityMailTemplate } from "@mail/core/web/activity_mail_template";
import { ActivityMarkAsDone } from "@mail/core/web/activity_markasdone_popover";
import { Follower } from "@mail/core/web/follower";
import { FollowerList } from "@mail/core/web/follower_list";
import { FollowerSubtypeDialog } from "@mail/core/web/follower_subtype_dialog";
import { computed, status, untrack, useEffect } from "@odoo/owl";
import { ConnectionLostError } from "@web/core/network/rpc";
import { patch } from "@web/core/utils/patch";

/**
 * Set while a lead chatter's record-save callback calls the form's save: the lead save that call
 * starts synchronously is the chatter's own (see `CrmFormRecord.save`).
 */
let chatterSaveInScope = false;

class CrmFormRecord extends formView.Model.Record {
    /**
     * Simulates a real "force_save" on the email and phone when needed. The "force_save"
     * attribute only works on readonly field. For our use case, we need to write the email and
     * the phone even if the user didn't change them, to synchronize those values with the
     * partner (so the email / phone inverse method can be called).
     *
     * We base this synchronization on the value of "partner_phone_update"
     * and "partner_email_update", which are computed fields that hold a value
     * whenever we need to synch.
     *
     * The copy only fills values that are not changed yet, so it is idempotent. It runs from
     * `_save` (online saves, and saves whose request loses the connection) and from
     * `_offlineSave` (saves queued offline), so the queued `web_save` carries the same email and
     * phone as the online one whatever path leads to the queue.
     */
    _applyPartnerSyncChanges() {
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
    }

    /**
     * Marks the lead save a lead chatter starts: the form controller calls this synchronously
     * from the chatter's record-save callback, and the mark travels in the options to `_save`.
     *
     * @override
     */
    save(options) {
        if (this.resModel === "crm.lead" && chatterSaveInScope) {
            chatterSaveInScope = false;
            return super.save({ ...options, crmChatterSave: true });
        }
        return super.save(...arguments);
    }

    /**
     * Saves a lead with its email and phone partner-sync copy (`_applyPartnerSyncChanges`) and,
     * when the stage changed, shows the rainbowman message.
     *
     * The rainbowman lookup is a visual effect: it is skipped when the client is offline once
     * the save returns. Checked after the save, this covers saves made offline and saves whose
     * request lost the connection, which the framework queues (`_offlineSave`) while switching
     * the client offline. The queued save is left untouched, and nothing is queued for the
     * lookup.
     *
     * While the request runs, `_crmChatterSave` tells `_offlineSave` whether a lead chatter
     * started this save (`options.crmChatterSave`, see `save`). It is restored afterwards, as an
     * error handler's retry re-enters `_save` with the same options.
     *
     * @override
     */
    async _save(options) {
        if (this.resModel !== "crm.lead") {
            return super._save(...arguments);
        }
        let changeStage = false;
        this._applyPartnerSyncChanges();

        if ("stage_id" in this._changes) {
            changeStage = this._values.stage_id !== this.data.stage_id;
        }

        const outerChatterSave = this._crmChatterSave;
        this._crmChatterSave = Boolean(options?.crmChatterSave);
        let res;
        try {
            res = await super._save(...arguments);
        } finally {
            this._crmChatterSave = outerChatterSave;
        }
        if (res && changeStage && !isOfflineModel(this.model)) {
            await checkRainbowmanMessage(this.model.orm, this.model.effect, this.resId);
        }
        return res;
    }

    /**
     * Queues a lead save with the email and phone partner-sync copy, whichever path reached the
     * offline queue (a save started offline, a save whose request lost the connection, or any
     * other caller of `_offlineSave`). A save a lead chatter started (see `save`) is refused
     * instead, as the chatter is read-only offline: it returns `false`, schedules nothing and
     * leaves the unsaved changes in the form.
     *
     * @override
     */
    _offlineSave() {
        if (this.resModel === "crm.lead") {
            if (this._crmChatterSave) {
                return false;
            }
            this._applyPartnerSyncChanges();
        }
        return super._offlineSave(...arguments);
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

registry.category("views").add("crm_form", {
    ...formView,
    Model: CrmFormModel,
});

// -----------------------------------------------------------------------------
// Lead chatter: read-only while offline
// -----------------------------------------------------------------------------
//
// Chatter support offline is out of scope: the mail components call the server directly and never
// queue. While offline, no chatter path of a `crm.lead` thread writes or queues. That includes
// the lead saves the chatter starts, refused whether the client is offline when they are called or
// their request loses the connection. A mutation is refused at its handler, or, where it sits in a
// closure no patch can reach, at what that closure calls; overlays holding a mutation in a closure
// or a template expression close when the connection drops. Reads of what the chatter already
// holds stay available, and controls that need the server stay disabled by the framework. Every
// guard acts only while offline and only for a `crm.lead` thread: online, and for every other
// model, each patched method calls `super`. The mail dialog forms the lead chatter opens are
// framework views, guarded in `@crm/mobile/crm_offline_hooks`.
//
// One path is not patched: removing an attachment from a posted message
// (`Message.onClickAttachmentUnlink`). It relies on the framework's connection-loss handling
// instead: offline, its request fails before anything changes, the lost-connection error is
// silenced by the framework, and its delete buttons are disabled by the framework.

const CRM_LEAD = "crm.lead";

/**
 * Whether a chatter mutation must be refused: its target model is `crm.lead` and the client is
 * offline. The model is read first, so an effect calling this always tracks the model accessor,
 * and tracks the offline signal for lead threads only.
 *
 * @param {{ crmOffline?: ReturnType<typeof useCrmOffline> }} holder the patched component or
 *   message action, holding the CRM offline hook result
 * @param {string | undefined} model the target model of the mutation
 * @returns {boolean}
 */
function isCrmLeadOffline(holder, model) {
    return model === CRM_LEAD && Boolean(holder.crmOffline?.isOffline());
}

/**
 * @param {Object | undefined} target an Owl component, or any other object
 * @returns {boolean} whether `target` is a destroyed Owl component
 */
function isDestroyedComponent(target) {
    return Boolean(target?.__owl__) && status(target) === "destroyed";
}

/**
 * Closes an overlay when its target is a lead and the client goes offline, or when it is opened
 * on a lead while offline.
 *
 * The predicate is a computed over the model accessor and, through it, the offline signal. The
 * effect tracks only that computed, so it re-runs when the predicate flips, not on every change of
 * the model accessor. The close is deferred to a microtask, so an overlay is never removed
 * synchronously while it is still being set up, and it runs only if the component is alive and
 * the predicate still holds at that point.
 *
 * @param {Object} holder the patched component or message action holding `crmOffline`
 * @param {() => string | undefined} getModel returns the target model
 * @param {() => void} close closes the overlay
 * @param {Object} [lifecycleOwner=holder] the component whose destruction cancels the close
 */
function useCloseOnCrmOffline(holder, getModel, close, lifecycleOwner = holder) {
    const mustClose = computed(() => isCrmLeadOffline(holder, getModel()));
    useEffect(() => {
        if (mustClose()) {
            untrack(() => {
                Promise.resolve().then(() => {
                    if (isDestroyedComponent(lifecycleOwner)) {
                        return;
                    }
                    if (mustClose()) {
                        close();
                    }
                });
            });
        }
    });
}

/**
 * The chatter's record-save callback as the chatter of an offline lead sees it: it saves nothing.
 * Only the file drop and the file selection of an unsaved lead stop on its `false`. The other
 * callers (the parent reload, `scheduleActivity`, `toggleComposer`) ignore the result: they are
 * refused at their own entry while offline, and by the recheck of `saveLeadFromChatter` when
 * their save loses the connection.
 *
 * @returns {Promise<false>}
 */
const refuseChatterSave = () => Promise.resolve(false);

/**
 * The rejection of the record-save callback a lead chatter's parent reload awaits, when that save
 * returns offline: the reload stops before loading the lead, and `reloadParentView` resolves.
 */
class ParentReloadSkipped extends Error {}

patch(Chatter.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        /** Set while `reloadParentView` calls the web chatter's parent reload. */
        this.crmReloadingParent = false;
        // The drop zone's `onDrop` saves an unsaved lead through the record-save callback before
        // uploading, in a closure no patch can reach. For an offline lead this instance's view of
        // the callback refuses, so a drop on an unsaved lead stops before saving, uploading,
        // reloading or switching panel; on a saved lead, the guarded uploader and parent reload
        // leave it nothing to do but open the read-only attachment panel. Online, a lead's view
        // is `saveLeadFromChatter`; for every other model, the getter returns the original
        // callback.
        const webChatterProps = this.webChatterProps;
        if (webChatterProps) {
            // Calls the form's save as the chatter's own, so a save whose request loses the
            // connection is refused rather than queued (`CrmFormRecord._offlineSave`). Once a
            // save returns offline, nothing the chatter chains on it runs: the pending
            // `onThreadCreated` continuation (composer, schedule activity) is dropped, and a
            // parent reload is rejected with `ParentReloadSkipped` before it loads the lead.
            // One function per instance, so every read of the callback returns the same one.
            const saveLeadFromChatter = async (...args) => {
                const inParentReload = this.crmReloadingParent;
                const outerScope = chatterSaveInScope;
                chatterSaveInScope = true;
                let saving;
                try {
                    saving = webChatterProps.saveRecord?.(...args);
                } finally {
                    chatterSaveInScope = outerScope;
                }
                const saved = await saving;
                if (isCrmLeadOffline(this, this.threadModel())) {
                    this.onThreadCreated = null;
                    if (inParentReload) {
                        throw new ParentReloadSkipped();
                    }
                }
                return saved;
            };
            this.webChatterProps = Object.create(webChatterProps, {
                saveRecord: {
                    enumerable: true,
                    get: () => {
                        const saveRecord = webChatterProps.saveRecord;
                        const threadModel = this.threadModel();
                        if (!saveRecord || threadModel !== CRM_LEAD) {
                            return saveRecord;
                        }
                        return isCrmLeadOffline(this, threadModel)
                            ? refuseChatterSave
                            : saveLeadFromChatter;
                    },
                },
            });
        }
        /** @type {WeakMap<Function, Function>} upload handler -> guarded handler */
        this.crmUploadWrappers = new WeakMap();
        // The drop zone's `onDrop` uploads through this instance's uploader in a closure no patch
        // can reach, so the uploader itself is made inert for an offline lead. `uploadData` calls
        // `this.uploadFile` internally: both layers are guarded.
        const uploader = this.attachmentUploader;
        if (uploader) {
            const uploadFile = uploader.uploadFile.bind(uploader);
            const uploadData = uploader.uploadData.bind(uploader);
            uploader.uploadFile = (...args) =>
                isCrmLeadOffline(this, this.threadModel())
                    ? Promise.resolve()
                    : uploadFile(...args);
            uploader.uploadData = (...args) =>
                isCrmLeadOffline(this, this.threadModel())
                    ? Promise.resolve()
                    : uploadData(...args);
        }
        // A composer, follower dropdown or attachment selection left open when the connection
        // drops is closed: their actions would write.
        useCloseOnCrmOffline(
            this,
            () => this.threadModel(),
            () => {
                this.state.composerType = false;
                if (this.followerListDropdown?.isOpen) {
                    this.followerListDropdown.close();
                }
                this.discardAttachmentSelection();
            }
        );
    },

    /** The followers button is disabled for an offline lead. */
    get isDisabled() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return true;
        }
        return super.isDisabled;
    },

    /**
     * Runs the `onThreadCreated` continuation `toggleComposer` or `scheduleActivity` leaves on an
     * unsaved lead once its thread exists. For an offline lead it is dropped instead: it would
     * open the composer or the schedule-activity dialog without passing their guards.
     */
    changeThread(threadModel) {
        if (isCrmLeadOffline(this, threadModel)) {
            this.onThreadCreated = null;
        }
        return super.changeThread(...arguments);
    },

    /**
     * A lead thread load that loses the connection leaves the chatter showing what it already
     * holds instead of raising. Every other error, and any error for another model's thread,
     * connection loss included, is rethrown.
     */
    async load() {
        try {
            return await super.load(...arguments);
        } catch (error) {
            if (error instanceof ConnectionLostError && this.threadModel() === CRM_LEAD) {
                return;
            }
            throw error;
        }
    },

    onAddFollowers() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return;
        }
        return super.onAddFollowers(...arguments);
    },

    /**
     * The `FileUploader` click hook: `false` stops the file selection, whereas `undefined` would
     * let it proceed.
     */
    onClickAttachFile() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return false;
        }
        return super.onClickAttachFile(...arguments);
    },

    onClickDeleteSelectedAttachments() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return;
        }
        return super.onClickDeleteSelectedAttachments(...arguments);
    },

    /**
     * Called while rendering to give `FileUploader` its required `onUploaded` handler, so it
     * always returns a function: the original handler, wrapped once (stable identity) so that an
     * upload completing for an offline lead uploads nothing, reloads nothing and switches no
     * panel.
     */
    onUploaded() {
        const handler = super.onUploaded(...arguments);
        if (typeof handler !== "function") {
            return handler;
        }
        this.crmUploadWrappers ??= new WeakMap();
        let wrapper = this.crmUploadWrappers.get(handler);
        if (!wrapper) {
            wrapper = (...args) =>
                isCrmLeadOffline(this, this.threadModel()) ? undefined : handler(...args);
            this.crmUploadWrappers.set(handler, wrapper);
        }
        return wrapper;
    },

    /**
     * Saves the lead and reloads it. For an offline lead the save would be queued and the reload
     * would replace the form's unsaved edits, so it is refused. This covers the completion of a
     * file drop and every other chatter callback: the web chatter's `setup` binds
     * `this.reloadParentView` to this patched method. A lead reload whose save returns offline
     * (its request lost the connection) loads nothing either: the record-save callback rejects
     * it with `ParentReloadSkipped`, and the reload resolves.
     */
    reloadParentView() {
        const threadModel = this.threadModel();
        if (isCrmLeadOffline(this, threadModel)) {
            return;
        }
        if (threadModel !== CRM_LEAD) {
            return super.reloadParentView(...arguments);
        }
        const outerReload = this.crmReloadingParent;
        this.crmReloadingParent = true;
        let reloading;
        try {
            reloading = super.reloadParentView(...arguments);
        } finally {
            this.crmReloadingParent = outerReload;
        }
        return Promise.resolve(reloading).catch((error) => {
            if (!(error instanceof ParentReloadSkipped)) {
                throw error;
            }
        });
    },

    scheduleActivity() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return;
        }
        return super.scheduleActivity(...arguments);
    },

    toggleComposer() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return;
        }
        return super.toggleComposer(...arguments);
    },

    /** Also reached by the chatter's `AttachmentList` through its `unlinkAttachments` prop. */
    unlinkAttachments() {
        if (isCrmLeadOffline(this, this.threadModel())) {
            return;
        }
        return super.unlinkAttachments(...arguments);
    },
});

patch(FollowerList.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    onClickAddFollowers() {
        if (isCrmLeadOffline(this, this.props.thread?.model)) {
            return;
        }
        return super.onClickAddFollowers(...arguments);
    },
    onClickFollow() {
        if (isCrmLeadOffline(this, this.props.thread?.model)) {
            return;
        }
        return super.onClickFollow(...arguments);
    },
    onClickUnfollow() {
        if (isCrmLeadOffline(this, this.props.thread?.model)) {
            return;
        }
        return super.onClickUnfollow(...arguments);
    },
    onClickEdit() {
        if (isCrmLeadOffline(this, this.props.thread?.model)) {
            return;
        }
        return super.onClickEdit(...arguments);
    },
});

patch(Follower.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    onClickEdit() {
        if (isCrmLeadOffline(this, this.props.follower?.thread?.model)) {
            return;
        }
        return super.onClickEdit(...arguments);
    },
    onClickRemove() {
        if (isCrmLeadOffline(this, this.props.follower?.thread?.model)) {
            return;
        }
        return super.onClickRemove(...arguments);
    },
});

patch(FollowerSubtypeDialog.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        // Closing the follower dropdown does not close this dialog, so it closes itself.
        useCloseOnCrmOffline(
            this,
            () => this.props.follower?.thread?.model,
            () => this.props.close()
        );
    },
    onClickUpdateAll() {
        if (isCrmLeadOffline(this, this.props.follower?.thread?.model)) {
            return;
        }
        return super.onClickUpdateAll(...arguments);
    },
    /**
     * Also awaited by the mass-update confirmation's `confirm` callback, so a confirmation opened
     * online does nothing once offline.
     */
    updateSubscription() {
        if (isCrmLeadOffline(this, this.props.follower?.thread?.model)) {
            return;
        }
        return super.updateSubscription(...arguments);
    },
});

patch(Activity.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        useCloseOnCrmOffline(
            this,
            () => this.activity()?.res_model,
            () => {
                if (this.markDonePopover?.isOpen) {
                    this.markDonePopover.close();
                }
            }
        );
    },
    onClickAssign() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickAssign(...arguments);
    },
    onClickMail() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickMail(...arguments);
    },
    onClickMarkAsDone() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickMarkAsDone(...arguments);
    },
    onFileUploaded() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onFileUploaded(...arguments);
    },
    edit() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.edit(...arguments);
    },
});

patch(ActivityMarkAsDone.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    /** Covers a popover opened before the connection dropped. */
    onClickDone() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickDone(...arguments);
    },
    onClickDoneAndScheduleNext() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickDoneAndScheduleNext(...arguments);
    },
});

patch(ActivityAssignPopover.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        // `close` is the optional static prop (`this.close`), not `this.props.close`.
        useCloseOnCrmOffline(
            this,
            () => this.activity()?.res_model,
            () => this.close?.()
        );
    },
    /** Writes `mail.activity.user_id`. */
    onClickAssign() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickAssign(...arguments);
    },
});

patch(ActivityMailTemplate.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    /** Opens the `mail.compose.message` dialog. */
    onClickPreview() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickPreview(...arguments);
    },
    /** Calls `activity_send_mail`. */
    onClickSend() {
        if (isCrmLeadOffline(this, this.activity()?.res_model)) {
            return;
        }
        return super.onClickSend(...arguments);
    },
});

patch(QuickReactionMenu.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    onClick() {
        if (isCrmLeadOffline(this, this.props.message?.thread?.model)) {
            return;
        }
        return super.onClick(...arguments);
    },
    /**
     * Also the `onSelect` of this menu's emoji picker, bound to this method during setup, so a
     * picker opened online is inert once offline.
     */
    toggleReaction() {
        if (isCrmLeadOffline(this, this.props.message?.thread?.model)) {
            return;
        }
        return super.toggleReaction(...arguments);
    },
});

patch(MessageReactionList.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    onClickReaction() {
        if (isCrmLeadOffline(this, this.message()?.thread?.model)) {
            return;
        }
        return super.onClickReaction(...arguments);
    },
});

patch(MessageReactionMenu.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        // Its remove button calls `reaction.remove()` from a template expression no patch can
        // reach: the menu closes when the connection drops.
        useCloseOnCrmOffline(
            this,
            () => this.props.message?.thread?.model,
            () => this.props.close()
        );
    },
});

patch(ScheduledMessage.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
    },
    cancel() {
        if (isCrmLeadOffline(this, this.props.scheduledMessage?.thread?.model)) {
            return;
        }
        return super.cancel(...arguments);
    },
    onClickAttachmentUnlink() {
        if (isCrmLeadOffline(this, this.props.scheduledMessage?.thread?.model)) {
            return;
        }
        return super.onClickAttachmentUnlink(...arguments);
    },
    /** Its confirmation binds `this.cancel`, which is guarded too once the dialog is open. */
    onClickCancel() {
        if (isCrmLeadOffline(this, this.props.scheduledMessage?.thread?.model)) {
            return;
        }
        return super.onClickCancel(...arguments);
    },
    onClickEdit() {
        if (isCrmLeadOffline(this, this.props.scheduledMessage?.thread?.model)) {
            return;
        }
        return super.onClickEdit(...arguments);
    },
    onClickSendNow() {
        if (isCrmLeadOffline(this, this.props.scheduledMessage?.thread?.model)) {
            return;
        }
        return super.onClickSendNow(...arguments);
    },
});

patch(Composer.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        // An edit composer opened online stays open offline. Its `FileUploader` uploads through
        // an `onUploaded` closure of the template and voice messages through a recorder callback,
        // both on this instance's uploader, which no patch can reach: the uploader itself is
        // made inert for an offline lead. `uploadData` calls `this.uploadFile` internally: both
        // layers are guarded.
        const uploader = this.attachmentUploader;
        if (uploader) {
            const uploadFile = uploader.uploadFile.bind(uploader);
            const uploadData = uploader.uploadData.bind(uploader);
            uploader.uploadFile = (...args) =>
                isCrmLeadOffline(this, this.thread?.model)
                    ? Promise.resolve()
                    : uploadFile(...args);
            uploader.uploadData = (...args) =>
                isCrmLeadOffline(this, this.thread?.model)
                    ? Promise.resolve()
                    : uploadData(...args);
        }
    },
    /** The drop zone's `onDrop`, bound to this method during setup. */
    onDropFile() {
        if (isCrmLeadOffline(this, this.thread?.model)) {
            return;
        }
        return super.onDropFile(...arguments);
    },
    /**
     * Reached from the textarea and from the editor's paste handler. For an offline lead,
     * attachment upload is skipped and the native or editor paste handling continues.
     */
    onPaste() {
        if (isCrmLeadOffline(this, this.thread?.model)) {
            return;
        }
        return super.onPaste(...arguments);
    },
    /**
     * Also reached by the composer's `AttachmentList` through its `unlinkAttachments` prop.
     * Returns before the posted attachments are removed from the composer.
     */
    unlinkAttachments() {
        if (isCrmLeadOffline(this, this.thread?.model)) {
            return;
        }
        return super.unlinkAttachments(...arguments);
    },
    /** Covers the send button, the Enter key and an edit composer left open. */
    sendMessage() {
        if (isCrmLeadOffline(this, this.thread?.model)) {
            return;
        }
        return super.sendMessage(...arguments);
    },
    /**
     * An edit composer saves through this method directly (Enter key, inline save link), not
     * through `sendMessage`, so it is guarded as well: a message edit is a mail write.
     */
    editMessage() {
        if (isCrmLeadOffline(this, this.thread?.model)) {
            return;
        }
        return super.editMessage(...arguments);
    },
    /**
     * The continuation of `sendMessage` and `editMessage`, which can run after an awaited
     * confirmation (such as the mass-mention one) answered once the connection dropped: checked
     * again here, so such a confirmation posts and edits nothing.
     */
    processMessage() {
        if (isCrmLeadOffline(this, this.thread?.model)) {
            return;
        }
        return super.processMessage(...arguments);
    },
});

patch(MessageDeleteDialog.prototype, {
    setup() {
        super.setup(...arguments);
        this.crmOffline = useCrmOffline();
        // Its confirmation runs `message.remove()` through a callback captured when it opened,
        // which no message action guard reaches: the dialog closes when the connection drops.
        useCloseOnCrmOffline(
            this,
            () => this.props.message?.thread?.model,
            () => this.props.close()
        );
    },
    /** Also covers a direct call on a dialog opened before the connection dropped. */
    onClickConfirm() {
        if (isCrmLeadOffline(this, this.props.message?.thread?.model)) {
            return;
        }
        return super.onClickConfirm(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Message actions
// -----------------------------------------------------------------------------

/**
 * One CRM offline hook result per action owner. `useAction` sets up every message action of an
 * owner (a message, its context menu, its reactions, a messaging-menu item) while that owner's
 * `setup` runs, so its actions share the hook called in that scope instead of calling it once per
 * action.
 *
 * @type {WeakMap<Object, ReturnType<typeof useCrmOffline>>}
 */
const crmOfflineByActionOwner = new WeakMap();

/**
 * The model a message action targets: the thread the message is viewed in, or else the message's
 * own thread.
 *
 * @param {MessageAction} action
 * @param {Object} [params] the action params (`action.params`) when the caller already has them
 * @returns {string | undefined}
 */
function messageActionModel(action, params) {
    const thread = params ? params.thread : action.threadFn?.();
    const message = params ? params.message : action.messageFn?.();
    return thread?.model ?? message?.thread?.model;
}

patch(MessageAction.prototype, {
    /**
     * Attaches the offline source to the action itself, whatever its owner, before the
     * definition's own setup runs. Actions constructed without setup (the "more" dropdown
     * action) have no source and are never guarded: they only list the guarded actions.
     */
    setup() {
        const owner = this.owner;
        let crmOffline = owner ? crmOfflineByActionOwner.get(owner) : undefined;
        if (!crmOffline) {
            crmOffline = useCrmOffline();
            if (owner) {
                crmOfflineByActionOwner.set(owner, crmOffline);
            }
        }
        this.crmOffline = crmOffline;
        const result = super.setup(...arguments);
        if (this.id === "reaction") {
            // The definition gives the owner an emoji picker whose `onSelect` reacts directly,
            // bypassing `onSelected`: the picker closes when the connection drops.
            useCloseOnCrmOffline(
                this,
                () => messageActionModel(this),
                () => this.owner.reactionPicker?.close(),
                this.owner
            );
        }
        return result;
    },
    /** No message action is listed for an offline lead message. */
    _condition(params) {
        if (isCrmLeadOffline(this, messageActionModel(this, params))) {
            return false;
        }
        return super._condition(...arguments);
    },
    /**
     * Returning `true` short-circuits the definition's `onSelected`, which also keeps the
     * reaction picker from reopening.
     */
    _onSelected(params) {
        if (isCrmLeadOffline(this, messageActionModel(this, params))) {
            return true;
        }
        return super._onSelected(...arguments);
    },
});

// -----------------------------------------------------------------------------
// Lead notes editor: usable offline
// -----------------------------------------------------------------------------

const OFFLINE_AVAILABLE_ATTRIBUTE = "data-available-offline";

/**
 * Marks an editor's editable element as usable offline. The editor reports itself loaded before
 * it is attached to its element, so when the editable does not exist yet, this editor instance's
 * `attachTo` marks it once attached.
 *
 * @param {import("@html_editor/editor").Editor} editor
 */
function markEditableAvailableOffline(editor) {
    if (editor.editable) {
        editor.editable.setAttribute(OFFLINE_AVAILABLE_ATTRIBUTE, "1");
        return;
    }
    if (typeof editor.attachTo !== "function") {
        return;
    }
    const attachTo = editor.attachTo;
    editor.attachTo = function () {
        const result = attachTo.apply(this, arguments);
        this.editable?.setAttribute(OFFLINE_AVAILABLE_ATTRIBUTE, "1");
        return result;
    };
}

patch(HtmlField.prototype, {
    /**
     * The lead notes stay editable offline (they are saved with the lead), so their editable
     * carries the offline-availability attribute, which the framework reads only while offline.
     * The toolbar buttons are not annotated and stay disabled offline; other models' html fields
     * get no attribute.
     */
    onEditorLoad(editor) {
        const result = super.onEditorLoad(...arguments);
        if (editor && this.props.record?.resModel === CRM_LEAD) {
            markEditableAvailableOffline(editor);
        }
        return result;
    },
});
