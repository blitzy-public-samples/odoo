import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { advanceTime } from "@odoo/hoot-mock";
import { contains, defineModels, fields, mockOffline, models, mountView, onRpc } from "@web/../tests/web_test_helpers";

/**
 * VAL-DIS-027 (B41-B47): the UTM campaign kanban `<a>` gets its own click
 * test (B43); the rest are framework-owned `<button>`s, so proportionate
 * proof applies -- one representative test per view family plus DOM
 * checks, per the contract's own wording for this row.
 */

class Campaign extends models.Model {
    _name = "utm.campaign";

    name = fields.Char();
    crm_lead_count = fields.Integer();

    _records = [{ id: 1, name: "Campaign A", crm_lead_count: 3 }];

    _views = {
        kanban: `
            <kanban>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                        <a type="object" name="action_redirect_to_leads_opportunities" class="o_b43_link">
                            <field name="crm_lead_count"/>
                        </a>
                    </t>
                </templates>
            </kanban>`,
        form: `
            <form>
                <div class="oe_button_box">
                    <button name="action_redirect_to_leads_opportunities" type="object" class="oe_stat_button">B44</button>
                </div>
                <field name="name"/>
            </form>`,
    };
}

class LostReason extends models.Model {
    _name = "crm.lost.reason";

    name = fields.Char();

    _records = [{ id: 1, name: "Too expensive" }];

    _views = {
        form: `
            <form>
                <div class="oe_button_box">
                    <button name="action_lost_leads" type="object" class="oe_stat_button">B41</button>
                </div>
                <field name="name"/>
            </form>`,
    };
}

// `res.partner` is already defined by `defineMailModels()` (mail's own
// `ResPartner` mock model, used by the chatter and partner-link tests
// elsewhere); redefining it with a bare `models.Model` subclass here would
// conflict with that registration, so this family only overrides the
// arch (via `mountView`'s own `arch` param, independent of `_views`) and
// gets its record from `startServer()`'s `pyEnv` instead of a `_records`
// array, same as `crm_offline_chatter.test.js`.
const PARTNER_FORM_ARCH = `
    <form>
        <div class="oe_button_box">
            <button name="action_view_opportunity" type="object" class="oe_stat_button">B42</button>
        </div>
        <field name="name"/>
    </form>`;

// B45/B46/B47 (`res.config.settings`): three independent settings
// navigation/wizard buttons, mocked here with their own minimal form
// rather than the real (much larger) settings page -- the mechanism under
// test is the framework's generic `<button>` disable, identical regardless
// of which form hosts the button.
class Settings extends models.Model {
    _name = "res.config.settings";

    _records = [{ id: 1 }];

    _views = {
        form: `
            <form>
                <button name="crm_recurring_plan_action" type="action" class="o_b45_btn">B45</button>
                <button name="crm_lead_pls_update_action" type="action" class="o_b46_btn">B46</button>
                <button name="action_crm_assign_leads" type="object" class="o_b47_btn">B47</button>
            </form>`,
    };
}

defineModels([Campaign, LostReason, Settings]);
defineMailModels();

// ---------------------------------------------------------------------------
// B43: the UTM campaign kanban `<a type="object">` gets its own click test.
// Same mechanism and production code as the team dashboard's B32-B39
// (`kanban_action_button_patch.js`, scoped to `["crm.team", "utm.campaign"]`)
// -- see crm_offline_team_dashboard.test.js for the sibling proof.
// ---------------------------------------------------------------------------

test("offline, the UTM campaign kanban link issues no call_kw; online it still does (desktop)", async () => {
    onRpc("utm.campaign", "action_redirect_to_leads_opportunities", () => {
        expect.step("B43");
        return false;
    });
    await mountView({ resModel: "utm.campaign", type: "kanban", arch: Campaign._views.kanban });

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_b43_link").click();
    expect.verifySteps([]);

    await setOffline(false);
    // `<a type="object">` kanban action buttons carry a 300ms debounce
    // (card_compiler.js's `compileButton`); the offline click above
    // already started that window on this same button, so this re-click
    // needs it to elapse first, same as crm_offline_team_dashboard's B32.
    await advanceTime(300);

    await contains(".o_b43_link").click();
    expect.verifySteps(["B43"]);
});

test.tags("mobile");
test("offline, the UTM campaign kanban link issues no call_kw; online it still does (mobile)", async () => {
    onRpc("utm.campaign", "action_redirect_to_leads_opportunities", () => {
        expect.step("B43");
        return false;
    });
    await mountView({ resModel: "utm.campaign", type: "kanban", arch: Campaign._views.kanban });

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_b43_link").click();
    expect.verifySteps([]);

    await setOffline(false);
    await advanceTime(300); // let B43's 300ms action-button debounce elapse

    await contains(".o_b43_link").click();
    expect.verifySteps(["B43"]);
});

// ---------------------------------------------------------------------------
// B41, B42, B44, B45-B47: proportionate proof. Each is a plain `<button>`
// with no `data-available-offline`, so `OfflinePlugin.SELECTORS_TO_DISABLE`
// already disables it offline -- one representative test per view family
// (lost reason form, partner form, campaign form, settings form) plus DOM
// checks; no production code change needed for any of these five.
// ---------------------------------------------------------------------------

const BUTTON_FAMILIES = [
    {
        label: "crm.lost.reason form (B41)",
        resModel: "crm.lost.reason",
        arch: LostReason._views.form,
        selector: "button[name='action_lost_leads']",
        getResId: () => 1,
    },
    {
        label: "res.partner form (B42)",
        resModel: "res.partner",
        arch: PARTNER_FORM_ARCH,
        selector: "button[name='action_view_opportunity']",
        getResId: async () => (await startServer())["res.partner"].create({ name: "Azure Interior" }),
    },
    {
        label: "utm.campaign form (B44)",
        resModel: "utm.campaign",
        arch: Campaign._views.form,
        selector: "button[name='action_redirect_to_leads_opportunities']",
        getResId: () => 1,
    },
];

for (const { label, resModel, arch, selector, getResId } of BUTTON_FAMILIES) {
    test(`offline, the ${label} stat button is disabled; online it still works`, async () => {
        const resId = await getResId();
        await mountView({ resModel, type: "form", resId, arch });
        expect(selector).toHaveCount(1);

        const setOffline = mockOffline();
        await setOffline(true);
        expect(selector).toHaveAttribute("disabled");
        expect(selector).toHaveClass("o_disabled_offline");

        await setOffline(false);
        expect(selector).not.toHaveAttribute("disabled");
    });
}

test("offline, the settings form's three navigation/wizard buttons (B45-B47) are disabled; online they still work", async () => {
    await mountView({ resModel: "res.config.settings", type: "form", resId: 1, arch: Settings._views.form });
    expect(".o_b45_btn").toHaveCount(1);
    expect(".o_b46_btn").toHaveCount(1);
    expect(".o_b47_btn").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    for (const selector of [".o_b45_btn", ".o_b46_btn", ".o_b47_btn"]) {
        expect(selector).toHaveAttribute("disabled");
        expect(selector).toHaveClass("o_disabled_offline");
    }

    await setOffline(false);

    for (const selector of [".o_b45_btn", ".o_b46_btn", ".o_b47_btn"]) {
        expect(selector).not.toHaveAttribute("disabled");
    }
});
