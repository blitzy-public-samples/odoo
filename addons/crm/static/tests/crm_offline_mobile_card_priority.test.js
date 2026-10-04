import { defineMailModels, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test } from "@odoo/hoot";
import { queryAll, queryRect } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    mountWithCleanup,
    MockServer,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * orchestrator-triage.md (M4 scrutiny round 1, blocker 7; VAL-MOBILE-017):
 * the mobile pipeline card's own priority control
 * (`static/src/mobile/crm_mobile_card/`). `priority` is declared at the
 * kanban root (not only inside the arch's own "card" template, which
 * `CrmMobileCard` never renders), the same way `crm_case_kanban_view_leads`
 * carries it via `<field name="priority" widget="priority"
 * groups="base.group_user"/>` -- so it lands in `record.activeFields`
 * exactly like production, and `CrmMobileCard.hasPriority` sees it.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ relation: "crm.stage" });
    priority = fields.Selection({
        selection: [
            ["0", "Low"],
            ["1", "Medium"],
            ["2", "High"],
            ["3", "Very High"],
        ],
        default: "0",
    });

    _views = {
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <field name="stage_id"/>
                <field name="priority"/>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
        form: `<form><field name="name"/><field name="priority" widget="priority"/></form>`,
        search: `<search/>`,
    };
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    fold = fields.Boolean({ default: false });

    _records = [{ id: 1, name: "New", sequence: 1 }];
}

defineModels([Lead, Stage]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
]);

async function seedLeads() {
    const pyEnv = await startServer();
    const [lead1, lead2] = pyEnv["crm.lead"].create([
        { name: "Lead 1", stage_id: 1, priority: "0" },
        { name: "Lead 2", stage_id: 1, priority: "0" },
    ]);
    return { lead1, lead2 };
}

test.tags("mobile");
test("the card's priority stars are >= 44x44 CSS px and each carries data-available-offline on the button itself", async () => {
    await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const stars = queryAll(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star");
    // AVAILABLE_PRIORITIES has 4 options ('0'..'3'); the first ("Low") is
    // the implicit "no priority" reset target, not its own star
    // (web.PriorityField's own convention) -- 3 stars per card.
    expect(stars.length).toBe(3);
    for (let i = 0; i < stars.length; i++) {
        const rect = queryRect(`.o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star:eq(${i})`);
        expect(rect.width).toBeWithin(44, 100000);
        expect(rect.height).toBeWithin(44, 100000);
        // Must be the `<button>` itself, not a wrapper around it
        // (architecture.md §2 "Offline-availability attribute").
        expect(stars[i].tagName).toBe("BUTTON");
        expect(stars[i].hasAttribute("data-available-offline")).toBe(true);
    }
});

test.tags("mobile");
test("online, tapping a star saves the priority through the framework (record.update) without opening the form, and the top star toggles back to Low", async () => {
    const { lead1, lead2 } = await seedLeads();
    const steps = [];
    onRpc("crm.lead", "web_save", ({ args, parent }) => {
        steps.push(args[1].priority);
        return parent();
    });

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // No star filled while priority is "0" (Low, the reset target, has no
    // star of its own).
    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star.oi-filled").toHaveCount(0);

    // Star index 1 (second star) = priority "2".
    await contains(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star:eq(1)").click();

    expect(steps).toEqual(["2"]);
    expect(MockServer.env["crm.lead"].find((r) => r.id === lead1).priority).toBe("2");
    // Tapping the star did not open the record.
    expect(".o_form_view").toHaveCount(0);
    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star.oi-filled").toHaveCount(2);
    // The other card is untouched.
    expect(".o_crm_mobile_card:eq(1) .o_crm_mobile_card_priority_star.oi-filled").toHaveCount(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === lead2).priority).toBe("0");

    // Tapping the current top (filled) star resets to Low ("0"), the
    // same toggle `web.PriorityField.onStarClicked` uses.
    await contains(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star:eq(1)").click();

    expect(steps).toEqual(["2", "0"]);
    expect(MockServer.env["crm.lead"].find((r) => r.id === lead1).priority).toBe("0");
    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star.oi-filled").toHaveCount(0);
});

test.tags("mobile");
test("offline, tapping a star queues exactly one web_save through the framework, shows the badge on that card only, and replay clears it", async () => {
    const { lead1, lead2 } = await seedLeads();

    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless startup sync (offline_plugin.js's
    // constructor, 3s after mount) now, while the queue is empty, so it
    // can't race the replay triggered by setOffline(false) below.
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_crm_mobile_card_pending_sync").toHaveCount(0);

    // Star index 2 (third star) = priority "3".
    await contains(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_priority_star:eq(2)").click();

    // `record.update()` auto-saves immediately (a kanban row is never "in
    // edition"); offline, `_save()`'s `ConnectionLostError` falls back to
    // the framework's own `_offlineSave`, which queues one `web_save`
    // with full framework extras -- no `queueCall`/`scheduleORM` call of
    // crm's own, so this is the framework's normal save path, not a
    // second producer.
    const queue = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queue.length).toBe(1);
    expect(queue[0].value.model).toBe("crm.lead");
    expect(queue[0].value.method).toBe("web_save");
    expect(queue[0].value.args).toEqual([[lead1], { priority: "3" }]);
    expect(queue[0].value.extras.changes).toEqual({ priority: "3" });
    expect(queue[0].value.extras.timeStamp).not.toBe(undefined);

    // The badge shows on lead 1's card only.
    expect(".o_crm_mobile_card:eq(0) .o_crm_mobile_card_pending_sync").toHaveCount(1);
    expect(".o_crm_mobile_card:eq(1) .o_crm_mobile_card_pending_sync").toHaveCount(0);

    // The systray lists it as "Edited", with no crash.
    await contains(".o_menu_systray .o_nav_entry.o_offline_systray").click();
    expect(".o-dropdown--menu").toHaveCount(1);
    expect(".o-dropdown--menu span.o_tag.badge").toHaveText("Edited");
    await contains(".o_menu_systray .o_nav_entry.o_offline_systray").click();

    await setOffline(false);
    await runAllTimers();

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_crm_mobile_card_pending_sync").toHaveCount(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === lead1).priority).toBe("3");
});
