import { Composer } from "@mail/core/common/composer";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * architecture.md §3.2 item 8 / offline_inventory.md row B14 (VAL-FIX-012,
 * VAL-DIS-004): the chatter's "Send message", "Log note" and "Activity"
 * `<button>`s carry no `data-available-offline`, so the framework's
 * `SELECTORS_TO_DISABLE` already disables them offline on its own -- but a
 * composer left open from *before* going offline is untouched by that: its
 * textarea's `onKeydown` (`@mail/core/common/composer.js`) calls
 * `sendMessage()` directly on Enter, bypassing the disabled Send/Log-note
 * button entirely and posting straight to the server. Guarding
 * `sendMessage()` itself closes that gap for any `crm.lead` thread, by
 * click or by keyboard, while leaving every other model's chatter (and the
 * crm.lead chatter online) untouched.
 *
 * Scrutiny finding 9 (VAL-DIS-004): `sendMessage()` only covers *new*
 * messages. When the composer is in message-edit mode
 * (`this.props.composer.message` set), `onKeydown`'s Enter branch and the
 * "save" text link (`onClickCancelOrSaveEditText`) both call
 * `editMessage()` directly instead -- `sendMessage()` itself would also
 * reach `editMessage()` for a new call, but neither of those two call
 * sites goes through `sendMessage()` at all, so the guard above never ran
 * for an edit. There is also no disabled-button safety net in edit mode:
 * the template's save affordance there is a plain, never-disabled text
 * span, not the `isSendButtonDisabled`-gated send `<button>`. Guard
 * `editMessage()` itself, scoped by the *edited message's* thread
 * (`this.props.composer.message.thread`), not `this.thread`
 * (`composer.targetThread`): for a reply composer the two can differ, and
 * only the message being edited determines whether this is a crm.lead
 * chatter write.
 *
 * Scrutiny finding 10 (VAL-FIX-012, VAL-DIS-004): pasting
 * (`onPaste`) or dropping (`onDropFile`) a file into a composer left open
 * from before going offline starts an attachment upload with no offline
 * check at all. Overriding the `allowUpload` getter closes the paste path
 * on its own: mail's own `onPaste` already gates on `this.allowUpload`
 * before touching `ev.clipboardData`, and the attach-file `<FileUploader>`
 * toggler's `t-if="this.allowUpload"` in `composer.xml` hides the control
 * itself, reactively, the same way `isSendButtonDisabled` already hides
 * the send button here. `onDropFile` needs its own guard because it
 * uploads every dropped file unconditionally, with no `allowUpload` check
 * of its own; the dropzone that calls it stays rendered too, since its
 * enablement predicate reads `this.props.allowUpload` (the raw prop,
 * always true from the chatter), not this getter.
 */
patch(Composer.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    get isSendButtonDisabled() {
        if (this.crmOffline.isOffline() && this.thread?.model === "crm.lead") {
            // Also covers the button's own `t-att-disabled` binding: without
            // this, typing text while offline would make the reactive
            // getter return `false` again, and OWL's next render would
            // remove the `disabled` attribute the framework set directly on
            // the DOM node (its `MutationObserver` only watches for
            // `data-available-offline` changes, not `disabled`).
            return true;
        }
        return super.isSendButtonDisabled;
    },

    get allowUpload() {
        if (this.crmOffline.isOffline() && this.thread?.model === "crm.lead") {
            return false;
        }
        return super.allowUpload;
    },

    async sendMessage() {
        if (this.crmOffline.isOffline() && this.thread?.model === "crm.lead") {
            return;
        }
        return super.sendMessage(...arguments);
    },

    async editMessage() {
        const message = this.props.composer.message;
        if (this.crmOffline.isOffline() && message?.thread?.model === "crm.lead") {
            return;
        }
        return super.editMessage(...arguments);
    },

    onDropFile(ev) {
        if (this.crmOffline.isOffline() && this.thread?.model === "crm.lead") {
            return;
        }
        return super.onDropFile(ev);
    },
});
