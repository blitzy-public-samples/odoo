import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    models,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { LeadGenerationDropdown } from "@crm/components/lead_generation_dropdown/lead_generation_dropdown";
import { mockCrmOffline } from "@crm/../tests/crm_test_helpers";

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
