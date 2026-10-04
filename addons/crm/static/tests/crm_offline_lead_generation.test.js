import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountWithCleanup,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { user } from "@web/core/user";
import { WebClient } from "@web/webclient/webclient";
import { LeadGenerationDropdown } from "@crm/components/lead_generation_dropdown/lead_generation_dropdown";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * Defect 4 (architecture.md §3.2 item 4 / offline_inventory.md rows
 * A19/A20/A21/A22/A23): the lead generation "Generate" toggler
 * (`components/lead_generation_dropdown/lead_generation_dropdown.xml`) is a
 * plain `<button>` with no `data-available-offline` attribute, so
 * `OfflinePlugin.SELECTORS_TO_DISABLE` already disables it offline on its
 * own -- no crm code change is needed to disable it, only a test proving
 * that disabled state actually blocks `toggleDropdown()` (and therefore
 * the `ir.module.module` `search_read` and the dead-code
 * `user.checkAccessRight` path it would otherwise reach), the same
 * framework-owned-button pattern already used for the team switcher's
 * "Manage Teams" (crm_offline_team_switcher.test.js, VAL-DIS-010).
 *
 * Mounts the component directly (as crm_offline_team_switcher.test.js does
 * for `TeamSwitcher` and crm_offline_mrr.test.js for `CrmColumnProgress`),
 * decoupled from the kanban view's control panel: on a small screen, the
 * generic `web.ControlPanel` collapses its `control-panel-buttons` slot
 * into a "..." kebab menu (`control_panel.js`'s `dropdownifyButtons`),
 * which is unrelated plumbing this feature doesn't touch -- the toggler is
 * disabled offline the same way, and reachable or not, regardless of how
 * many dropdown layers wrap it.
 *
 * A native disabled `<button>` cannot receive focus and does not dispatch
 * a `click` event even when one is simulated (same reasoning the team
 * switcher tests rely on), so there is no separate keyboard/accesskey
 * variant below: the DOM `disabled` assertion plus the click-does-nothing
 * assertion already cover "click, keyboard and its accesskey do nothing"
 * (VAL-DIS-012).
 */

class IrModuleModule extends models.Model {
    _name = "ir.module.module";

    name = fields.Char();
    shortdesc = fields.Char();

    _records = [
        { id: 1, name: "crm_iap_mine", shortdesc: "Lead Mining" },
        { id: 2, name: "website", shortdesc: "Website" },
        { id: 3, name: "mass_mailing", shortdesc: "Email Marketing" },
        { id: 4, name: "survey", shortdesc: "Survey" },
    ];
}

defineModels([IrModuleModule]);
defineMailModels();

test("offline, the lead generation toggler is disabled and unreachable; no module search_read or access-right RPC is issued", async () => {
    onRpc("ir.module.module", "search_read", () => expect.step("search_read"));
    onRpc(({ method }) => {
        if (method === "has_access") {
            expect.step("has_access"); // checkAccessRight's underlying RPC
        }
    });
    // `mockCrmOffline()`'s `setOffline()` needs a running test app/service
    // registry (`getService(OfflinePlugin)`), so a throwaway WebClient is
    // mounted first purely to bring that up; it does nothing else here.
    // Unlike crm_offline_team_switcher.test.js's equivalent test, no
    // "/mail/store" error is declared: that poll already settles during
    // the `LeadGenerationDropdown` mount below, before `setOffline(true)`
    // flips the connection, so there's no in-flight request left to abort.
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await mountWithCleanup(LeadGenerationDropdown);

    const toggler = ".o-dropdown-caret.btn-secondary";
    expect(toggler).not.toHaveAttribute("disabled");

    await setOffline(true);
    expect(toggler).toHaveAttribute("disabled");
    expect(toggler).toHaveClass("o_disabled_offline");

    await contains(toggler).click();
    expect(".o_lead_mining_menu_choices").toHaveCount(0); // dropdown never opened
    expect.verifySteps([]); // neither RPC was issued

    await setOffline(false);
    expect(toggler).not.toHaveAttribute("disabled");
    expect(toggler).not.toHaveClass("o_disabled_offline");
});

// ---------------------------------------------------------------------------
// Scrutiny finding 6 (VAL-DIS-012): the toggler and its items are only
// reachable through the already-guarded DOM path above, but the DISABLE
// convention also requires the direct programmatic/handler path to do
// nothing. `toggleDropdown()`/`onClickAction()` have no offline guard of
// their own before this fix -- calling them directly still reaches the
// module `search_read`/access-right probe and the install/import actions.
// ---------------------------------------------------------------------------

test("offline, calling the lead generation handlers directly issues no RPC or action", async () => {
    onRpc("ir.module.module", "search_read", () => expect.step("search_read"));
    onRpc(({ method }) => {
        if (method === "has_access") {
            expect.step("has_access");
        }
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    const comp = await mountWithCleanup(LeadGenerationDropdown);
    await setOffline(true);

    await comp.toggleDropdown();
    expect(comp.dropdown.isOpen).toBe(false); // never opened
    expect.verifySteps([]); // neither RPC was issued

    // Direct call with an element that would otherwise reach either the
    // access-request dialog or an install/import action.
    comp.onClickAction(comp.sortedDropdownContentElements[0]);
    expect(".o_dialog").toHaveCount(0);
    expect.verifySteps([]);
});

test("online, the lead generation toggler opens and issues the module search_read (guard)", async () => {
    onRpc("ir.module.module", "search_read", ({ parent }) => {
        expect.step("search_read");
        return parent();
    });
    await mountWithCleanup(LeadGenerationDropdown);

    const toggler = ".o-dropdown-caret.btn-secondary";
    await contains(toggler).click();

    expect.verifySteps(["search_read"]);
    expect(".o_lead_mining_menu_choices").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Scrutiny round-3 (VAL-DIS-012): the two tests above only cover the entry
// handlers (`toggleDropdown`/`onClickAction`); they don't exercise an
// Install confirmation that was already open and offline-available
// (`data-available-offline` on every `web.ConfirmationDialog` Confirm
// button, `confirmation_dialog.xml`) before the connection drops. Its
// `confirm` callback is a closure created at dialog-open time, so a guard
// at the entry handlers alone cannot stop it once it is already open.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("an Install confirmation opened online cannot be confirmed after disconnecting; no button_immediate_install RPC, nothing queued, no error dialog", async () => {
    patchWithCleanup(user, { isAdmin: true });
    onRpc("ir.module.module", "search_read", ({ parent }) => {
        expect.step("search_read");
        return parent();
    });
    onRpc("ir.module.module", "button_immediate_install", () => {
        expect.step("button_immediate_install");
        return true;
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await mountWithCleanup(LeadGenerationDropdown);

    // Open the dropdown and the Install confirmation while still online.
    await contains(".o-dropdown-caret.btn-secondary").click();
    expect.verifySteps(["search_read"]);
    await contains("[data-module-xml-id='base.module_crm_iap_mine']").click();
    expect(".modal-footer button.btn-primary").toHaveCount(1); // the Install confirmation is open

    // The connection drops with the dialog still open; its Confirm button
    // is not disabled by the framework (it carries `data-available-offline`
    // like every `web.ConfirmationDialog` button).
    await setOffline(true);
    expect(".modal-footer button.btn-primary").not.toHaveAttribute("disabled");

    await contains(".modal-footer button.btn-primary").click();
    expect.verifySteps([]); // no button_immediate_install call, queued or sent
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_dialog").toHaveCount(0); // dialog closed itself; no error dialog shown

    // Reconnect before the test ends: every other offline test in this
    // suite leaves its mocked connection online again, and ending offline
    // would leave the real `OfflinePlugin`'s reconnection probing (its
    // `/web/webclient/version_info` backoff ping, AGENTS.md section 2)
    // armed on a `setTimeout` outside this torn-down test's own cleanup.
    await setOffline(false);
});

test.tags("mobile");
test("an Install confirmation opened online cannot be confirmed after disconnecting; no button_immediate_install RPC, nothing queued, no error dialog (mobile)", async () => {
    patchWithCleanup(user, { isAdmin: true });
    onRpc("ir.module.module", "search_read", ({ parent }) => {
        expect.step("search_read");
        return parent();
    });
    onRpc("ir.module.module", "button_immediate_install", () => {
        expect.step("button_immediate_install");
        return true;
    });
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    await mountWithCleanup(LeadGenerationDropdown);

    // Open the dropdown and the Install confirmation while still online.
    await contains(".o-dropdown-caret.btn-secondary").click();
    expect.verifySteps(["search_read"]);
    await contains("[data-module-xml-id='base.module_crm_iap_mine']").click();
    expect(".modal-footer button.btn-primary").toHaveCount(1); // the Install confirmation is open

    // The connection drops with the dialog still open; its Confirm button
    // is not disabled by the framework (it carries `data-available-offline`
    // like every `web.ConfirmationDialog` button).
    await setOffline(true);
    expect(".modal-footer button.btn-primary").not.toHaveAttribute("disabled");

    await contains(".modal-footer button.btn-primary").click();
    expect.verifySteps([]); // no button_immediate_install call, queued or sent
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_dialog").toHaveCount(0); // dialog closed itself; no error dialog shown

    // See the desktop variant above for why this test reconnects before
    // ending instead of finishing while still offline.
    await setOffline(false);
});

test.tags("desktop");
test("online, an Install confirmation's own Confirm still issues button_immediate_install (guard)", async () => {
    patchWithCleanup(user, { isAdmin: true });
    onRpc("ir.module.module", "search_read", ({ parent }) => {
        expect.step("search_read");
        return parent();
    });
    // A real success would resolve and call the component's own
    // `location.reload()`, navigating the actual test page away; the real
    // `window.location.reload` can't be patched out (non-configurable in a
    // real browser), so the mock RPC is left pending instead -- enough to
    // prove the real callback (not the offline early-return) reached the
    // network, without ever letting it resolve into `location.reload()`.
    onRpc("ir.module.module", "button_immediate_install", () => {
        expect.step("button_immediate_install");
        return new Promise(() => {});
    });
    await mountWithCleanup(LeadGenerationDropdown);

    await contains(".o-dropdown-caret.btn-secondary").click();
    expect.verifySteps(["search_read"]);
    await contains("[data-module-xml-id='base.module_crm_iap_mine']").click();
    expect(".modal-footer button.btn-primary").toHaveCount(1);

    await contains(".modal-footer button.btn-primary").click();
    expect.verifySteps(["button_immediate_install"]);
});
