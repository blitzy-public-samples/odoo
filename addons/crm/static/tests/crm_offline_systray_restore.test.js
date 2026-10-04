import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { animationFrame, expect, queryAllTexts, runAllTimers, test } from "@odoo/hoot";
import { mockDate } from "@odoo/hoot-mock";
import { press } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    models,
    MockServer,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

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
    const setOffline = mockCrmOffline();
    await setOffline(true);

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
    // All five of the built-in labels are untouched by the patch, not
    // just Created/Archived (VAL-QUEUE-004: "the built-in labels ... are
    // unchanged"). A real web_save producer always sets `extras.changes`
    // (record.js); an empty object here is enough to exercise the base
    // STATUS branch without crashing on the tooltip-building code that
    // reads it. `args[0].length` is what `offline_systray.js`'s
    // `groupEntries()` reads to tell Created (`[]`, no id yet) from
    // Edited (`[id]`) apart for a `web_save` entry.
    offline.scheduleORM("res.partner", "web_save", [[]], {}, {
        extras: { timeStamp: 6, actionName: "Contacts", displayName: "New Partner", changes: {} },
    });
    offline.scheduleORM("res.partner", "web_save", [[9]], {}, {
        extras: { timeStamp: 7, actionName: "Contacts", displayName: "Edited Partner", changes: {} },
    });
    offline.scheduleORM("res.partner", "action_archive", [[9]], {}, {
        extras: { timeStamp: 8, actionName: "Contacts", displayName: "Archived Partner" },
    });
    offline.scheduleORM("res.partner", "action_unarchive", [[9]], {}, {
        extras: { timeStamp: 9, actionName: "Contacts", displayName: "Unarchived Partner" },
    });
    offline.scheduleORM("res.partner", "web_unlink", [[9]], {}, {
        extras: { timeStamp: 10, actionName: "Contacts", displayName: "Deleted Partner" },
    });
    await animationFrame();
    expect(queryAllTexts(".o-dropdown--menu .o-dropdown-item div.ms-auto")).toEqual([
        "Won",
        "Restored",
        "Call logged",
        "Activity scheduled",
        "Activity done",
        "Created",
        "Edited",
        "Archived",
        "Unarchived",
        "Deleted",
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
    const setOffline = mockCrmOffline();
    await setOffline(true);

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

    // The built-in labels are untouched by the patch under the mobile
    // preset too (VAL-QUEUE-004 is "both presets"); the desktop test
    // above already covers all five.
    offline.scheduleORM("res.partner", "web_save", [[]], {}, {
        extras: { timeStamp: 6, actionName: "Contacts", displayName: "New Partner", changes: {} },
    });
    offline.scheduleORM("res.partner", "web_save", [[9]], {}, {
        extras: { timeStamp: 7, actionName: "Contacts", displayName: "Edited Partner", changes: {} },
    });
    offline.scheduleORM("res.partner", "action_archive", [[9]], {}, {
        extras: { timeStamp: 8, actionName: "Contacts", displayName: "Archived Partner" },
    });
    offline.scheduleORM("res.partner", "action_unarchive", [[9]], {}, {
        extras: { timeStamp: 9, actionName: "Contacts", displayName: "Unarchived Partner" },
    });
    offline.scheduleORM("res.partner", "web_unlink", [[9]], {}, {
        extras: { timeStamp: 10, actionName: "Contacts", displayName: "Deleted Partner" },
    });
    await animationFrame();
    expect(queryAllTexts(".o-dropdown--menu .o-dropdown-item div.ms-auto")).toEqual([
        "Won",
        "Restored",
        "Activity scheduled",
        "Activity done",
        "Call logged",
        "Created",
        "Edited",
        "Archived",
        "Unarchived",
        "Deleted",
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
                <field name="name" required="1"/>
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

    const setOffline = mockCrmOffline();
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
    // The replay actually reached the server, not just "the queue is
    // empty" (which an unregistered method would also leave behind if
    // `_syncORM` silently dropped it): the mock server's lead is active
    // again, same as the mock `action_restore` handler above would also
    // produce from an online click.
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).active).toBe(true);
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

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("button[name='action_restore']").click();
    expect.verifySteps([]); // no RPC: queued, not sent

    // Same full queue-entry proof the desktop test above makes (args,
    // extras.timeStamp), not just the method name.
    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("action_restore");
    expect(value.args).toEqual([[1]]);
    expect(typeof value.extras.timeStamp).toBe("number");

    expect("button[name='action_restore']").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);

    // The systray already shows the queued call as "Restored" (mobile's
    // toggler is a bare div, not the Dropdown's own button -- the same
    // extra frame the "systray labels every CRM-queued method" mobile
    // test above needs).
    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    await animationFrame();
    expect(".o-dropdown--menu .o-dropdown-item div.ms-auto").toHaveText("Restored");

    await setOffline(false);
    expect.verifySteps(["action_restore"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).active).toBe(true);
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

    const setOffline = mockCrmOffline();
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

// ---------------------------------------------------------------------------
// Scrutiny finding 11 (VAL-QUEUE-005): offline Restore on a dirty form must
// save the edit first, like the online button does, instead of leaving it
// unqueued. "name" is `required="1"` above so clearing it makes the form
// invalid for the second test below.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, Restore on a dirty valid form queues web_save then action_restore, in that order (desktop)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    // Flush the plugin's harmless "sync shortly after startup" pass
    // (offline_plugin.js's constructor, 3s after mount while online) now,
    // while the queue is empty, so it can't fire a second time
    // concurrently with the explicit replay below once `runAllTimers` is
    // in play (same gotcha as crm_offline_queue_semantics.test.js's "two
    // offline writes to the same lead" test).
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_field_widget[name='name'] input").edit("Renamed before Restore");
    await contains("button[name='action_restore']").click();
    expect.verifySteps([]); // both calls queued, neither sent yet

    const queued = Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
    );
    expect(queued.length).toBe(2);
    expect(queued[0].value.model).toBe("crm.lead");
    expect(queued[0].value.method).toBe("web_save");
    expect(queued[0].value.args[1].name).toBe("Renamed before Restore");
    expect(queued[1].value.method).toBe("action_restore");
    expect(queued[1].value.args).toEqual([[1]]);
    // Strict, not <=: VAL-QUEUE-005 requires Restore to always replay after
    // the save it depends on, including when both would otherwise tie on
    // the same Date.now() millisecond (see the dedicated tie test below).
    expect(queued[0].value.extras.timeStamp < queued[1].value.extras.timeStamp).toBe(true);

    // Optimistic UI still applies: the record is no longer dirty (it was
    // just saved) and shows as restored.
    expect("button[name='action_restore']").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
    await runAllTimers(); // flush _syncORM's 1s pause between the two replays
    expect.verifySteps(["web_save", "action_restore"]); // replayed in that order
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("mobile");
test("offline, Restore on a dirty valid form queues web_save then action_restore, in that order (mobile)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers(); // flush the plugin's harmless startup sync pass before the queue is populated

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_field_widget[name='name'] input").edit("Renamed before Restore");
    await contains("button[name='action_restore']").click();
    expect.verifySteps([]);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
    );
    expect(queued.length).toBe(2);
    expect(queued[0].value.method).toBe("web_save");
    expect(queued[1].value.method).toBe("action_restore");

    await setOffline(false);
    await runAllTimers(); // flush _syncORM's 1s pause between the two replays
    expect.verifySteps(["web_save", "action_restore"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

// ---------------------------------------------------------------------------
// Scrutiny round-3 (VAL-QUEUE-005): the two tests above rely on whatever
// millisecond actually elapses between the dirty save's `Date.now()`
// (record.js's `_offlineSave`) and Restore's own `Date.now()`
// (`getScheduleORMExtras`, in `_queueRestoreOffline`) during a real test
// run -- usually distinct, but not guaranteed, and the reviewed code
// before this fix only asserted `<=`. `mockDate` freezes the clock (it
// does not advance on its own), forcing the exact tie the finding is
// about, so a regression here only passes if `_queueRestoreOffline`
// itself breaks the tie rather than happening to get lucky.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, Restore timestamp is strictly after the pending save's even with an identical Date.now() (desktop)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers(); // flush the plugin's harmless startup sync pass before the queue is populated

    const setOffline = mockCrmOffline();
    await setOffline(true);
    mockDate("2024-05-15 00:00:00"); // frozen: every Date.now() call below returns the same value

    await contains(".o_field_widget[name='name'] input").edit("Renamed before Restore (tie)");
    await contains("button[name='action_restore']").click();
    expect.verifySteps([]); // both calls queued, neither sent yet

    const queued = Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
    );
    expect(queued.length).toBe(2);
    const [saveEntry, restoreEntry] = queued;
    expect(saveEntry.value.method).toBe("web_save");
    expect(restoreEntry.value.method).toBe("action_restore");
    // Without the fix these two would be equal (both stamped from the same
    // frozen Date.now()); the fix must force a strict break of the tie.
    expect(restoreEntry.value.extras.timeStamp > saveEntry.value.extras.timeStamp).toBe(true);

    await setOffline(false);
    await runAllTimers(); // flush _syncORM's 1s pause between the two replays
    expect.verifySteps(["web_save", "action_restore"]); // save replays before Restore despite the tie
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("mobile");
test("offline, Restore timestamp is strictly after the pending save's even with an identical Date.now() (mobile)", async () => {
    onRpc("crm.lead", "action_restore", function ({ args }) {
        expect.step("action_restore");
        this.env["crm.lead"].write(args[0], { active: true, won_status: "pending" });
        return true;
    });
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await runAllTimers();

    const setOffline = mockCrmOffline();
    await setOffline(true);
    mockDate("2024-05-15 00:00:00");

    await contains(".o_field_widget[name='name'] input").edit("Renamed before Restore (tie)");
    await contains("button[name='action_restore']").click();
    expect.verifySteps([]);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync()).sort(
        (a, b) => a.value.extras.timeStamp - b.value.extras.timeStamp
    );
    expect(queued.length).toBe(2);
    const [saveEntry, restoreEntry] = queued;
    expect(saveEntry.value.method).toBe("web_save");
    expect(restoreEntry.value.method).toBe("action_restore");
    expect(restoreEntry.value.extras.timeStamp > saveEntry.value.extras.timeStamp).toBe(true);

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save", "action_restore"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
});

test.tags("desktop");
test("offline, Restore on an invalid form queues nothing (desktop)", async () => {
    onRpc("crm.lead", "action_restore", () => expect.step("action_restore"));
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_field_widget[name='name'] input").edit("");
    await contains("button[name='action_restore']").click();
    expect.verifySteps([]); // neither call issued

    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // Not restored: the button is still there, the lead is still lost.
    expect("button[name='action_restore']").toHaveCount(1);
});
