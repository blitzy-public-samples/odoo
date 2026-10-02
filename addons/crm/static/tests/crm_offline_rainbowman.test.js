import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountView,
    onRpc,
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { CrmStage } from "@crm/../tests/mock_server/mock_models/crm_stage";
import { CrmTeam } from "@crm/../tests/mock_server/mock_models/crm_team";

/**
 * Defect 1 (architecture.md §3.2 item 1 / offline_inventory.md rows
 * A12/A14/A16/C9): `checkRainbowmanMessage` must not call
 * `get_rainbowman_message` offline at all (no RPC, nothing queued, no
 * error), and a `ConnectionLostError` raised while asking is a skip, not a
 * failure of the save/drag that triggered it. The queued write itself is
 * untouched: it still goes out exactly as the framework's `web_save`
 * producer builds it (crm_offline_email_phone_force_save.test.js already
 * proves that payload; here we only assert the stage change is in it).
 *
 * Online, the lookup must still be issued exactly as before this fix
 * (VAL-FIX-004) -- these guard tests sit next to the offline ones so a
 * regression that deletes the online call instead of fixing the offline
 * one is caught here too, in addition to the untouched
 * crm_rainbowman.test.js / test_crm_rainbowman.py.
 */

// A fake "users" model distinct from the real `res.users` (already defined
// by `defineMailModels()`), matching the pattern of the baseline
// crm_rainbowman.test.js.
class Users extends models.Model {
    name = fields.Char();

    _records = [
        { id: 1, name: "Mitchell Admin" },
        { id: 2, name: "Other salesperson" },
    ];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    planned_revenue = fields.Float();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    user_id = fields.Many2one({ string: "Salesperson", relation: "users" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        { id: 1, name: "First lead", planned_revenue: 5, stage_id: 1, team_id: 1, user_id: 1 },
        { id: 2, name: "Second lead", planned_revenue: 5, stage_id: 1, team_id: 1, user_id: 1 },
        // Already in the won stage, for a different salesperson/team, so
        // the kanban's "Won" column is non-empty (and therefore rendered)
        // *before* any drag -- the mock kanban, unlike the real crm.lead
        // model, has no `_read_group_stage_ids` group-expand override, so
        // an empty group is simply not shown. Kept out of leads 1/2's team
        // and salesperson so it doesn't affect the "first win" message.
        { id: 3, name: "Already won", planned_revenue: 2, stage_id: 2, team_id: 2, user_id: 2 },
    ];
}

CrmStage._records = [
    { id: 1, name: "New" },
    { id: 2, name: "Won", is_won: true },
];
CrmTeam._records = [
    { id: 1, name: "Sales Team" },
    { id: 2, name: "Other Team" },
];

defineModels([Lead, Users, CrmStage, CrmTeam]);
defineMailModels();

const formView = {
    resModel: "crm.lead",
    type: "form",
    arch: `
        <form js_class="crm_form">
            <header><field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/></header>
            <field name="name"/>
            <field name="planned_revenue"/>
            <field name="team_id"/>
            <field name="user_id"/>
        </form>`,
};
const kanbanView = {
    resModel: "crm.lead",
    type: "kanban",
    groupBy: ["stage_id"],
    arch: `
        <kanban js_class="crm_kanban">
            <templates>
                <t t-name="card"><field name="name"/></t>
            </templates>
        </kanban>`,
};

// ---------------------------------------------------------------------------
// Form save: offline skip
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline form save into the won stage queues the write and skips the rainbowman lookup (desktop)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", () => expect.step("get_rainbowman_message"));
    const setOffline = mockOffline();
    await mountView({ ...formView, resId: 1 });
    await setOffline(true);

    await contains(".o_statusbar_status button[data-value='2']").click();
    await contains("button.o_form_button_save").click();

    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect.verifySteps([]); // get_rainbowman_message was never called

    // VAL-FIX-001: the save completed and left the form showing the new
    // stage as current, with no notification or error dialog surfacing
    // the skipped lookup.
    expect(".o_form_view").toHaveCount(1);
    expect(".o_statusbar_status button[data-value='2']").toHaveClass("o_arrow_button_current");
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1]).toEqual({ stage_id: 2 });
});

test.tags("mobile");
test("offline form save into the won stage queues the write and skips the rainbowman lookup (mobile)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", () => expect.step("get_rainbowman_message"));
    const setOffline = mockOffline();
    await mountView({ ...formView, resId: 1 });
    await setOffline(true);

    await contains(".o_statusbar_status button.dropdown-toggle").click();
    await contains(".o-dropdown--menu .dropdown-item:contains('Won')").click();
    await contains("button.o_form_button_save").click();

    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect.verifySteps([]);

    // VAL-FIX-001 (mobile): the dropdown toggler shows the new stage's own
    // label (StatusBarField.getCurrentLabel()), and no notification or
    // error dialog surfaced the skipped lookup. `StatusBarField` keeps the
    // other two `.dropdown-toggle` buttons (its folded before/after groups)
    // in the DOM behind `d-none` on small screens, so the live one must be
    // singled out rather than matched by tag alone.
    expect(".o_form_view").toHaveCount(1);
    expect(".o_statusbar_status button.dropdown-toggle:not(.d-none)").toHaveText("Won");
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1]).toEqual({ stage_id: 2 });
});

// ---------------------------------------------------------------------------
// Form save: online guard (VAL-FIX-004)
// ---------------------------------------------------------------------------

test.tags("desktop");
test("online form save into the won stage still issues the rainbowman lookup (desktop)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", ({ parent }) => {
        const result = parent();
        expect.step(result || "no rainbowman");
        return result;
    });
    await mountView({ ...formView, resId: 1 });

    await contains(".o_statusbar_status button[data-value='2']").click();
    await contains("button.o_form_button_save").click();

    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
    expect.verifySteps(["Go, go, go! Congrats for your first deal."]);
});

test.tags("mobile");
test("online form save into the won stage still issues the rainbowman lookup (mobile)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", ({ parent }) => {
        const result = parent();
        expect.step(result || "no rainbowman");
        return result;
    });
    await mountView({ ...formView, resId: 1 });

    await contains(".o_statusbar_status button.dropdown-toggle").click();
    await contains(".o-dropdown--menu .dropdown-item:contains('Won')").click();
    await contains("button.o_form_button_save").click();

    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
    expect.verifySteps(["Go, go, go! Congrats for your first deal."]);
});

// ---------------------------------------------------------------------------
// VAL-FIX-002: a ConnectionLostError raised by the lookup itself (the save
// having already gone through) is a skip, not an error on top of a
// successful save.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("a connection lost while fetching the rainbowman message does not fail the save (desktop)", async () => {
    // VAL-FIX-002: a recorded step proves the lookup was actually attempted
    // (not merely absent because the test forgot to call it) before the
    // handler returns the connection-lost response.
    onRpc("crm.lead", "get_rainbowman_message", () => {
        expect.step("get_rainbowman_message");
        return new Response("", { status: 502 });
    });
    await mountView({ ...formView, resId: 1 });

    await contains(".o_statusbar_status button[data-value='2']").click();
    await contains("button.o_form_button_save").click();

    expect.verifySteps(["get_rainbowman_message"]);

    // The save went through (the renderer flags the just-completed save)
    // and no CRM error UI showed up for the lost lookup.
    expect(".o_form_renderer").toHaveClass("o_form_saved");
    expect(".o_statusbar_status button[data-value='2']").toHaveClass("o_arrow_button_current");
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
});

test.tags("mobile");
test("a connection lost while fetching the rainbowman message does not fail the save (mobile)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", () => {
        expect.step("get_rainbowman_message");
        return new Response("", { status: 502 });
    });
    await mountView({ ...formView, resId: 1 });

    await contains(".o_statusbar_status button.dropdown-toggle").click();
    await contains(".o-dropdown--menu .dropdown-item:contains('Won')").click();
    await contains("button.o_form_button_save").click();

    expect.verifySteps(["get_rainbowman_message"]);

    expect(".o_form_renderer").toHaveClass("o_form_saved");
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Kanban drag: offline skip (desktop) / same CrmKanbanModel path (mobile)
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline kanban drag into the won stage queues the write and skips the rainbowman lookup (desktop)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", () => expect.step("get_rainbowman_message"));
    const setOffline = mockOffline();
    await mountView(kanbanView);
    await setOffline(true);

    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(First lead)").dragAndDrop(
        ".o_kanban_group:eq(1)"
    );

    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect.verifySteps([]);

    // VAL-FIX-003: the card actually landed in the "Won" target column
    // (group index 1, the drop target above), not just queued server-side.
    expect(".o_kanban_group:eq(1) .o_kanban_record:contains(First lead)").toHaveCount(1);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1]).toEqual({ stage_id: 2 });
});

test.tags("mobile");
test("offline kanban stage move via CrmKanbanModel skips the rainbowman lookup (mobile)", async () => {
    // The framework disables drag-and-drop entirely on small screens
    // (`KanbanRenderer.canUseSortable` is `!uiService.isSmall`,
    // addons/web/static/src/views/kanban/kanban_renderer.js:307), so there is
    // no gesture to simulate under the mobile preset. This exercises the
    // same `CrmKanbanDynamicGroupList.moveRecords` path a desktop drag would
    // call (kanban_renderer.js:638), directly, with the ids the live model
    // holds -- the same ids a drop handler would read off the DOM.
    let model;
    patchWithCleanup(CrmKanbanModel.prototype, {
        setup() {
            super.setup(...arguments);
            model = this;
        },
    });
    onRpc("crm.lead", "get_rainbowman_message", () => expect.step("get_rainbowman_message"));
    const setOffline = mockOffline();
    await mountView(kanbanView);
    await waitFor(".o_kanban_record:eq(2)"); // wait for the groups to be loaded
    await setOffline(true);

    const leadRecord = model.root.records.find((r) => r.resId === 1);
    const wonGroup = model.root.groups.find((g) => g.displayName === "Won");
    await model.root.moveRecords([leadRecord.id], false, wonGroup.id);

    expect.verifySteps([]);

    // VAL-FIX-003/VAL-SKIP-003 (mobile): there is no drag gesture to check
    // a target column against, so the model-level equivalent is that the
    // "Won" group's own record list -- what the mobile card list renders --
    // now contains the moved lead, and no reward/notification/error-dialog
    // UI appeared for the skipped lookup.
    expect(wonGroup.records.some((r) => r.resId === 1)).toBe(true);
    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(0);
    expect(".o_notification").toHaveCount(0);
    expect(".o_error_dialog").toHaveCount(0);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1]).toEqual({ stage_id: 2 });
});

// ---------------------------------------------------------------------------
// Kanban drag: online guard (VAL-FIX-004)
// ---------------------------------------------------------------------------

test.tags("desktop");
test("online kanban drag into the won stage still issues the rainbowman lookup (desktop)", async () => {
    onRpc("crm.lead", "get_rainbowman_message", ({ parent }) => {
        const result = parent();
        expect.step(result || "no rainbowman");
        return result;
    });
    await mountView(kanbanView);

    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(First lead)").dragAndDrop(
        ".o_kanban_group:eq(1)"
    );

    expect(".o_reward svg.o_reward_rainbow_man").toHaveCount(1);
    expect.verifySteps(["Go, go, go! Congrats for your first deal."]);
});

test.tags("mobile");
test("online kanban stage move via CrmKanbanModel still issues the rainbowman lookup (mobile)", async () => {
    let model;
    patchWithCleanup(CrmKanbanModel.prototype, {
        setup() {
            super.setup(...arguments);
            model = this;
        },
    });
    onRpc("crm.lead", "get_rainbowman_message", ({ parent }) => {
        const result = parent();
        expect.step(result || "no rainbowman");
        return result;
    });
    await mountView(kanbanView);
    await waitFor(".o_kanban_record:eq(2)"); // wait for the groups to be loaded

    const leadRecord = model.root.records.find((r) => r.resId === 1);
    const wonGroup = model.root.groups.find((g) => g.displayName === "Won");
    await model.root.moveRecords([leadRecord.id], false, wonGroup.id);

    expect.verifySteps(["Go, go, go! Congrats for your first deal."]);
});
