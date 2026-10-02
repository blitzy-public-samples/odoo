import { useOnChange } from "@odoo/owl";

import { Follower } from "@mail/core/web/follower";
import { FollowerList } from "@mail/core/web/follower_list";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * Scrutiny finding 8 (VAL-FIX-012, VAL-DIS-004) / offline_inventory.md row
 * B14: the followers dropdown's Follow/Unfollow and "Add Followers" items
 * are `DropdownItem`/`<a>` elements (`mail/core/web/follower_list.xml`),
 * and each follower's own "Remove" is a plain `<span>`
 * (`mail/core/web/follower.xml`) -- none of them is a `<button>`, so the
 * framework's button-only `SELECTORS_TO_DISABLE` pass never reaches any of
 * them. A dropdown opened online and left open across the connection drop
 * therefore stays fully clickable, and each handler is also reachable
 * directly. Guarding `FollowerList.onClickFollow`/`onClickUnfollow`/
 * `onClickAddFollowers` and `Follower.onClickRemove`, scoped to a
 * `crm.lead` thread, closes every one of those paths; other models'
 * followers are untouched, online or offline. The "Edit Notification
 * Preferences" action (`onClickEdit`, both components) opens a local
 * dialog with no RPC of its own, so it is out of scope here.
 *
 * Scrutiny round 2: the handler guards above stop any write RPC, but
 * VAL-FIX-012 requires the write controls themselves to be disabled or
 * absent, not just inert -- a dropdown opened online and left open across
 * the disconnect still renders Follow/Unfollow/"Add Followers" (and, via
 * the nested `Follower` component, every "Remove") as apparently enabled,
 * focusable items. `mail.FollowerList` is only ever mounted inside the
 * `Dropdown`'s `content` slot (`chatter.xml`), so closing the dropdown
 * (`this.props.dropdown.close()`, the same call `onClickEdit` already
 * uses) unmounts it -- and every nested `Follower` -- entirely. Watching
 * `OfflinePlugin.isOffline()` (a signal) via `useOnChange` closes the menu
 * at the moment the connection drops, for a `crm.lead` thread only; other
 * models' dropdowns are left open as before.
 */
patch(FollowerList.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        useOnChange(
            () => [this.crmOffline.isOffline()],
            (isOffline) => {
                if (isOffline && this.props.thread.model === "crm.lead") {
                    this.props.dropdown.close();
                }
            }
        );
    },

    get isCrmLeadOffline() {
        return this.crmOffline.isOffline() && this.props.thread.model === "crm.lead";
    },

    onClickAddFollowers() {
        if (this.isCrmLeadOffline) {
            return;
        }
        return super.onClickAddFollowers(...arguments);
    },

    async onClickFollow() {
        if (this.isCrmLeadOffline) {
            return;
        }
        return super.onClickFollow(...arguments);
    },

    async onClickUnfollow() {
        if (this.isCrmLeadOffline) {
            return;
        }
        return super.onClickUnfollow(...arguments);
    },
});

patch(Follower.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    async onClickRemove() {
        if (this.crmOffline.isOffline() && this.props.follower.thread?.model === "crm.lead") {
            return;
        }
        return super.onClickRemove(...arguments);
    },
});
