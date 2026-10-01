import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { animationFrame, expect, queryAllTexts, test } from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";

/**
 * VAL-QUEUE-004 (architecture.md §3.2 item 11 / offline_inventory.md
 * Notes #1): `addons/web`'s offline systray only labels the four built-in
 * methods it produces itself (`web_save`/`web_unlink`/`action_archive`/
 * `action_unarchive`); any other queued method leaves `item.status`
 * undefined, and `offline_systray.xml` dereferences
 * `element.status.color` unconditionally, so opening the dropdown throws.
 * This is a known addons/web gap, worked around from crm's side with
 * `offline_systray_patch.js`, never fixed in addons/web itself.
 *
 * The five methods below are every CRM-queued call outside the four
 * built-ins across the whole offline-fixes milestone: `action_set_won`/
 * `action_restore` from this feature, plus the `mail.activity` ones (not
 * wired to a producer yet, queued directly here to prove the systray
 * patch already covers them -- see offline_systray_patch.js's docstring).
 */
test.tags("desktop");
test("the systray labels every CRM-queued method without crashing (desktop)", async () => {
    await mountWithCleanup(WebClient);
    const offline = getService(OfflinePlugin);
    offline.scheduleORM("crm.lead", "action_set_won", [[1]], {}, {
        extras: { timeStamp: 1, actionName: "CRM", displayName: "Won Lead" },
    });
    offline.scheduleORM("crm.lead", "action_restore", [[2]], {}, {
        extras: { timeStamp: 2, actionName: "CRM", displayName: "Restored Lead" },
    });
    offline.scheduleORM("crm.lead", "action_log_call", [[3]], {}, {
        extras: { timeStamp: 3, actionName: "CRM", displayName: "Called Lead" },
    });
    offline.scheduleORM("mail.activity", "create", [{}], {}, {
        extras: { timeStamp: 4, actionName: "CRM", displayName: "Planned Activity" },
    });
    offline.scheduleORM("mail.activity", "action_done", [[5]], {}, {
        extras: { timeStamp: 5, actionName: "CRM", displayName: "Done Activity" },
    });
    // `mountWithCleanup(WebClient)` always issues its own background
    // "/mail/store" poll; going offline this fast races it (same
    // declared-and-verified error as crm_offline_mrr.test.js's "a
    // CrmColumnProgress mount issues no has_group probe..." test, which
    // mounts the same bare WebClient for the same reason).
    expect.errors(1);
    const setOffline = mockOffline();
    await setOffline(true);
    expect.verifyErrors([
        `Connection to "/mail/store" couldn't be established or was interrupted`,
    ]);

    // Opening the dropdown is exactly what crashes today without the
    // patch (element.status is undefined for all five entries above).
    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    expect(".o-dropdown--menu:visible").toHaveCount(1);
    expect(".o-dropdown--menu .o-dropdown-item").toHaveCount(5);
    // The status badge itself sits in each item's own `.ms-auto` div
    // (offline_systray.xml); one per queued entry, in timestamp order.
    expect(queryAllTexts(".o-dropdown--menu .o-dropdown-item div.ms-auto")).toEqual([
        "Won",
        "Restored",
        "Call logged",
        "Activity scheduled",
        "Activity done",
    ]);
    // The four built-in labels are untouched by the patch. A real web_save
    // producer always sets `extras.changes` (record.js); an empty object
    // here is enough to exercise the base STATUS branch without crashing
    // on the tooltip-building code that reads it.
    offline.scheduleORM("res.partner", "web_save", [[]], {}, {
        extras: { timeStamp: 6, actionName: "Contacts", displayName: "New Partner", changes: {} },
    });
    offline.scheduleORM("res.partner", "action_archive", [[9]], {}, {
        extras: { timeStamp: 7, actionName: "Contacts", displayName: "Archived Partner" },
    });
    await animationFrame();
    expect(queryAllTexts(".o-dropdown--menu .o-dropdown-item div.ms-auto")).toEqual([
        "Won",
        "Restored",
        "Call logged",
        "Activity scheduled",
        "Activity done",
        "Created",
        "Archived",
    ]);
});

test.tags("mobile");
test("the systray labels every CRM-queued method without crashing (mobile)", async () => {
    await mountWithCleanup(WebClient);
    const offline = getService(OfflinePlugin);
    offline.scheduleORM("crm.lead", "action_set_won", [[1]], {}, {
        extras: { timeStamp: 1, actionName: "CRM", displayName: "Won Lead" },
    });
    offline.scheduleORM("crm.lead", "action_restore", [[2]], {}, {
        extras: { timeStamp: 2, actionName: "CRM", displayName: "Restored Lead" },
    });
    offline.scheduleORM("mail.activity", "create", [{}], {}, {
        extras: { timeStamp: 3, actionName: "CRM", displayName: "Planned Activity" },
    });
    offline.scheduleORM("mail.activity", "action_done", [[4]], {}, {
        extras: { timeStamp: 4, actionName: "CRM", displayName: "Done Activity" },
    });
    offline.scheduleORM("crm.lead", "action_log_call", [[5]], {}, {
        extras: { timeStamp: 5, actionName: "CRM", displayName: "Called Lead" },
    });
    expect.errors(1); // same background "/mail/store" race as the desktop test above
    const setOffline = mockOffline();
    await setOffline(true);
    expect.verifyErrors([
        `Connection to "/mail/store" couldn't be established or was interrupted`,
    ]);

    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    await animationFrame(); // mobile's toggler is a bare div, not the Dropdown's own button (offline_systray.test.js's "scheduledORM: mobile" needs the same extra frame)
    expect(".o-dropdown--menu:visible").toHaveCount(1);
    expect(".o-dropdown--menu .o-dropdown-item").toHaveCount(5);
    expect(queryAllTexts(".o-dropdown--menu .o-dropdown-item div.ms-auto")).toEqual([
        "Won",
        "Restored",
        "Activity scheduled",
        "Activity done",
        "Call logged",
    ]);
});

// ---------------------------------------------------------------------------
// B3/C4 (architecture.md §3.7, offline_inventory.md rows B3/C4): the
// "Restore" button on a lost lead's form.
// ---------------------------------------------------------------------------

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    active = fields.Boolean({ default: true });
    won_status = fields.Selection({
        selection: [
            ["won", "Won"],
            ["pending", "In Progress"],
            ["lost", "Lost"],
        ],
    });

    _records = [{ id: 1, name: "Lost Lead", active: false, won_status: "lost" }];

    _views = {
        form: `
            <form js_class="crm_form">
                <header>
                    <field name="won_status" invisible="1"/>
                    <field name="active" invisible="1"/>
                    <button name="action_restore" string="Restore" type="object"
                        data-hotkey="x" data-available-offline=""
                        invisible="won_status != 'lost'"/>
                </header>
                <field name="name"/>
            </form>`,
        search: `<search/>`,
    };
}

defineModels([Lead]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Lost Lead",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
]);

test.tags("desktop");
test("offline, Restore queues action_restore, updates the form optimistically, and replays on reconnect (desktop)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true; // a mock model lookup would otherwise MockServerError
    });
    await mountWithCleanup(WebClient);
    // Visit the form online first so it is in the RPC disk cache (visited):
    // irrelevant to this fix (Restore queues regardless), but matches how
    // a user would actually reach this screen.
    await getService("action").doAction(1);
    expect("button[name='action_restore']").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains("button[name='action_restore']").click();
    expect.verifySteps([]); // no RPC: queued, not sent

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_restore");
    expect(value.args).toEqual([[1]]);
    expect(typeof value.extras.timeStamp).toBe("number");

    // Optimistic UI: won_status flips locally, so the button's own
    // `invisible="won_status != 'lost'"` hides it without a round trip.
    expect("button[name='action_restore']").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);

    // The systray already shows the queued call as "Restored".
    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    expect(".o-dropdown--menu .o-dropdown-item div.ms-auto").toHaveText("Restored");

    await setOffline(false);
    expect.verifySteps(["action_restore"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("mobile");
test("offline, Restore queues action_restore, updates the form optimistically, and replays on reconnect (mobile)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    expect("button[name='action_restore']").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains("button[name='action_restore']").click();
    expect.verifySteps([]);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    expect(queued[0].value.method).toBe("action_restore");
    expect("button[name='action_restore']").toHaveCount(0);

    await setOffline(false);
    expect.verifySteps(["action_restore"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("desktop");
test("offline, the Restore hotkey queues action_restore too (desktop)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await press(["alt", "x"]);
    await animationFrame();
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);
    expect.verifySteps([]);
});

test.tags("desktop");
test("online, Restore still issues the real action_restore RPC (desktop)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    await contains("button[name='action_restore']").click();
    expect.verifySteps(["action_restore"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect("button[name='action_restore']").toHaveCount(0);
});
