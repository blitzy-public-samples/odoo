import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

/**
 * m2-framework-disabled-proofs (VAL-DIS-001). Rows B2, B4, B6, B7, B12,
 * B13, C10, C11, C12 are all plain `<button type="object">` or
 * `<button type="action">` elements on `crm_lead_view_form`
 * (`views/crm_lead_views.xml:12-17,33-50,212-228`) that carry no
 * `data-available-offline`. `OfflinePlugin.SELECTORS_TO_DISABLE`
 * (`button:not([data-available-offline]):not([disabled])`) already
 * disables every one of them offline. This test only proves the
 * framework's own disablement reaches every row; no crm change is needed
 * (no gap found).
 *
 * The Won button (`action_set_won_rainbowman`, B1/C6/C8) used to be part
 * of this same disabled-buttons proof -- before milestone 3 it was still
 * a bare button with no offline producer, so the framework's generic
 * disablement already covered it. m3-mark-won gives Won its own offline
 * producer (`CrmFormController._queueWonOffline`, `data-available-offline`
 * on the real button) and its own dedicated test file
 * (`crm_offline_mark_won.test.js`, VAL-DATA-005/006/007); it is removed
 * from this file's coverage so this file's remaining buttons keep
 * matching the real markup verbatim (the comment below).
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
 *
 * Round-1 user-testing additions (still VAL-DIS-001): the mobile test
 * below now also covers the Similar Leads stat button
 * (`action_show_potential_duplicates`) and the phone blacklist-remove
 * button, matching the desktop test's five-button coverage instead of
 * three; and a dedicated online test proves "Lost" itself still reaches
 * its `type="action"` wizard-opening path (the "disabled offline" tests
 * above only ever exercise its *online* enabled state in passing, never
 * an online click, since their focus is the offline disablement).
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

// Only used by the online "Lost" test below, to give the button's
// `%(crm.crm_lead_lost_action)d` target somewhere real to open; the
// offline tests above never reach it (see their comments).
class LeadLost extends models.Model {
    _name = "crm.lead.lost";
    _views = { form: `<form string="Lost"/>` };
}

defineModels([Lead, LeadLost]);
defineMailModels();

// Reproduces the real header + stat-button + blacklist-remove markup from
// `crm_lead_view_form` verbatim (reduced to the fields these buttons'
// `invisible` expressions need).
const FORM_ARCH = `
    <form class="o_lead_opportunity_form" js_class="crm_form">
        <header>
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
    expect.verifySteps([]); // none of the four RPCs was issued or queued
    // VAL-DIS-001: object-method buttons have nothing to queue (unlike a
    // form save), so the proof that none fired is also a proof the queue
    // stayed empty.
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    await setOffline(false);
    for (const sel of buttons) {
        expect(sel).not.toHaveAttribute("disabled");
        expect(sel).not.toHaveClass("o_disabled_offline");
    }
    await contains("button[name='action_schedule_meeting']").click();
    await contains("button[name='action_show_potential_duplicates']").click();
    await contains("button[name='mail_action_blacklist_remove']").click();
    await contains("button[name='phone_action_blacklist_remove']").click();
    expect.verifySteps([
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
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    await setOffline(false);
    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect("button[name='%(crm.crm_lead_lost_action)d']").not.toHaveAttribute("disabled");
    await contains("button[name='action_convert_to_opportunity']").click();
    expect.verifySteps(["action_convert_to_opportunity"]); // online, it still works
});

test.tags("desktop");
test("online, clicking 'Lost' opens the mark-lost wizard (VAL-DIS-001)", async () => {
    // The previous test leaves "Lost"'s action target unresolved on
    // purpose; this one gives `/web/action/load` something to resolve so
    // the online path -- unlike the offline one, which never reaches
    // `doActionButton` at all -- can be asserted directly: the button
    // still reaches the real `type="action"` wizard-opening path.
    onRpc("/web/action/load", () => ({
        type: "ir.actions.act_window",
        name: "Lost",
        res_model: "crm.lead.lost",
        view_mode: "form",
        target: "new",
        views: [[false, "form"]],
    }));
    await mountView({ resModel: "crm.lead", type: "form", resId: 2, arch: FORM_ARCH });

    await contains("button[name='%(crm.crm_lead_lost_action)d']").click();

    expect(".o_dialog .o_form_view").toHaveCount(1);
    expect(".modal-title").toHaveText("Lost");
});

test.tags("mobile");
test("offline, the lead form's header button and the button-box/blacklist buttons are disabled once revealed; online they work (opportunity record)", async () => {
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

    // The blacklist buttons sit outside `oe_button_box` in the sheet
    // body, so they're never collapsed into a header or button-box
    // dropdown.
    expect("button[name='mail_action_blacklist_remove']").not.toHaveAttribute("disabled");
    expect("button[name='phone_action_blacklist_remove']").not.toHaveAttribute("disabled");

    // The button-box's own "More" toggler carries `data-available-offline`
    // (clicking it to look is harmless); opening it reveals both stat
    // buttons (the Similar Leads one included), collapsed here because
    // `maxVisibleButtons` is 0 at the XS size (`button_box.js`). It is
    // only clicked this once: it's a toggle, so clicking it again later
    // (e.g. right after `setOffline`) would close it back instead of
    // keeping it open.
    await contains(".o_button_more").click();
    expect("button[name='action_schedule_meeting']").not.toHaveAttribute("disabled");
    expect("button[name='action_show_potential_duplicates']").not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect("button[name='mail_action_blacklist_remove']").toHaveAttribute("disabled");
    expect("button[name='mail_action_blacklist_remove']").toHaveClass("o_disabled_offline");
    expect("button[name='phone_action_blacklist_remove']").toHaveAttribute("disabled");
    expect("button[name='phone_action_blacklist_remove']").toHaveClass("o_disabled_offline");
    expect(".o_button_more").not.toHaveAttribute("disabled"); // the toggler itself still opens
    expect("button[name='action_schedule_meeting']").toHaveAttribute("disabled");
    expect("button[name='action_schedule_meeting']").toHaveClass("o_disabled_offline");
    expect("button[name='action_show_potential_duplicates']").toHaveAttribute("disabled");
    expect("button[name='action_show_potential_duplicates']").toHaveClass("o_disabled_offline");

    await contains("button[name='mail_action_blacklist_remove']").click();
    await contains("button[name='phone_action_blacklist_remove']").click();
    await contains("button[name='action_schedule_meeting']").click();
    await contains("button[name='action_show_potential_duplicates']").click();
    expect.verifySteps([]); // none of the four RPCs was issued or queued
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    await setOffline(false);
    expect("button[name='action_schedule_meeting']").not.toHaveAttribute("disabled");
    expect("button[name='action_show_potential_duplicates']").not.toHaveAttribute("disabled");
    expect("button[name='phone_action_blacklist_remove']").not.toHaveAttribute("disabled");
    await contains("button[name='action_schedule_meeting']").click();
    // `action_schedule_meeting`'s mock resolves with `act_window_close`,
    // which reloads the form and collapses the "More" dropdown back
    // closed; it must be re-opened to reach the next stat button.
    await contains(".o_button_more").click();
    await contains("button[name='action_show_potential_duplicates']").click();
    await contains("button[name='mail_action_blacklist_remove']").click();
    await contains("button[name='phone_action_blacklist_remove']").click();
    expect.verifySteps([
        "action_schedule_meeting",
        "action_show_potential_duplicates",
        "mail_action_blacklist_remove",
        "phone_action_blacklist_remove",
    ]); // online, every button still works
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
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    await setOffline(false);
    expect("button[name='action_convert_to_opportunity']").not.toHaveAttribute("disabled");
    expect(headerToggler).not.toHaveAttribute("disabled");
    await contains("button[name='action_convert_to_opportunity']").click();
    expect.verifySteps(["action_convert_to_opportunity"]); // online, it still works
});
