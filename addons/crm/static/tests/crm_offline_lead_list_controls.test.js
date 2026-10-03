import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { contains, defineModels, fields, mockOffline, models, mountView, onRpc } from "@web/../tests/web_test_helpers";

/**
 * m2-framework-disabled-proofs (VAL-DIS-005). Rows B15, B16 (Leads list
 * header, `views/crm_lead_views.xml:323-324`), B26, B27 (Opportunities
 * list header, `:710-711`), B28 (reschedule dropdown, `:759`) and B29
 * (Opportunities list row "Email", `:760`) are all plain framework
 * controls with no `data-available-offline`:
 *
 * - B15/B16/B26/B27: `<button type="action">` inside a list `<header>`.
 *   `list_controller.xml` compiles these as `MultiRecordViewButton`s
 *   (`ViewButton` underneath, a real `<button>`); `OfflinePlugin.
 *   SELECTORS_TO_DISABLE` already disables them.
 * - B29: same `ViewButton` mechanism, but as a per-row `<button
 *   type="action">` cell -- no selection needed to reach it.
 * - B28: `mail_activity_mixin_list_reschedule_dropdown`'s own toggler is a
 *   plain `<button type="button">` with no `data-available-offline`
 *   (`addons/mail/static/src/views/web/list/mail_activity_list_reschedule.xml`);
 *   disabling the toggler makes every `DropdownItem` inside it (including
 *   the custom-date `DateTimeInput`, which calls `action.doActionButton`
 *   directly, bypassing the normal `ViewButton` click path) unreachable
 *   too, since the dropdown can never open. The mixin variant's own
 *   template (`mail_activity_list_reschedule_mixin.xml`) only renders the
 *   `Dropdown` at all when `record.data.my_activity_date_deadline` is
 *   set, and that field is only in a record's fetched data if some
 *   `<field>` in the arch requests it (the widget declares no
 *   `fieldDependencies` of its own) -- which is why the real arch
 *   (`crm_lead_views.xml:738`) carries a `my_activity_date_deadline`
 *   column next to the widget; this test arch does the same, nothing to
 *   do with offline.
 *
 * No crm code change is needed for any of these; this file only proves
 * the framework's own disablement reaches them.
 *
 * B15/B16/B26/B27 only render once at least one row is selected
 * (`list_controller.xml`: `button.display !== 'always'` puts them in the
 * `hasSelectedRecords`-only slot). Row *selection* checkboxes themselves
 * are desktop-only (`list_renderer.js`: `allowSelectors = this.props.
 * allowSelectors && !this.uiService.isSmall`), so these four header
 * buttons have no reach on mobile at all, online or offline -- there is
 * no mobile-specific behavior to prove here, so the header-button test
 * below is desktop-only. B28/B29 need no selection and are exercised
 * under both presets.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    won_status = fields.Selection({ selection: [["pending", "Pending"], ["won", "Won"], ["lost", "Lost"]] });
    my_activity_date_deadline = fields.Date();

    _records = [
        { id: 1, name: "Lead 1", won_status: "pending", my_activity_date_deadline: "2024-01-01" },
        { id: 2, name: "Opportunity 1", won_status: "pending", my_activity_date_deadline: "2024-01-01" },
        { id: 3, name: "Opportunity 2 (lost)", won_status: "lost", my_activity_date_deadline: "2024-01-01" },
    ];
}

// A minimal stand-in wizard, so the online representative-button checks
// below (VAL-DIS-005's "Convert to Opportunities" and "Email") can assert
// that a real `target: "new"` action actually opens, not just that
// `/web/action/load` was reached.
class Wizard extends models.Model {
    _name = "some.wizard";

    name = fields.Char();

    _views = {
        form: `<form><field name="name"/></form>`,
    };
}

defineModels([Lead, Wizard]);
defineMailModels();

const LEADS_LIST_ARCH = `
    <list string="Leads" js_class="crm_list">
        <header>
            <button name="1" type="action" string="Convert to Opportunities"/>
            <button name="2" type="action" string="Mark Lost"/>
        </header>
        <field name="name"/>
        <field name="won_status" column_invisible="True"/>
    </list>`;

const OPPORTUNITIES_LIST_ARCH = `
    <list string="Opportunities" js_class="crm_list">
        <header>
            <button name="2" type="action" string="Mark Lost"/>
            <button name="3" type="action" string="Email"/>
        </header>
        <field name="name"/>
        <field name="won_status" column_invisible="True"/>
        <field name="my_activity_date_deadline" column_invisible="True"/>
        <widget name="mail_activity_mixin_list_reschedule_dropdown"/>
        <button name="4" type="action" string="Email" icon="mail" invisible="won_status == 'lost'"/>
    </list>`;

test.tags("desktop");
test("offline, the Leads list header buttons are disabled once a row is selected and issue no action load; online, 'Mark Lost' still loads its action (desktop)", async () => {
    // Targets 1/2 are left unresolved on purpose for the offline assertion
    // (same convention as crm_offline_team_dashboard.test.js): if a click
    // ever got through, the unmocked /web/action/load would surface as an
    // uncaught "action not found" error and fail the test.
    await mountView({ resModel: "crm.lead", type: "list", arch: LEADS_LIST_ARCH });

    expect(".o_data_row .o_list_record_selector input").toHaveCount(3);
    await contains(".o_data_row .o_list_record_selector input").click();
    expect("button[name='1']").toHaveCount(1);
    expect("button[name='1']").not.toHaveAttribute("disabled");
    expect("button[name='2']").not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect("button[name='1']").toHaveAttribute("disabled");
    expect("button[name='1']").toHaveClass("o_disabled_offline");
    expect("button[name='2']").toHaveAttribute("disabled");
    expect("button[name='2']").toHaveClass("o_disabled_offline");
    await contains("button[name='1']").click();
    await contains("button[name='2']").click();
    expect.verifySteps([]); // no action was loaded or queued

    await setOffline(false);
    expect("button[name='1']").not.toHaveAttribute("disabled");
    expect("button[name='2']").not.toHaveAttribute("disabled");

    // VAL-DIS-005: an online representative check per header button, not
    // just one shared between both list families -- branch on the
    // requested action id so "Convert to Opportunities" (1) and "Mark
    // Lost" (2) are each genuinely proven, not just the load route being
    // reached once. "Convert to Opportunities" (`target: "new"`, a
    // dialog) goes first and gets closed again: "Mark Lost"'s own action
    // below has no `target`, so it replaces the mounted list itself
    // (`doActionButton`'s default `target: "current"`) and must run last.
    onRpc("/web/action/load", async (request) => {
        const { params } = await request.json();
        expect.step(`load_action:${params.action_id}`);
        // `name="1"` compiles to `clickParams.name` as the raw XML string
        // "1", carried verbatim into `_loadAction`'s `action_id` -- never
        // coerced to a number.
        if (params.action_id === "1") {
            return { id: 1, type: "ir.actions.act_window", target: "new", res_model: "some.wizard", views: [[false, "form"]] };
        }
        return { id: 2, type: "ir.actions.act_window", res_model: "crm.lead", views: [[false, "list"]] };
    });
    await contains("button[name='1']").click();
    expect.verifySteps(["load_action:1"]);
    expect(".o_dialog .o_form_view").toHaveCount(1); // "Convert to Opportunities" opens its wizard
    await contains(".o_dialog header button[aria-label='Close']").click();

    // Closing the dialog reloads the list behind it (its own `onClose`),
    // which drops the row selection and the header buttons with it.
    await contains(".o_data_row .o_list_record_selector input").click();
    await contains("button[name='2']").click();
    expect.verifySteps(["load_action:2"]); // "Mark Lost" still loads its action
});

test.tags("desktop");
test("offline, the Opportunities list header buttons are disabled once a row is selected and issue no action load; online, 'Mark Lost' still loads its action (desktop)", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: OPPORTUNITIES_LIST_ARCH });

    await contains(".o_data_row .o_list_record_selector input").click();
    expect("button[name='2']").toHaveCount(1);
    expect("button[name='3']").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect("button[name='2']").toHaveAttribute("disabled");
    expect("button[name='2']").toHaveClass("o_disabled_offline");
    expect("button[name='3']").toHaveAttribute("disabled");
    expect("button[name='3']").toHaveClass("o_disabled_offline");
    await contains("button[name='2']").click();
    await contains("button[name='3']").click();
    expect.verifySteps([]);

    await setOffline(false);
    expect("button[name='2']").not.toHaveAttribute("disabled");
    expect("button[name='3']").not.toHaveAttribute("disabled");

    // VAL-DIS-005: a distinct online representative for this list's own
    // header button, "Email" (3), on top of the "Mark Lost" (2) check
    // shared with the Leads list test above. "Email" (`target: "new"`)
    // goes first and gets closed again; "Mark Lost" has no `target` and
    // replaces the mounted list itself, so it must run last (same
    // ordering reason as the Leads list test above).
    onRpc("/web/action/load", async (request) => {
        const { params } = await request.json();
        expect.step(`load_action:${params.action_id}`);
        // Same string-not-number `action_id` as the Leads list test above.
        if (params.action_id === "3") {
            return { id: 3, type: "ir.actions.act_window", target: "new", res_model: "some.wizard", views: [[false, "form"]] };
        }
        return { id: 2, type: "ir.actions.act_window", res_model: "crm.lead", views: [[false, "list"]] };
    });
    await contains("button[name='3']").click();
    expect.verifySteps(["load_action:3"]);
    expect(".o_dialog .o_form_view").toHaveCount(1); // "Email" opens its composer-style action
    await contains(".o_dialog header button[aria-label='Close']").click();

    // Same list-reload-on-dialog-close note as the Leads list test above.
    await contains(".o_data_row .o_list_record_selector input").click();
    await contains("button[name='2']").click();
    expect.verifySteps(["load_action:2"]);
});

test("offline, the Opportunities list row 'Email' button and the reschedule dropdown toggler are disabled with no row selection needed; online they re-enable", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: OPPORTUNITIES_LIST_ARCH });

    const emailBtn = ".o_data_row:eq(0) button[name='4']";
    const rescheduleToggler = ".o_data_row:eq(0) .o_widget_mail_activity_mixin_list_reschedule_dropdown button";
    expect(emailBtn).not.toHaveAttribute("disabled");
    expect(rescheduleToggler).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(emailBtn).toHaveAttribute("disabled");
    expect(emailBtn).toHaveClass("o_disabled_offline");
    expect(rescheduleToggler).toHaveAttribute("disabled");
    expect(rescheduleToggler).toHaveClass("o_disabled_offline");

    await contains(emailBtn).click();
    await contains(rescheduleToggler).click();
    expect(".o-dropdown--menu").toHaveCount(0); // reschedule menu never opens
    expect.verifySteps([]);

    // The 3rd row ("lost") never shows the Email button at all, online or
    // offline -- its own `invisible` condition, unrelated to offline.
    expect(".o_data_row:eq(2) button[name='4']").toHaveCount(0);

    await setOffline(false);
    expect(emailBtn).not.toHaveAttribute("disabled");
    expect(rescheduleToggler).not.toHaveAttribute("disabled");
    await contains(rescheduleToggler).click();
    expect(".o-dropdown--menu").toHaveCount(1); // online, the dropdown opens again
});

// VAL-DIS-005 (user-testing round 2 evidence): the desktop header-button
// tests above select a row first, because the buttons only render once
// `hasSelectedRecords` is true (`list_controller.xml`). On mobile no row
// selector exists at all (`list_renderer.js`'s `allowSelectors`), so
// there is no way to reach `hasSelectedRecords` -- the buttons can never
// render, online or offline. These two tests mount each list family
// directly under the mobile preset and assert that absence explicitly,
// instead of only inferring it from the "no selector" fact proven
// elsewhere.
test.tags("mobile");
test("offline, the Leads list renders no row selector and its header buttons never render; online the same holds (mobile)", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: LEADS_LIST_ARCH });

    expect(".o_data_row .o_list_record_selector").toHaveCount(0);
    expect("button:contains('Convert to Opportunities')").toHaveCount(0);
    expect("button:contains('Mark Lost')").toHaveCount(0);

    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_data_row .o_list_record_selector").toHaveCount(0);
    expect("button:contains('Convert to Opportunities')").toHaveCount(0);
    expect("button:contains('Mark Lost')").toHaveCount(0);

    await setOffline(false);
    expect(".o_data_row .o_list_record_selector").toHaveCount(0);
    expect("button:contains('Convert to Opportunities')").toHaveCount(0);
    expect("button:contains('Mark Lost')").toHaveCount(0);
});

test.tags("mobile");
test("offline, the Opportunities list renders no row selector and its header buttons never render; online the same holds (mobile)", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: OPPORTUNITIES_LIST_ARCH });

    expect(".o_data_row .o_list_record_selector").toHaveCount(0);
    expect("header button:contains('Mark Lost')").toHaveCount(0);
    expect("header button:contains('Email')").toHaveCount(0);

    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_data_row .o_list_record_selector").toHaveCount(0);
    expect("header button:contains('Mark Lost')").toHaveCount(0);
    expect("header button:contains('Email')").toHaveCount(0);

    await setOffline(false);
    expect(".o_data_row .o_list_record_selector").toHaveCount(0);
    expect("header button:contains('Mark Lost')").toHaveCount(0);
    expect("header button:contains('Email')").toHaveCount(0);
});

test.tags("mobile");
test("offline, the Opportunities list row 'Email' button and the reschedule dropdown toggler are disabled with no row selection needed; online they re-enable (mobile)", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: OPPORTUNITIES_LIST_ARCH });

    expect(".o_data_row .o_list_record_selector").toHaveCount(0); // no selection checkboxes on mobile

    const emailBtn = ".o_data_row:eq(0) button[name='4']";
    const rescheduleToggler = ".o_data_row:eq(0) .o_widget_mail_activity_mixin_list_reschedule_dropdown button";
    expect(emailBtn).not.toHaveAttribute("disabled");
    expect(rescheduleToggler).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(emailBtn).toHaveAttribute("disabled");
    expect(emailBtn).toHaveClass("o_disabled_offline");
    expect(rescheduleToggler).toHaveAttribute("disabled");
    expect(rescheduleToggler).toHaveClass("o_disabled_offline");

    await contains(emailBtn).click();
    await contains(rescheduleToggler).click();
    expect(".o-dropdown--menu").toHaveCount(0);
    expect.verifySteps([]);

    await setOffline(false);
    expect(emailBtn).not.toHaveAttribute("disabled");
    expect(rescheduleToggler).not.toHaveAttribute("disabled");
});
