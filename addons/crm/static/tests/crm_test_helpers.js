import { CrmLead } from "@crm/../tests/mock_server/mock_models/crm_lead";
import { mailModels } from "@mail/../tests/mail_test_helpers";
import { animationFrame } from "@odoo/hoot-dom";
import { defineModels, getService, mockOffline } from "@web/../tests/web_test_helpers";

export const crmModels = {
    ...mailModels,
    CrmLead
};

export function defineCrmModels() {
    defineModels(crmModels);
}

/**
 * `mockOffline()`, settled for mail. Any test that mounts `WebClient`
 * (directly, or indirectly through @mail's own `start()`) with
 * `defineMailModels()` active starts a background `mail.store`
 * `fetchStoreData()` call (`store_service.js`'s `ensureInitialized()`,
 * wired in through `mail_core_public_web_service.js`), debounced by
 * `Store.FETCH_DATA_DEBOUNCE_DELAY` (1ms) and batched with whatever else
 * asked for store data in that same window (opening a chatter's composer,
 * a followers dropdown, ...). If that fetch is still in flight when the
 * connection drops, it throws an uncaught `ConnectionLostError` that has
 * nothing to do with whatever the test actually asserts -- surfacing in
 * that test, or (since the rejection can resolve a tick later, after the
 * test that triggered it has already finished) in whichever other test
 * happens to be running by then, anywhere in the suite. Awaiting the
 * store's own `isReadyPromise` (resolved once its first, app-wide fetch --
 * which always includes "init_messaging" -- settles) catches the common
 * case deterministically; the extra `animationFrame()` covers a second,
 * narrower fetch a test's own setup (e.g. opening a composer) may have
 * started right before going offline.
 */
export function mockCrmOffline() {
    const setOffline = mockOffline();
    return async (offline) => {
        if (offline) {
            await getService("mail.store").isReadyPromise;
            await animationFrame();
        }
        return setOffline(offline);
    };
}
