import { registry } from "@web/core/registry";
import { ConnectionLostError, rpcBus } from "@web/core/network/rpc";

/**
 * VAL-E2E-001/002 (architecture.md §3.6, "Tours"): one tour run covering
 * the whole offline flow at the mobile viewport (`browser_size='375x667'`,
 * `touch_enabled=True` on the driving `HttpCase`, see
 * tests/test_crm_offline_tour.py): pipeline online -> open a lead -> go
 * offline (simulated in-page, never by navigating away) -> edit the lead
 * -> mobile quick create -> schedule an activity -> mark the lead won ->
 * reconnect. The Python test asserts every effect on the server afterwards.
 *
 * Offline is simulated as architecture.md §2 "Hoot offline testing" /
 * §3.6 describe for tours (not hoot's `mockOffline`, which only exists
 * inside a hoot test run): the transport is stubbed so every RPC turns
 * into a `ConnectionLostError`, exactly what a dropped connection
 * produces, using the same technique as
 * `point_of_sale/static/tests/generic_helpers/offline_util.js`'s
 * `setOfflineMode`/`setOnlineMode`: `XMLHttpRequest.prototype.send` and
 * `window.fetch` are replaced with functions that *throw*
 * `ConnectionLostError` synchronously, so the `new Promise(...)` executor
 * in `rpc()` (`addons/web/static/src/core/network/rpc.js`) auto-rejects
 * with it. An earlier version of this tour instead built a fake "error"
 * DOM event and dispatched it asynchronously on the XHR instance; that
 * was intermittently (~1 in 5 runs) never observed by `rpc()`'s listener
 * in headless Chrome, hanging the offline save forever with no console
 * error. The synchronous throw has no such race.
 *
 * A synchronous throw in `send()` also means `rpc()`'s own `error`
 * listener -- the only place that calls `rpcBus.trigger("RPC:RESPONSE",
 * ...)` -- never runs (the throw is caught by the Promise constructor
 * itself, before any of `rpc()`'s code executes). `OfflinePlugin.isOffline`
 * is driven solely by that bus event
 * (`offline_plugin.js` `setup()`), so going offline/online fires
 * `rpcBus.trigger("RPC:RESPONSE", ...)` directly to flip it deterministically,
 * instead of depending on the native `online`/`offline` window events to
 * do it indirectly through a ping (`checkConnection()`) that would hit the
 * same stub and have the same problem. The native events are still
 * dispatched too, for any other code that listens to them directly.
 */
registry.category("web_tour.tours").add("crm_offline_e2e_tour", {
    steps: () => [
        // This tour only ever runs at the mobile viewport (the HttpCase
        // in test_crm_offline_tour.py sets browser_size/touch_enabled),
        // so it opens the CRM app through the mobile burger menu
        // directly instead of `stepUtils.goToAppSteps`: that helper's
        // own app-tile step (`showAppsMenuItem`) is desktop-only, and on
        // mobile `.o_app[...]` only renders once the sidebar is open and
        // its "All Apps" button has been tapped (navbar.xml's
        // `web.NavBar.AppsMenu.Sidebar` template).
        {
            trigger: ".o_main_navbar .o_menu_toggle",
            content: "open the burger menu",
            run: "click",
        },
        {
            trigger: ".o_sidebar_topbar a.btn-primary",
            content: "show the all-apps list",
            run: "click",
        },
        {
            trigger: '.o_app[data-menu-xmlid="crm.crm_menu_root"]',
            content: "open the CRM app",
            run: "click",
        },
        {
            trigger: ".o_crm_mobile_card:contains('Offline Tour Lead')",
            content: "open the lead online, caching its form for later offline use",
            run: "click",
        },
        {
            trigger: ".o_field_widget[name=name] textarea",
            content: "wait for the lead form to load",
        },
        {
            trigger: ".o_field_widget[name=name] textarea",
            content: "simulate going offline, in the page, without navigating away",
            run: () => {
                const w = window;
                w.__crmTourOfflineOriginalSend ??= w.XMLHttpRequest.prototype.send;
                w.__crmTourOfflineOriginalFetch ??= w.fetch;
                w.XMLHttpRequest.prototype.send = function () {
                    throw new ConnectionLostError();
                };
                w.fetch = () => {
                    throw new ConnectionLostError();
                };
                w.dispatchEvent(new Event("offline"));
                // Other RPC:RESPONSE listeners (loading_indicator.js,
                // reload_company_service.js, currency_plugin.js, ...)
                // destructure `data.params`/`settings.silent`
                // unconditionally; `settings.silent: true` makes every one
                // of them bail out immediately instead of acting on a
                // fabricated RPC that was never really sent.
                rpcBus.trigger("RPC:RESPONSE", {
                    data: { id: -1, jsonrpc: "2.0", method: "call", params: {} },
                    settings: { silent: true },
                    error: new ConnectionLostError(),
                });
            },
        },
        {
            trigger: ".o_crm_activity_panel",
            content: "wait for the offline activity panel to confirm the client is offline",
        },
        {
            trigger: ".o_field_widget[name=name] textarea",
            content: "edit the lead's name while offline",
            run: "edit Offline Tour Lead - edited offline",
        },
        {
            trigger: ".o_form_button_save",
            content: "save the offline edit (queues a web_save)",
            run: "click",
        },
        {
            trigger: ".o_form_button_save:not(:visible)",
            content: "wait for the offline save to settle",
            timeout: 20000,
        },
        {
            trigger: ".o_back_button",
            content: "go back to the pipeline, still offline",
            run: "click",
        },
        {
            trigger: ".o_crm_mobile_pipeline_add",
            content: "open the mobile quick-create bottom sheet",
            run: "click",
        },
        {
            trigger: ".o_crm_mobile_quick_create_name",
            content: "fill the quick-create lead name",
            run: "edit Offline Quick Create Lead",
        },
        {
            trigger: ".o_crm_mobile_quick_create_contact_name",
            content: "fill the quick-create contact name",
            run: "edit Jane Tourist",
        },
        {
            trigger: ".o_crm_mobile_quick_create_phone",
            content: "fill the quick-create phone",
            run: "edit +1 555 0100",
        },
        {
            trigger: ".o_crm_mobile_quick_create_email",
            content: "fill the quick-create email",
            run: "edit jane.tourist@example.com",
        },
        {
            trigger: ".o_crm_mobile_quick_create_expected_revenue",
            content: "fill the quick-create expected revenue",
            run: "edit 1234",
        },
        {
            trigger: ".o_crm_mobile_quick_create_save",
            content: "create the lead offline (queues a web_save create)",
            run: "click",
        },
        {
            trigger: "body:not(:has(.o_crm_mobile_quick_create))",
            content: "wait for the quick-create sheet to close",
        },
        {
            trigger: ".o_crm_mobile_card:contains('Offline Tour Lead')",
            content: "reopen the original lead, still offline (cached from the earlier online visit)",
            run: "click",
        },
        {
            trigger: ".o_crm_activity_panel",
            content: "wait for the offline activity panel to render again",
        },
        {
            trigger: ".o_crm_activity_schedule_summary",
            content: "fill the activity summary",
            run: "edit Offline tour follow-up",
        },
        {
            trigger: ".o_crm_activity_schedule_button:enabled",
            content: "schedule the activity offline (queues a mail.activity create)",
            run: "click",
        },
        {
            trigger: ".o_crm_activity_panel_row:contains('Offline tour follow-up')",
            content: "wait for the pending activity row to render",
        },
        {
            trigger: "button[name='action_set_won_rainbowman']",
            content: "mark the lead won offline (queues action_set_won)",
            run: "click",
        },
        {
            trigger: ".ribbon span:contains('Won')",
            content: "wait for the optimistic Won ribbon",
        },
        {
            trigger: ".ribbon span:contains('Won')",
            content: "reconnect: restore the real transport and dispatch 'online'",
            run: () => {
                const w = window;
                w.XMLHttpRequest.prototype.send = w.__crmTourOfflineOriginalSend;
                w.fetch = w.__crmTourOfflineOriginalFetch;
                w.dispatchEvent(new Event("online"));
                rpcBus.trigger("RPC:RESPONSE", {
                    data: { id: -1, jsonrpc: "2.0", method: "call", params: {} },
                    settings: { silent: true },
                    result: {},
                });
            },
        },
        {
            trigger: "body:not(:has(.o_crm_activity_panel))",
            content: "wait for the client to detect it is back online",
        },
        {
            trigger: "body:not(:has(.o_offline_systray))",
            content: "wait for the queue to fully replay (no scheduled calls left)",
            timeout: 20000,
        },
    ],
});
