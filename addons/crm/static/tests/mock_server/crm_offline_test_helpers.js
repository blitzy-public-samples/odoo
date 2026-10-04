import { advanceTime, animationFrame } from "@odoo/hoot-dom";
import { getService, mockOffline } from "@web/../tests/web_test_helpers";

/**
 * `mockOffline()`, settled for mail. Any test that mounts `WebClient`
 * (directly, or indirectly through @mail's own `start()`) with
 * `defineMailModels()` active starts a background `mail.store`
 * `fetchStoreData()` call (`store_service.js`'s `ensureInitialized()`,
 * wired in through `mail_core_public_web_service.js`), debounced by
 * `Store.FETCH_DATA_DEBOUNCE_DELAY` (1ms) via the real (mocked-in-test)
 * `setTimeout`, and batched with whatever else asked for store data in
 * that same window (opening a chatter's composer, a followers dropdown,
 * the messaging menu's own counters fetch, ...). If that fetch is still
 * in flight when the connection drops, it throws an uncaught
 * `ConnectionLostError` that has nothing to do with whatever the test
 * actually asserts -- surfacing in that test, or (since the rejection can
 * resolve a tick later, after the test that triggered it has already
 * finished) in whichever other test happens to be running by then,
 * anywhere in the suite. Awaiting the store's own `isReadyPromise`
 * (resolved once its first, app-wide fetch -- which always includes
 * "init_messaging" -- settles) catches the common case; `isReadyPromise`
 * only resolves once the underlying `setTimeout` has actually fired,
 * though, and plain `animationFrame()` only waits one real
 * requestAnimationFrame + macrotask tick -- not necessarily enough real
 * wall-clock time for that 1ms timer to fire under the load of a full
 * suite run (hoot's test runner executes hundreds of other tests' own
 * timers and renders in the same browser process), which is what made
 * this flaky rather than reliably fast or reliably slow.
 * `advanceTime(5)` (`@odoo/hoot-dom`) fires every mocked timer currently
 * scheduled within that 5ms window -- comfortably covering the 1ms
 * debounce -- synchronously and independent of real wall-clock time, so
 * it cannot lose that race; unlike `runAllTimers()`, its fixed, small
 * budget leaves the framework's own longer-lived timers (the offline
 * version-info backoff ping, `_syncORM`'s 1s pause between replayed
 * calls) untouched, so it cannot fast-forward *those* into firing early
 * either. A test's own setup (e.g. opening a composer right before going
 * offline) can still schedule its *own* debounce only during the
 * `animationFrame()` tick itself -- too late for the `advanceTime(5)`
 * that ran just before it to have caught it. A second `advanceTime(5)`
 * after that tick closes that gap deterministically instead of adding
 * another real-wall-clock wait that would just reopen the same race one
 * level down.
 */
/**
 * The wait sequence `mockCrmOffline()` runs before flipping offline,
 * factored out so a test can also run it on demand -- e.g. right before
 * `destroyApp()`ing a `WebClient` it mounted while online, so that
 * `WebClient`'s own debounced `mail.store` fetch (started at mount time,
 * same as any other) resolves successfully before the app is torn down
 * instead of possibly still being in flight. An app's background fetch
 * does not get cancelled by destroying the app: left unflushed, it can
 * still reject with the same uncaught `ConnectionLostError` once a later
 * `mockCrmOffline()` call (for a second, unrelated `WebClient`) flips the
 * connection offline, surfacing in whatever test happens to be running
 * when that late rejection lands (see `mockCrmOffline()`'s own doc, and
 * `crm_offline_cold_start.test.js`, which destroys and remounts a fresh
 * `WebClient` per test).
 */
export async function waitForMailStoreReady() {
    await getService("mail.store").isReadyPromise;
    await advanceTime(5);
    await animationFrame();
    await advanceTime(5);
}

export function mockCrmOffline() {
    const setOffline = mockOffline();
    return async (offline) => {
        if (offline) {
            await waitForMailStoreReady();
        }
        return setOffline(offline);
    };
}
