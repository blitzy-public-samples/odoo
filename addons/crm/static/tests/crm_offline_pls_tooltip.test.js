import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { WebClient } from "@web/webclient/webclient";
import { CrmPlsTooltipButton } from "@crm/views/crm_form/crm_pls_tooltip_button";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * Defect 6 (architecture.md §3.2 item 6 / offline_inventory.md rows
 * A10/A11/B9/B10/C13): the PLS tooltip button
 * (`views/crm_form/crm_pls_tooltip_button.xml`) is a plain `<button>` with
 * no `data-available-offline` attribute, so `OfflinePlugin.
 * SELECTORS_TO_DISABLE` already disables it offline on its own -- no crm
 * code change is needed to disable it, only a test proving that disabled
 * state actually blocks `onClickPlsTooltipButton` (and therefore both
 * `prepare_pls_tooltip_data` and the follow-up `record.load()` reload),
 * the same framework-owned-button pattern already used for the team
 * switcher's "Manage Teams" (crm_offline_team_switcher.test.js,
 * VAL-DIS-010).
 *
 * A native disabled `<button>` cannot receive focus and does not dispatch
 * a `click` event even when one is simulated, so there is no separate
 * keyboard variant below: the DOM `disabled` assertion plus the
 * click-does-nothing assertion already cover "click or keyboard"
 * (VAL-DIS-003).
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    probability = fields.Float();
    won_status = fields.Char();
    is_automated_probability = fields.Boolean();

    _records = [
        {
            id: 1,
            name: "Lead 1",
            probability: 20,
            won_status: "pending",
            is_automated_probability: true,
        },
    ];

    prepare_pls_tooltip_data() {
        return { probability: 42, low_3_data: {}, top_3_data: {}, team_name: "Team 1" };
    }
}

defineModels([Lead]);
defineMailModels();

const formView = {
    resModel: "crm.lead",
    type: "form",
    resId: 1,
    arch: `
        <form js_class="crm_form">
            <field name="won_status" invisible="1"/>
            <field name="is_automated_probability" invisible="1"/>
            <field name="probability"/>
            <widget name="pls_tooltip_button"/>
        </form>`,
};

test("offline, the PLS tooltip button is disabled and unreachable; no prepare_pls_tooltip_data RPC or reload is issued", async () => {
    onRpc("crm.lead", "prepare_pls_tooltip_data", () => expect.step("prepare_pls_tooltip_data"));
    const setOffline = mockCrmOffline();
    await mountView(formView);

    const button = ".o_crm_pls_tooltip_button";
    expect(button).not.toHaveAttribute("disabled");

    await setOffline(true);
    expect(button).toHaveAttribute("disabled");
    expect(button).toHaveClass("o_disabled_offline");

    await contains(button).click();
    expect(".o_crm_pls_tooltip").toHaveCount(0); // popover never opened
    expect.verifySteps([]); // prepare_pls_tooltip_data was never called

    await setOffline(false);
    expect(button).not.toHaveAttribute("disabled");
    expect(button).not.toHaveClass("o_disabled_offline");
});

// ---------------------------------------------------------------------------
// Scrutiny finding 7 (VAL-DIS-003): the button is only reachable through
// the already-guarded DOM path above, but the DISABLE convention also
// requires the direct handler path to do nothing.
// `onClickPlsTooltipButton()` has no offline guard of its own before this
// fix -- calling it directly still saves the record (queuing a dirty
// edit), calls `prepare_pls_tooltip_data`, and reloads.
// ---------------------------------------------------------------------------

test("offline, calling the PLS tooltip handler directly issues no save, lookup or reload", async () => {
    const calls = [];
    const record = {
        resId: 1,
        save: () => {
            calls.push("save");
            return Promise.resolve(true);
        },
        load: () => {
            calls.push("load");
            return Promise.resolve();
        },
    };
    onRpc("crm.lead", "prepare_pls_tooltip_data", () => expect.step("prepare_pls_tooltip_data"));
    const setOffline = mockCrmOffline();
    await mountWithCleanup(WebClient);
    const comp = await mountWithCleanup(CrmPlsTooltipButton, { props: { record } });
    await setOffline(true);

    await comp.onClickPlsTooltipButton({ currentTarget: document.createElement("button") });

    expect(calls).toEqual([]); // neither save() nor load() was called
    expect.verifySteps([]); // prepare_pls_tooltip_data was never called
    expect(comp.popover.isOpen).toBe(false);
});

test("online, the PLS tooltip button still opens and calls prepare_pls_tooltip_data (guard)", async () => {
    onRpc("crm.lead", "prepare_pls_tooltip_data", ({ parent }) => {
        expect.step("prepare_pls_tooltip_data");
        return parent();
    });
    await mountView(formView);

    await contains(".o_crm_pls_tooltip_button").click();

    expect.verifySteps(["prepare_pls_tooltip_data"]);
    expect(".o_crm_pls_tooltip").toHaveCount(1);
});
