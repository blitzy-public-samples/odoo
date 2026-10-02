import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { contains, defineModels, fields, mockOffline, models, mountView } from "@web/../tests/web_test_helpers";
import { serializeDate, today } from "@web/core/l10n/dates";

/**
 * m2-framework-disabled-proofs (VAL-DIS-006). B17 (Leads mobile kanban
 * card footer, `views/crm_lead_views.xml:374`), B23 (pipeline kanban
 * footer, `:547`) and BR7 (Opportunities list, `:735`) all render the
 * same mail `ActivityButton` (`@mail/core/web/activity_button`), via the
 * `kanban_activity` (B17/B23) or `list_activity` (BR7) field widget. The
 * button itself is a plain `<button>`
 * (`addons/mail/static/src/core/web/activity_button.xml`) with no
 * `data-available-offline`; `OfflinePlugin.SELECTORS_TO_DISABLE` already
 * disables it offline. With the button unreachable, its popover (B86
 * "Edit", B87 "Done & Schedule Next", and the plain "Schedule"/"Done"
 * actions B17/B23/BR7 themselves classify) never opens, so this one test
 * per widget is a proportionate proof for the whole family -- no crm code
 * change is needed.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    activity_ids = fields.One2many({ relation: "mail.activity", string: "Activities" });
    activity_state = fields.Selection({
        selection: [
            ["overdue", "Overdue"],
            ["today", "Today"],
            ["planned", "Planned"],
        ],
    });
    activity_exception_decoration = fields.Selection({
        selection: [
            ["warning", "Alert"],
            ["danger", "Error"],
        ],
    });
    activity_exception_icon = fields.Char();
    activity_summary = fields.Char();
    activity_type_icon = fields.Char();
    activity_type_id = fields.Many2one({ relation: "mail.activity.type" });

    _records = [{ id: 1, name: "Lead 1" }];

    _views = {
        kanban: `
            <kanban js_class="crm_kanban">
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                        <field name="activity_ids" widget="kanban_activity"/>
                    </t>
                </templates>
            </kanban>`,
        list: `
            <list js_class="crm_list">
                <field name="name"/>
                <field name="activity_ids" widget="list_activity"/>
            </list>`,
    };
}

defineModels([Lead]);
defineMailModels();

async function seedActivity() {
    const pyEnv = await startServer();
    const activityTypeId = pyEnv["mail.activity.type"].create({ name: "Call", icon: "phone" });
    const activityId = pyEnv["mail.activity"].create({
        res_model: "crm.lead",
        res_id: 1,
        activity_type_id: activityTypeId,
        date_deadline: serializeDate(today()),
    });
    pyEnv["crm.lead"].write([1], {
        activity_ids: [activityId],
        activity_state: "today",
        activity_type_id: activityTypeId,
    });
}

test("offline, the lead kanban card's activity button is disabled and its popover never opens; online it still opens (desktop)", async () => {
    await seedActivity();
    await mountView({ resModel: "crm.lead", type: "kanban", arch: Lead._views.kanban });

    const button = ".o-mail-ActivityButton";
    expect(button).toHaveCount(1);
    expect(button).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(button).toHaveAttribute("disabled");
    expect(button).toHaveClass("o_disabled_offline");
    await contains(button).click();
    expect(".o-mail-ActivityListPopover").toHaveCount(0); // popover never opened

    await setOffline(false);
    expect(button).not.toHaveAttribute("disabled");
    expect(button).not.toHaveClass("o_disabled_offline");
    await contains(button).click();
    expect(".o-mail-ActivityListPopover").toHaveCount(1); // online, it still opens
});

test.tags("mobile");
test("offline, the lead kanban card's activity button is disabled and its popover never opens; online it still opens (mobile)", async () => {
    await seedActivity();
    await mountView({ resModel: "crm.lead", type: "kanban", arch: Lead._views.kanban });

    const button = ".o-mail-ActivityButton";
    expect(button).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(button).toHaveAttribute("disabled");
    expect(button).toHaveClass("o_disabled_offline");
    await contains(button).click();
    expect(".o-mail-ActivityListPopover").toHaveCount(0);

    await setOffline(false);
    expect(button).not.toHaveAttribute("disabled");
    await contains(button).click();
    expect(".o-mail-ActivityListPopover").toHaveCount(1);
});

test("offline, the Opportunities list row's activity button (BR7) is disabled and its popover never opens; online it still opens (desktop)", async () => {
    await seedActivity();
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    const button = ".o_data_row .o-mail-ActivityButton";
    expect(button).toHaveCount(1);
    expect(button).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(button).toHaveAttribute("disabled");
    expect(button).toHaveClass("o_disabled_offline");
    await contains(button).click();
    expect(".o-mail-ActivityListPopover").toHaveCount(0);

    await setOffline(false);
    expect(button).not.toHaveAttribute("disabled");
    await contains(button).click();
    expect(".o-mail-ActivityListPopover").toHaveCount(1);
});
