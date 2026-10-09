/**
 * Tour `crm_mobile_offline`: a salesperson's offline session on the small-screen CRM pipeline.
 *
 * Started by `TestCrmOffline.test_mobile_offline_tour` (`addons/crm/tests/test_crm_offline.py`)
 * on the pipeline action, as `user_sales_leads`, in a 375x667 touch browser, so the small-screen
 * signal holds and the stage-at-a-time pipeline (`crm_mobile_pipeline`) renders. The page is
 * served from 127.0.0.1, a secure context, so the framework offline plugin is active and queues
 * the writes. The launcher creates the lead `Offline Tour Lead` (stage "New" of `sales_team_1`)
 * before the tour and asserts on the server, after it, every value entered below: keep both in
 * sync.
 *
 * Flow:
 * 1. Online: load the pipeline, wait until the service worker is active (its first activation
 *    clears the RPC cache), open the lead's form once (so it is available offline), go back,
 *    and wait until the activity types are cached (Follow-up enabled).
 * 2. Offline: edit the lead in its form, create a lead through the mobile quick create, schedule
 *    a follow-up activity from the card and mark the lead won through the card's stage list.
 *    Each write is queued by the framework offline queue and shown as pending.
 * 3. Back online: wait until the framework has replayed the whole queue (the offline systray
 *    disappears), then until the pipeline shows the replayed lead as a server record.
 *
 * Connectivity is simulated for this page only, as the clickbot's offline test does: the
 * `XMLHttpRequest` class the RPC layer reads on every call is swapped for one that fails like a
 * lost network, and the browser `offline`/`online` events are dispatched so the offline plugin
 * checks the connection at once. The server itself stays up, and `fetch` is left untouched: every
 * RPC (ORM calls, disk-cached reads, connection checks) goes through `XMLHttpRequest`.
 */

import { registry } from "@web/core/registry";
import { stepUtils } from "@web_tour/tour_utils";
import { browser } from "@web/core/browser/browser";

/** The real `XMLHttpRequest` class while the fake one is installed, `null` otherwise. */
let originalXHR = null;

/**
 * Request class of a lost connection: every request fails with a network error, which the RPC
 * layer turns into a `ConnectionLostError`; its `RPC:RESPONSE` event switches the offline plugin
 * to offline.
 */
class FakeOfflineXHR extends EventTarget {
    open() {}
    setRequestHeader() {}
    send() {
        setTimeout(() => this.dispatchEvent(new ProgressEvent("error")), 20);
    }
}

/** The fixture lead's card. Its edited name keeps this text, so the selector survives the edit. */
const LEAD_CARD = ".o_crm_mobile_lead_card:contains('Offline Tour Lead')";

registry.category("web_tour.tours").add("crm_mobile_offline", {
    steps: () => [
        // ---------------------------------------------------------------------
        // Online: load the pipeline and make the lead available offline
        // ---------------------------------------------------------------------
        {
            content: "the small-screen pipeline is rendered",
            trigger: ".o_crm_mobile_pipeline",
        },
        {
            content: "the fixture lead is displayed in its stage",
            trigger: LEAD_CARD,
        },
        {
            // The webclient registers the service worker on load. When the worker activates
            // without controlling the page (its first activation in a browser profile, as in
            // every test browser), the webclient clears the whole RPC cache and the
            // offline-availability registry. A lead form read in flight at that moment is never
            // cached, yet the form is registered as available offline once loaded, so opening it
            // offline would load nothing. The webclient clears in its own reaction to this same
            // promise, which has therefore run before the next step starts; the worker activates
            // once per page.
            content: "the service worker is active: the RPC cache is no longer cleared",
            trigger: ".o_crm_mobile_pipeline",
            async run() {
                await browser.navigator.serviceWorker?.ready;
            },
        },
        {
            content: "open the lead online, so its form is cached",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_name`,
            run: "click",
        },
        {
            content: "the lead form is loaded",
            trigger: ".o_form_view .o_field_widget[name=name] textarea",
        },
        {
            content: "go back to the pipeline",
            trigger: ".o_back_button",
            run: "click",
        },
        {
            content: "the pipeline is displayed again",
            trigger: ".o_crm_mobile_pipeline",
        },
        {
            content: "the activity types are cached: Follow-up is enabled",
            trigger: `${LEAD_CARD} .o_crm_mobile_card_follow_up:enabled`,
        },

        // ---------------------------------------------------------------------
        // Go offline
        // ---------------------------------------------------------------------
        {
            content: "lose the connection",
            trigger: ".o_crm_mobile_pipeline",
            run() {
                originalXHR = browser.XMLHttpRequest;
                browser.XMLHttpRequest = FakeOfflineXHR;
                browser.dispatchEvent(new Event("offline"));
            },
        },
        {
            content: "the offline systray shows 'Working offline'",
            trigger: ".o_offline_systray [data-icon='link_off']",
        },
        {
            content: "the lead visited online is available offline",
            trigger: `body:has(.o_offline_systray [data-icon='link_off']) ${LEAD_CARD}:not(.o_crm_mobile_lead_card_unavailable)`,
        },

        // ---------------------------------------------------------------------
        // Offline edit through the lead form
        // ---------------------------------------------------------------------
        {
            content: "open the lead offline",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_name`,
            run: "click",
        },
        {
            // The lead form renders the name with the text widget, hence a textarea.
            content: "the cached lead form is loaded",
            trigger: ".o_form_view .o_field_widget[name=name] textarea",
        },
        {
            content: "edit the lead name",
            trigger: ".o_form_view .o_field_widget[name=name] textarea",
            run: "edit Offline Tour Lead Edited",
        },
        {
            content: "edit the expected revenue",
            trigger: ".o_form_view .o_field_widget[name=expected_revenue] input",
            run: "edit 4242",
        },
        ...stepUtils.saveForm(),
        {
            content: "go back to the pipeline",
            trigger: ".o_back_button",
            run: "click",
        },
        {
            content: "the pipeline is displayed offline",
            trigger: ".o_crm_mobile_pipeline",
        },

        // ---------------------------------------------------------------------
        // Offline lead creation through the mobile quick create
        // ---------------------------------------------------------------------
        {
            content: "open the mobile quick create",
            trigger: ".o_crm_mobile_pipeline_add",
            run: "click",
        },
        {
            content: "the quick-create bottom sheet is open",
            trigger: ".o_crm_mobile_quick_create",
        },
        {
            content: "enter the lead name",
            trigger: ".o_crm_mobile_quick_create [name=name]",
            run: "edit Offline Tour New Lead",
        },
        {
            content: "enter the contact name",
            trigger: ".o_crm_mobile_quick_create [name=contact_name]",
            run: "edit Offline Tour Contact",
        },
        {
            content: "enter the phone",
            trigger: ".o_crm_mobile_quick_create [name=phone]",
            run: "edit +32470000000",
        },
        {
            content: "enter the email",
            trigger: ".o_crm_mobile_quick_create [name=email_from]",
            run: "edit offline.tour@example.com",
        },
        {
            content: "enter the expected revenue",
            trigger: ".o_crm_mobile_quick_create [name=expected_revenue]",
            run: "edit 1500",
        },
        {
            // The stage select is left on its default, the displayed stage ("New").
            content: "save the new lead",
            trigger: ".o_crm_mobile_quick_create .o_crm_mobile_quick_create_save",
            run: "click",
        },
        {
            content: "the queued lead is shown as a pending card",
            trigger:
                ".o_crm_mobile_lead_card:contains('Offline Tour New Lead') .o_crm_mobile_pending_badge",
        },

        // ---------------------------------------------------------------------
        // Offline follow-up activity through the lead card
        // ---------------------------------------------------------------------
        {
            content: "open the follow-up form of the lead",
            trigger: `${LEAD_CARD} .o_crm_mobile_card_follow_up`,
            run: "click",
        },
        {
            content: "choose the To-Do activity type",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_follow_up .o_crm_mobile_follow_up_type`,
            run: "selectByLabel To-Do",
        },
        {
            content: "enter the follow-up summary",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_follow_up .o_crm_mobile_follow_up_summary`,
            run: "edit Offline tour follow-up",
        },
        {
            // A date input takes its value at once: typing it character by character is refused.
            content: "enter the follow-up due date",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_follow_up .o_crm_mobile_follow_up_date`,
            run() {
                this.anchor.value = "2030-01-15";
                this.anchor.dispatchEvent(new Event("input", { bubbles: true }));
                this.anchor.dispatchEvent(new Event("change", { bubbles: true }));
            },
        },
        {
            content: "save the follow-up",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_follow_up .o_crm_mobile_follow_up_save`,
            run: "click",
        },
        {
            // The follow-up form closes once the activity is queued.
            content: "show the lead's activities",
            trigger: `${LEAD_CARD}:not(:has(.o_crm_mobile_lead_card_follow_up)) .o_crm_mobile_card_activities`,
            run: "click",
        },
        {
            content: "the queued follow-up is listed as pending",
            trigger: `${LEAD_CARD} .o_crm_mobile_activity_row:contains('Offline tour follow-up'):contains('Pending sync')`,
        },

        // ---------------------------------------------------------------------
        // Offline mark-won through the card's stage list
        // ---------------------------------------------------------------------
        {
            content: "open the stage list of the lead",
            trigger: `${LEAD_CARD} .o_crm_mobile_card_stage`,
            run: "click",
        },
        {
            // Exact text: "Generic Won" is another won stage and must not be chosen.
            content: "move the lead to the won stage",
            trigger: `${LEAD_CARD} .o_crm_mobile_lead_card_stage_list .o_crm_mobile_stage_option:text('Won')`,
            run: "click",
        },
        {
            content: "the won stage is displayed",
            trigger: ".o_crm_mobile_pipeline_stage_name:text('Won')",
        },
        {
            content: "the won lead is shown with its pending-sync badge",
            trigger: `${LEAD_CARD} .o_crm_mobile_pending_badge`,
        },

        // ---------------------------------------------------------------------
        // Back online: the framework replays the queue
        // ---------------------------------------------------------------------
        {
            content: "restore the connection",
            trigger: ".o_crm_mobile_pipeline",
            run() {
                if (originalXHR) {
                    browser.XMLHttpRequest = originalXHR;
                    originalXHR = null;
                }
                browser.dispatchEvent(new Event("online"));
            },
        },
        {
            // The systray stays while offline or while calls are queued; a replay the server
            // rejects is parked there, so this step then fails by timeout.
            content: "every queued call has been replayed",
            trigger: "body:not(:has(.o_offline_systray))",
            timeout: 30000,
        },
        {
            // The pipeline reloads after the sync: the lead is now a server record.
            content: "the pipeline shows the replayed lead with no pending-sync badge",
            trigger:
                ".o_crm_mobile_lead_card:contains('Offline Tour Lead Edited'):not(:has(.o_crm_mobile_pending_badge))",
        },
    ],
});
