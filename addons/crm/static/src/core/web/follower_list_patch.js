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
 */
patch(FollowerList.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
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
