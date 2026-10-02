import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { contains, defineModels, fields, mockOffline, models, mountView, onRpc } from "@web/../tests/web_test_helpers";

/**
 * m2-framework-disabled-proofs (VAL-DIS-001). Rows B2, B4, B6, B7, B12,
 * B13, C8, C10, C11, C12 are all plain `<button type="object">` or
 * `<button type="action">` elements on `crm_lead_view_form`
 * (`views/crm_lead_views.xml:12-17,33-50,212-228`) that carry no
 * `data-available-offline`. `OfflinePlugin.SELECTORS_TO_DISABLE`
 * (`button:not([data-available-offline]):not([disabled])`) already
 * disables every one of them offline, including the Won button
 * (`action_set_won_rainbowman`, C8) -- milestone 3 is what gives Won its
 * own offline producer; today it is still a bare disabled button, so "no
 * `action_set_won_rainbowman` call is issued or queued offline" already
 * holds with no crm code. This test only proves the framework's own
 * disablement reaches every row; no crm change is needed (no gap found).
 *
 * `data-hotkey` doesn't bypass this: the hotkey plugin's own target
 * selector is `[data-hotkey]:not(:disabled)`
 * (`addons/web/static/src/core/hotkeys/hotkey_plugin.js:281`), so a
 * disabled button is never matched and its hotkey is a no-op -- proven
 * here by asserting `disabled` rather than by re-simulating every hotkey.
 *
 * C10/C11/C12 (`action_schedule_meeting`, `action_show_potential_duplicates`,
 * `action_convert_to_opportunity`) are the methods B6/B7/B2 call; proving
 * those buttons issue no RPC offline already proves the methods are
 * unreached, so this file does not duplicate a Python-method-level test.
 *
 * On mobile (`ui.size` XS), `ButtonBox.buttonLayout` collapses every stat
 * button into a "More" dropdown (`maxVisibleButtons` is 0 at XS --
 * `button_box.js`) and `StatusBarButtons` keeps only the first visible
 * header button inline, moving the rest into its own dropdown
 * (`status_bar_buttons.xml`). The two tests below are desktop-only for
 * that reason -- a bare `button[name=...]` selector can't reach a button
 * that isn't rendered until its dropdown opens -- and the mobile tests
 * further down open each dropdown explicitly to prove the same mechanism
 * holds once revealed. `ButtonBox`'s own "More" toggler carries
 * `data-available-offline` (clicking it is harmless, since the buttons
 * inside still disable individually), but `StatusBarButtons`' toggler
 * does not, so on mobile the header dropdown itself becomes unreachable
 * offline -- an even stronger guarantee than desktop for "Lost".
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    type = fields.Selection({ selection: [["lead", "Lead"], ["opportunity", "Opportunity"]] });
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        selection: [["pending", "Pending"], ["won", "Won"], ["lost", "Lost"]],
    });
    duplicate_lead_count = fields.Integer();
    meeting_display_label = fields.Char();
    meeting_display_date = fields.Date();
    is_blacklisted = fields.Boolean();
    phone_blacklisted = fields.Boolean();
    email_from = fields.Char();
    phone = fields.Char();

    _records = [
        {
            id: 1,
            name: "Opportunity 1",
            type: "opportunity",
            active: true,
            won_status: "pending",
            duplicate_lead_count: 2,
            meeting_display_label: "Meetings",
            is_blacklisted: true,
            phone_blacklisted: true,
            email_from: "blacklisted@example.com",
            phone: "+1 555 0000",
        },
        {
            id: 2,
            name: "Lead 1",
            type: "lead",
            active: true,
            won_status: "pending",
            duplicate_lead_count: 0,
            is_blacklisted: false,
            phone_blacklisted: false,
        },
    ];

    action_set_won_rainbowman() {
        return false;
    }
    action_convert_to_opportunity() {
        return false;
    }
    action_schedule_meeting() {
        return { type: "ir.actions.act_window_close" };
    }
    action_show_potential_duplicates() {
        return { type: "ir.actions.act_window_close" };
    }
    mail_action_blacklist_remove() {
        return false;
    }
    phone_action_blacklist_remove() {
        return false;
    }
}

defineModels([Lead]);
defineMailModels();

// Reproduces the real header + stat-button + blacklist-remove markup from
// `crm_lead_view_form` verbatim (reduced to the fields these buttons'
// `invisible` expressions need).
const FORM_ARCH = `
    <form class="o_lead_opportunity_form" js_class="crm_form">
        <header>
            <button name="action_set_won_rainbowman" string="Won"
                type="object" class="oe_highlight" data-hotkey="w"
                invisible="won_status == 'won' or type == 'lead' or not active"/>
            <button name="action_convert_to_opportunity" string="Convert to Opportunity" type="object"
                class="oe_highlight" invisible="type == 'opportunity' or not active" data-hotkey="v"/>
            <button name="%(crm.crm_lead_lost_action)d" string="Lost" type="action" data-hotkey="l"
                invisible="won_status != 'pending' or not active"/>
        </header>
        <sheet>
            <field name="type" invisible="1"/>
            <field name="active" invisible="1"/>
            <field name="won_status" invisible="1"/>
            <field name="is_blacklisted" invisible="1"/>
            <field name="phone_blacklisted" invisible="1"/>
            <div class="oe_button_box" name="button_box">
                <button name="action_schedule_meeting" type="object"
                    class="oe_stat_button" icon="calendar_today"
                    invisible="not id or type == 'lead'">
                    <div class="o_stat_info">
                        <span class="o_stat_text"><field name="meeting_display_label"/></span>
                    </div>
                </button>
                <button name="action_show_potential_duplicates" type="object"
                    class="oe_stat_button" icon="star"
                    invisible="duplicate_lead_count &lt; 1">
                    <div class="o_stat_info">
                        <field name="duplicate_lead_count" class="o_stat_value"/>
                    </div>
                </button>
            </div>
            <button name="mail_action_blacklist_remove" class="oi text-danger" data-icon="block"
                type="object" invisible="not is_blacklisted"/>
            <field name="email_from"/>
            <button name="phone_action_blacklist_remove" class="oi text-danger" data-icon="block"
                type="object" invisible="not phone_blacklisted"/>
            <field name="phone"/>
        </sheet>
    </form>`;

test.tags("desktop");
test("offline, the lead form's header and stat buttons are disabled and issue no RPC; online they work (opportunity record)", async () => {
    onRpc("crm.lead", "action_set_won_rainbowman", () => expect.step("action_set_won_rainbowman"));
    onRpc("crm.lead", "action_schedule_meeting", ({ parent }) => {
        expect.step("action_schedule_meeting");
        return parent();
    });
    onRpc("crm.lead", "action_show_potential_duplicates", ({ parent }) => {
        expect.step("action_show_potential_duplicates");
        return parent();
    });
    onRpc("crm.lead", "mail_action_blacklist_remove", () => expect.step("mail_action_blacklist_remove"));
    onRpc("crm.lead", "phone_action_blacklist_remove", () => expect.step("phone_action_blacklist_remove"));

    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    const buttons = [
        "button[name='action_set_won_rainbowman']",
        "button[name='action_schedule_meeting']",
        "button[name='action_show_potential_duplicates']",
        "button[name='mail_action_blacklist_remove']",
        "button[name='phone_action_blacklist_remove']",
    ];
    for (const sel of buttons) {
        expect(sel).not.toHaveAttribute("disabled");
    }

    const setOffline = mockOffline();
    await setOffline(true);

    for (const sel of buttons) {
        expect(sel).toHaveAttribute("disabled");
        expect(sel).toHaveClass("o_disabled_offline");
        await contains(sel).click();
    }
    expect.verifySteps([]); // none of the five RPCs was issued or queued

    await setOffline(false);
    for (const sel of buttons) {
        expect(sel).not.toHaveAttribute("disabled");
        expect(sel).not.toHaveClass("o_disabled_offline");
    }
    await contains("button[name='action_set_won_rainbowman']").click();
    await contains("button[name='action_schedule_meeting']").click();
    await contains("button[name='action_show_potential_duplicates']").click();
    await contains("button[name='mail_action_blacklist_remove']").click();
    await contains("button[name='phone_action_blacklist_remove']").click();
    expect.verifySteps([
        "action_set_won_rainbowman",
        "action_schedule_meeting",
        "action_show_potential_duplicates",
        "mail_action_blacklist_remove",
        "phone_action_blacklist_remove",
    ]); // online, every button still works
});

test.tags("desktop");
test("offline, 'Convert to Opportunity' (type=object) and 'Lost' (type=action, with its hotkey) are disabled on a lead record; online 'Convert to Opportunity' still works", async () => {
    onRpc("crm.lead", "action_convert_to_opportunity", ({ parent }) => {
        expect.step("action_convert_to_opportunity");
        return parent();
    });
    // "Lost"'s action target is left unresolved on purpose, same convention
    // as crm_offline_team_dashboard.test.js's B33-39: if the offline click
    // below ever reached `doActionButton`, the unmocked `/web/action/load`
    // call would surface as an uncaught "action not found" error and fail
    // the test -- the absence of that error is itself part of the proof.
    await mountView({ resModel: "crm.lead", type: "form", resId: 2, arch: FORM_ARCH });

    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect("button[name='%(crm.crm_lead_lost_action)d']").not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect("button[name='action_convert_to_opportunity']").toHaveAttribute("disabled");
    expect("button[name='action_convert_to_opportunity']").toHaveClass("o_disabled_offline");
    expect("button[name='%(crm.crm_lead_lost_action)d']").toHaveAttribute("disabled");
    expect("button[name='%(crm.crm_lead_lost_action)d']").toHaveClass("o_disabled_offline");

    await contains("button[name='action_convert_to_opportunity']").click();
    await contains("button[name='%(crm.crm_lead_lost_action)d']").click();
    expect.verifySteps([]); // neither button's call was issued or queued

    await setOffline(false);
    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect("button[name='%(crm.crm_lead_lost_action)d']").not.toHaveAttribute("disabled");
    await contains("button[name='action_convert_to_opportunity']").click();
    expect.verifySteps(["action_convert_to_opportunity"]); // online, it still works
});

test.tags("mobile");
test("offline, the lead form's header button and a button-box stat button are disabled once their mobile dropdown is open; online they work (opportunity record)", async () => {
    onRpc("crm.lead", "action_set_won_rainbowman", () => expect.step("action_set_won_rainbowman"));
    onRpc("crm.lead", "action_schedule_meeting", ({ parent }) => {
        expect.step("action_schedule_meeting");
        return parent();
    });

    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    // "Won" is the header's first visible button, so it stays inline on
    // mobile with no dropdown to open; the blacklist buttons sit outside
    // `oe_button_box` in the sheet body, so they're never collapsed either.
    expect("button[name='action_set_won_rainbowman']").not.toHaveAttribute("disabled");
    expect("button[name='mail_action_blacklist_remove']").not.toHaveAttribute("disabled");

    // The button-box's own "More" toggler carries `data-available-offline`
    // (clicking it to look is harmless); opening it reveals the two stat
    // buttons, collapsed here because `maxVisibleButtons` is 0 at the XS
    // size (`button_box.js`).
    await contains(".o_button_more").click();
    expect("button[name='action_schedule_meeting']").not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect("button[name='action_set_won_rainbowman']").toHaveAttribute("disabled");
    expect("button[name='action_set_won_rainbowman']").toHaveClass("o_disabled_offline");
    expect("button[name='mail_action_blacklist_remove']").toHaveAttribute("disabled");
    expect("button[name='mail_action_blacklist_remove']").toHaveClass("o_disabled_offline");
    expect(".o_button_more").not.toHaveAttribute("disabled"); // the toggler itself still opens
    expect("button[name='action_schedule_meeting']").toHaveAttribute("disabled");
    expect("button[name='action_schedule_meeting']").toHaveClass("o_disabled_offline");

    await contains("button[name='action_set_won_rainbowman']").click();
    await contains("button[name='mail_action_blacklist_remove']").click();
    await contains("button[name='action_schedule_meeting']").click();
    expect.verifySteps([]); // none of the three RPCs was issued or queued

    await setOffline(false);
    expect("button[name='action_set_won_rainbowman']").not.toHaveAttribute("disabled");
    expect("button[name='action_schedule_meeting']").not.toHaveAttribute("disabled");
    await contains("button[name='action_set_won_rainbowman']").click();
    await contains("button[name='action_schedule_meeting']").click();
    expect.verifySteps(["action_set_won_rainbowman", "action_schedule_meeting"]); // online, both still work
});

test.tags("mobile");
test("offline, the lead form's header dropdown toggler itself is disabled, making 'Lost' unreachable; online it opens again (lead record)", async () => {
    onRpc("crm.lead", "action_convert_to_opportunity", ({ parent }) => {
        expect.step("action_convert_to_opportunity");
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "form", resId: 2, arch: FORM_ARCH });

    // "Convert to Opportunity" is the header's first visible button on
    // this record (stays inline); "Lost" is the only other one, so it's
    // the one `StatusBarButtons` moves into its own dropdown on mobile.
    const headerToggler = ".o_statusbar_buttons button.o-dropdown-caret";
    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect(headerToggler).not.toHaveAttribute("disabled");
    await contains(headerToggler).click();
    expect("button[name='%(crm.crm_lead_lost_action)d']").not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect("button[name='action_convert_to_opportunity']").toHaveAttribute("disabled");
    expect("button[name='action_convert_to_opportunity']").toHaveClass("o_disabled_offline");
    // Unlike the button-box's own toggler, `StatusBarButtons`' dropdown
    // button carries no `data-available-offline` of its own, so it is
    // itself caught by `SELECTORS_TO_DISABLE` -- "Lost" becomes
    // unreachable through its dropdown entirely, not just inert once
    // reached.
    expect(headerToggler).toHaveAttribute("disabled");
    expect(headerToggler).toHaveClass("o_disabled_offline");

    await contains("button[name='action_convert_to_opportunity']").click();
    expect.verifySteps([]); // the call was neither issued nor queued

    await setOffline(false);
    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect(headerToggler).not.toHaveAttribute("disabled");
    await contains("button[name='action_convert_to_opportunity']").click();
    expect.verifySteps(["action_convert_to_opportunity"]); // online, it still works
});
