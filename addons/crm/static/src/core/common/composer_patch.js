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

    async sendMessage() {
        if (this.crmOffline.isOffline() && this.thread?.model === "crm.lead") {
            return;
        }
        return super.sendMessage(...arguments);
    },
});
