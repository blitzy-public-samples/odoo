import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    getService,
    mockOffline,
    mockService,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

/**
 * m2-framework-disabled-proofs (VAL-DIS-025). Rows B30/C17
 * (`action_assign_leads`, `views/crm_team_views.xml:144-149`), B31/C18
 * (`action_open_opportunities` stat button, `:206-211`) and B78 ("Activate
 * Multi-team", `addons/sales_team/views/crm_team_views.xml:30`, inherited
 * unchanged) are all plain `<button>`s on the team form with no
 * `data-available-offline`, already disabled by `OfflinePlugin.
 * SELECTORS_TO_DISABLE`. B78's `type="button"` goes through the exact
 * same `ViewButton`/`useViewButtonHandler` click path as the `type=
 * "object"`/`type="action"` ones (`view_button_hook.js`) -- its
 * `beforeExecuteActionButton` override (`crm_team_form.js`) always
 * returns `false` to short-circuit `doActionButton`'s type dispatch
 * before issuing `ir.config_parameter.set_bool` -- but offline the click
 * never reaches that override at all, since the DOM button itself is
 * disabled first. No crm code change is needed for any of the three.
 *
 * On mobile, `ButtonBox` collapses `action_open_opportunities` into its
 * own "More" dropdown (`maxVisibleButtons` is 0 at the XS size --
 * `button_box.js`); "Assign Leads" is the header's only button, and
 * "Activate Multi-team" sits in the alert banner above the button box,
 * so both stay inline either way (`StatusBarButtons` only moves buttons
 * past the first into a dropdown, and the button box is a separate
 * component from the alert). The main test below is desktop-only for
 * that reason; the two mobile tests further down cover, respectively,
 * the stat button (behind the "More" dropdown) and Assign Leads +
 * Activate Multi-team (inline, plus a queue-zero check).
 */
class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    use_leads = fields.Boolean({ default: true });
    use_opportunities = fields.Boolean({ default: true });
    assignment_enabled = fields.Boolean({ default: true });
    opportunity_count = fields.Integer();
    member_warning = fields.Boolean();
    is_membership_multi = fields.Boolean();

    _records = [
        {
            id: 1,
            name: "Sales Team",
            use_leads: true,
            use_opportunities: true,
            assignment_enabled: true,
            opportunity_count: 3,
            member_warning: true,
            is_membership_multi: false,
        },
    ];

    action_assign_leads() {
        return { type: "ir.actions.act_window_close" };
    }
    action_open_opportunities() {
        return { type: "ir.actions.act_window_close" };
    }
}

defineModels([Team]);
defineMailModels();

const FORM_ARCH = `
    <form js_class="crm_team_form">
        <div class="alert alert-info" role="alert" invisible="is_membership_multi or not member_warning">
            <field name="member_warning" class="w-auto"/>
            Working in multiple teams?
            <button name="crm_team_activate_multi_membership" type="button" class="btn btn-link p-0 lh-1">
                Activate "Multi-team"
            </button>
        </div>
        <field name="is_membership_multi" invisible="1"/>
        <field name="use_leads" invisible="1"/>
        <field name="use_opportunities" invisible="1"/>
        <header invisible="not use_leads and not use_opportunities or not assignment_enabled">
            <button name="action_assign_leads" type="object" string="Assign Leads" class="oe_highlight"
                confirm="This will assign leads to all members. Do you want to proceed?"
                invisible="not use_leads and not use_opportunities or not assignment_enabled"/>
        </header>
        <field name="assignment_enabled" invisible="1"/>
        <field name="name"/>
        <div class="oe_button_box" name="button_box">
            <button name="action_open_opportunities" type="object" class="oe_stat_button" icon="star">
                <div class="o_stat_info">
                    <field name="opportunity_count" class="o_stat_value"/>
                    <span class="o_stat_text">Opportunities</span>
                </div>
            </button>
        </div>
    </form>`;

test.tags("desktop");
test("offline, the team form's Assign Leads, Opportunities stat button and Activate Multi-team are all disabled and inert; online they all work", async () => {
    onRpc("res.users", "has_group", () => true);
    onRpc("crm.team", "action_assign_leads", ({ parent }) => {
        expect.step("action_assign_leads");
        return parent();
    });
    onRpc("crm.team", "action_open_opportunities", ({ parent }) => {
        expect.step("action_open_opportunities");
        return parent();
    });
    onRpc("ir.config_parameter", "set_bool", (args) => {
        expect.step("set_bool");
        expect(args.args).toEqual(["sales_team.membership_multi", true]);
        return true;
    });
    let reloaded = false;
    mockService("action", {
        doAction(action) {
            if (action === "reload") {
                reloaded = true;
                return true;
            }
            return super.doAction(...arguments);
        },
    });

    await mountView({ resModel: "crm.team", type: "form", resId: 1, arch: FORM_ARCH });

    const assignBtn = "button[name='action_assign_leads']";
    const statBtn = "button[name='action_open_opportunities']";
    const multiTeamBtn = "button[name='crm_team_activate_multi_membership']";
    for (const sel of [assignBtn, statBtn, multiTeamBtn]) {
        expect(sel).not.toHaveAttribute("disabled");
    }

    const setOffline = mockOffline();
    await setOffline(true);

    for (const sel of [assignBtn, statBtn, multiTeamBtn]) {
        expect(sel).toHaveAttribute("disabled");
        expect(sel).toHaveClass("o_disabled_offline");
    }
    // "Assign Leads" carries a `confirm` dialog, opened only once the click
    // reaches `view_button_hook.js` -- it never does, so no dialog shows.
    await contains(assignBtn).click();
    expect(".modal").toHaveCount(0);
    await contains(statBtn).click();
    await contains(multiTeamBtn).click();
    expect.verifySteps([]); // none of the three RPCs fired, and no reload happened
    expect(reloaded).toBe(false);

    await setOffline(false);
    for (const sel of [assignBtn, statBtn, multiTeamBtn]) {
        expect(sel).not.toHaveAttribute("disabled");
        expect(sel).not.toHaveClass("o_disabled_offline");
    }

    await contains(statBtn).click();
    expect.verifySteps(["action_open_opportunities"]);

    await contains(assignBtn).click();
    expect(".modal").toHaveCount(1); // online, the confirm dialog shows up
    await contains(".modal .btn-primary").click();
    expect.verifySteps(["action_assign_leads"]);

    await contains(multiTeamBtn).click();
    expect.verifySteps(["set_bool"]);
    expect(reloaded).toBe(true); // online, it still works end-to-end
});

test.tags("mobile");
test("offline, the Opportunities stat button is disabled once its mobile 'More' dropdown is open; online it works again", async () => {
    onRpc("res.users", "has_group", () => true);
    onRpc("crm.team", "action_open_opportunities", ({ parent }) => {
        expect.step("action_open_opportunities");
        return parent();
    });

    await mountView({ resModel: "crm.team", type: "form", resId: 1, arch: FORM_ARCH });

    const statBtn = "button[name='action_open_opportunities']";
    // The button-box's own "More" toggler carries `data-available-offline`
    // (opening it to look is harmless); the single stat button is
    // collapsed into it because `maxVisibleButtons` is 0 at the XS size.
    // Note: the compiled `ButtonBox` component drops the arch's
    // `oe_button_box` class in favor of its own `o-form-buttonbox` --
    // `.o_button_more` alone is the stable selector for the toggler.
    await contains(".o_button_more").click();
    expect(statBtn).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_button_more").not.toHaveAttribute("disabled"); // the toggler itself still opens
    expect(statBtn).toHaveAttribute("disabled");
    expect(statBtn).toHaveClass("o_disabled_offline");
    await contains(statBtn).click();
    expect.verifySteps([]); // the RPC never fired

    await setOffline(false);
    expect(statBtn).not.toHaveAttribute("disabled");
    await contains(statBtn).click();
    expect.verifySteps(["action_open_opportunities"]); // online, it still works
});

test.tags("mobile");
test("offline, the team form's Assign Leads and Activate Multi-team stay inline and disabled on mobile, with nothing queued; online they work", async () => {
    onRpc("res.users", "has_group", () => true);
    onRpc("crm.team", "action_assign_leads", ({ parent }) => {
        expect.step("action_assign_leads");
        return parent();
    });
    onRpc("ir.config_parameter", "set_bool", (args) => {
        expect.step("set_bool");
        expect(args.args).toEqual(["sales_team.membership_multi", true]);
        return true;
    });

    await mountView({ resModel: "crm.team", type: "form", resId: 1, arch: FORM_ARCH });

    const assignBtn = "button[name='action_assign_leads']";
    const multiTeamBtn = "button[name='crm_team_activate_multi_membership']";
    // Unlike the stat button, neither of these is collapsed into the
    // button-box's mobile "More" dropdown: "Assign Leads" is in the
    // header, "Activate Multi-team" in the alert banner above the button
    // box, so both stay inline at the XS size and the disablement is
    // visible without opening anything first.
    for (const sel of [assignBtn, multiTeamBtn]) {
        expect(sel).not.toHaveAttribute("disabled");
    }

    const setOffline = mockOffline();
    await setOffline(true);

    for (const sel of [assignBtn, multiTeamBtn]) {
        expect(sel).toHaveAttribute("disabled");
        expect(sel).toHaveClass("o_disabled_offline");
    }
    await contains(assignBtn).click();
    expect(".modal").toHaveCount(0); // "Assign Leads"'s confirm dialog never opens offline
    await contains(multiTeamBtn).click();
    expect.verifySteps([]); // neither RPC fired
    expect(Object.keys(getService(OfflinePlugin)._ormToSync()).length).toBe(0); // and nothing queued

    await setOffline(false);
    for (const sel of [assignBtn, multiTeamBtn]) {
        expect(sel).not.toHaveAttribute("disabled");
    }
    await contains(assignBtn).click();
    expect(".modal").toHaveCount(1);
    await contains(".modal .btn-primary").click();
    expect.verifySteps(["action_assign_leads"]);
    await contains(multiTeamBtn).click();
    expect.verifySteps(["set_bool"]);
});
