import { ActivityModel } from "@mail/views/web/activity/activity_model";
import { ConnectionLostError } from "@web/core/network/rpc";

/**
 * B81 (VAL-DIS-007): entering the activity view offline with nothing cached
 * must show `OfflineActionHelper`, not crash. `RelationalModel.load()` sets
 * `couldNotLoadRootOffline` on a `ConnectionLostError` but still rethrows it
 * (`relational_model.js`); `ActivityModel.load()` additionally runs its own
 * `fetchActivityData()` RPC (`get_activity_data`) in the same `Promise.all`,
 * which has no error handling of its own either. Either rejection would
 * otherwise propagate out of `useModel`'s `onWillStart` and fail the whole
 * view's mount instead of letting the `couldNotLoadRootOffline` template
 * branch (`crm_activity_view.xml`) render -- swallow it here instead of
 * relying on it.
 */
export class CrmActivityModel extends ActivityModel {
    async load(params = {}) {
        try {
            return await super.load(params);
        } catch (e) {
            if (!(e instanceof ConnectionLostError)) {
                throw e;
            }
            this.couldNotLoadRootOffline = true;
            this.activityData = {
                activity_types: [],
                activity_res_ids: [],
                grouped_activities: {},
            };
            this.notify();
        }
    }
}
