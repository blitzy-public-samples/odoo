import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, runAllTimers, test, waitFor } from "@odoo/hoot";
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
    patchWithCleanup,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { CrmKanbanModel } from "@crm/views/crm_kanban/crm_kanban_model";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * m3-framework-data-coverage (VAL-DATA-001/002/003, architecture.md §3.3
 * "Leads/stages/teams reads, edits, creates, stage moves: framework already
 * covers them -- prove with tests, don't reimplement"). AGENTS.md section 4
 * "Never build a second offline engine" is why no production code
 * accompanies this file: every assertion below runs through the unmodified
 * `OfflinePlugin.scheduleORM`/record.js save producers crm already consumes
 * for every other form and kanban save, carried all the way through to a
 * replayed, server-visible result -- not just a queued-RPC-shape check
 * (crm_offline_rainbowman.test.js and crm_offline_queue_semantics.test.js
 * already assert the queued shape for stage changes and generic edits
 * respectively; this file is the milestone-3 "framework coverage" proof the
 * contract names specifically, so it carries each case through
 * `setOffline(false)` + `runAllTimers()` to a `MockServer.env` assertion).
 *
 * crm.stage and crm.team form-save coverage (VAL-DATA-004) already exists
 * in `crm_offline_list_celledit_disable.test.js`'s `FORM_SAVE_CASES` (both
 * presets, replayed to `MockServer.env` for `crm.lead`, `crm.stage` and
 * `crm.team` alike) -- not duplicated here.
 */

class Stage extends models.Model {
    _name = "crm.stage";
    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    is_won = fields.Boolean();

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Won", sequence: 2, is_won: true },
    ];
}

class Team extends models.Model {
    _name = "crm.team";
    name = fields.Char();

    _records = [{ id: 1, name: "Sales Team" }];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    description = fields.Char();
    expected_revenue = fields.Float();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        {
            id: 1,
            name: "First lead",
            description: "Initial description",
            expected_revenue: 100,
            stage_id: 1,
            team_id: 1,
        },
        {
            id: 2,
            name: "Second lead",
            description: "Initial description",
            expected_revenue: 200,
            stage_id: 1,
            team_id: 1,
        },
        // Already in the "Won" stage, for a different team, so that
        // column is non-empty (and therefore rendered) before any drag:
        // the mock kanban, unlike the real crm.lead model, has no
        // `_read_group_stage_ids` group-expand override, so an empty
        // group is simply not shown (crm_offline_rainbowman.test.js's
        // kanbanView fixture documents the same workaround).
        {
            id: 3,
            name: "Already won lead",
            description: "Initial description",
            expected_revenue: 50,
            stage_id: 2,
            team_id: 1,
        },
    ];

    _views = {
        form: `
            <form js_class="crm_form">
                <header><field name="stage_id" widget="statusbar" options="{'clickable': '1'}"/></header>
                <field name="name"/>
                <field name="description"/>
                <field name="expected_revenue"/>
            </form>`,
        kanban: `
            <kanban js_class="crm_kanban" default_group_by="stage_id">
                <field name="stage_id"/>
                <templates>
                    <t t-name="card"><field name="name"/></t>
                </templates>
            </kanban>`,
        list: `<list js_class="crm_list"><field name="name"/></list>`,
        search: `<search/>`,
    };
}

defineModels([Lead, Stage, Team]);
defineMailModels();

defineActions([
    {
        // List + form on the same window action: opening a record from the
        // list, going back, then reopening it offline needs the whole
        // navigation inside one OfflinePlugin instance (same reasoning as
        // crm_offline_queue_semantics.test.js's action 1).
        id: 1,
        name: "Leads",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "list"],
            [false, "form"],
        ],
        search_view_id: [false, "search"],
    },
    {
        id: 2,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
        search_view_id: [false, "search"],
    },
]);

// A record genuinely cached offline is still re-fetched (`web_read`) when
// its form reopens -- the fetch loses the race to the disk-cache hit
// (crm_offline_uncached_lead.test.js documents the same framework
// behavior) -- and reopening a list/kanban root offline re-issues its own
// search read. Both are declared, not treated as unexpected.
const WEB_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established or was interrupted`;
const ONCHANGE_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/onchange" couldn't be established or was interrupted`;

// ---------------------------------------------------------------------------
// VAL-DATA-001: offline lead edit queued and replayed.
// ---------------------------------------------------------------------------

test("offline, editing several fields of a lead available offline and saving queues one web_save and replays it on reconnect", async () => {
    onRpc("crm.lead", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // Genuinely visit the lead's form online first (the same idiom as
    // crm_offline_uncached_lead.test.js): the record's web_read must
    // already be in the real RPC disk cache before it is reopened offline.
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_list_view").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect.errors(1); // web_read is genuinely attempted; it loses the race to the disk-cache hit
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_form_view").toHaveCount(1);
    expect.verifyErrors([WEB_READ_ERROR]);

    await contains(".o_field_widget[name='name'] input").edit("Edited offline");
    await contains(".o_field_widget[name='description'] input").edit("Edited offline description");
    await contains(".o_field_widget[name='expected_revenue'] input").edit("999");
    await contains("button.o_form_button_save").click();
    expect.verifySteps([]); // not sent while offline

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1]).toEqual({
        name: "Edited offline",
        description: "Edited offline description",
        expected_revenue: 999,
    });

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    const serverLead = MockServer.env["crm.lead"].find((lead) => lead.id === 1);
    expect(serverLead.name).toBe("Edited offline");
    expect(serverLead.description).toBe("Edited offline description");
    expect(serverLead.expected_revenue).toBe(999);
});

// ---------------------------------------------------------------------------
// VAL-DATA-002: offline lead create queued and replayed.
// ---------------------------------------------------------------------------

test("offline, creating a lead from the form (New, with the default values cached) queues web_save([], vals) and replays it on reconnect", async () => {
    onRpc("crm.lead", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);

    // Visit "New" once online: this both caches the (empty) onchange
    // defaults and marks `actionId/"form"/false` as visited
    // (`OfflinePlugin._visited`, architecture.md §2), the precondition for
    // `isNewButtonAvailableOffline` (`form_controller.js`) to let the
    // button stay enabled below.
    await contains("button.o_list_button_add").click();
    expect(".o_form_view").toHaveCount(1);
    await contains(".o_breadcrumb .o_back_button").click();
    expect(".o_list_view").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect("button.o_list_button_add").not.toHaveClass("o_disabled_offline");
    expect.errors(1); // onchange is genuinely attempted for the new record; architecture.md §2: onchange is skipped offline (never queued), the empty-defaults form that results is what the cached-defaults test here is actually about
    await contains("button.o_list_button_add").click();
    expect(".o_form_view").toHaveCount(1);
    expect.verifyErrors([ONCHANGE_ERROR]);

    await contains(".o_field_widget[name='name'] input").edit("New Lead Created Offline");
    await contains(".o_field_widget[name='description'] input").edit("Created offline description");
    await contains(".o_field_widget[name='expected_revenue'] input").edit("777");
    await contains("button.o_form_button_save").click();
    expect.verifySteps([]); // not sent while offline

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    // A new record has no earlier server values to diff against, so the
    // queued vals carry every field the view renders (its "cached
    // defaults", here all blank since the onchange above was skipped), not
    // just the one the user actually typed into. Assert the full vals, not
    // just the "name" key, so a regression that drops a field (e.g.
    // "description" or "expected_revenue") is caught here.
    expect(value.args[0]).toEqual([]);
    expect(value.args[1]).toEqual({
        name: "New Lead Created Offline",
        description: "Created offline description",
        expected_revenue: 777,
        // The statusbar's stage_id field is part of the view too (its
        // widget just isn't an <input>), so a brand-new record's cached
        // defaults carry it as well, blank, like every other field.
        stage_id: false,
    });

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    const created = MockServer.env["crm.lead"].find((lead) => lead.name === "New Lead Created Offline");
    expect(created).not.toBe(undefined);
    // "A lead with those values exists on the mock server" (VAL-DATA-002):
    // every queued key must equal the created lead's value, not just the
    // name used to find it.
    for (const [key, val] of Object.entries(value.args[1])) {
        expect(created[key]).toBe(val);
    }
    expect(MockServer.env["crm.lead"].filter((lead) => lead.name === "New Lead Created Offline").length).toBe(1);
});

// ---------------------------------------------------------------------------
// VAL-DATA-003: offline stage move replayed, through the form statusbar and
// through a kanban drag.
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, moving a lead's stage from the form statusbar queues a web_save of stage_id and replays it on reconnect (${preset})`, async () => {
        onRpc("crm.lead", "web_save", ({ parent }) => {
            expect.step("web_save");
            return parent();
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(1);
        await contains(".o_data_row:eq(0) [name='name']").click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_breadcrumb .o_back_button").click();

        const setOffline = mockCrmOffline();
        await setOffline(true);

        expect.errors(1); // web_read is genuinely attempted; it loses the race to the disk-cache hit
        await contains(".o_data_row:eq(0) [name='name']").click();
        expect(".o_form_view").toHaveCount(1);
        expect.verifyErrors([WEB_READ_ERROR]);

        if (preset === "mobile") {
            await contains(".o_statusbar_status button.dropdown-toggle").click();
            await contains(".o-dropdown--menu .dropdown-item:contains('Won')").click();
        } else {
            await contains(".o_statusbar_status button[data-value='2']").click();
        }
        await contains("button.o_form_button_save").click();
        expect.verifySteps([]); // not sent while offline

        const queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        const [{ value }] = queued;
        expect(value.model).toBe("crm.lead");
        expect(value.method).toBe("web_save");
        expect(value.args).toEqual([[1], { stage_id: 2 }]);

        await setOffline(false);
        await runAllTimers();
        expect.verifySteps(["web_save"]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env["crm.lead"].find((lead) => lead.id === 1).stage_id).toBe(2);
    });
}

test.tags("desktop");
test("offline, dragging a lead's kanban card to another stage column queues a web_save of stage_id and replays it on reconnect (desktop)", async () => {
    onRpc("crm.lead", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    await waitFor(".o_kanban_record:contains(First lead)");

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_kanban_group:eq(0) .o_kanban_record:contains(First lead)").dragAndDrop(
        ".o_kanban_group:eq(1)"
    );
    expect.verifySteps([]); // not sent while offline
    expect(".o_kanban_group:eq(1) .o_kanban_record:contains(First lead)").toHaveCount(1);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args).toEqual([[1], { stage_id: 2 }]);

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((lead) => lead.id === 1).stage_id).toBe(2);
});

test.tags("mobile");
test("offline, a kanban stage move through CrmKanbanModel queues a web_save of stage_id and replays it on reconnect (mobile)", async () => {
    // The framework disables drag-and-drop entirely on small screens
    // (`KanbanRenderer.canUseSortable` is `!uiService.isSmall`,
    // addons/web/static/src/views/kanban/kanban_renderer.js), so there is
    // no drag gesture to simulate under the mobile preset -- the same
    // reasoning crm_offline_rainbowman.test.js's mobile kanban-drag test
    // already documents. This exercises the identical
    // `CrmKanbanModel.moveRecords` path a desktop drop handler calls
    // (kanban_renderer.js), directly, with the ids the live model holds.
    let model;
    patchWithCleanup(CrmKanbanModel.prototype, {
        setup() {
            super.setup(...arguments);
            model = this;
        },
    });
    onRpc("crm.lead", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountWithCleanup(WebClient);
    await getService("action").doAction(2);
    await waitFor(".o_kanban_record:eq(1)"); // wait for the groups to be loaded

    const setOffline = mockCrmOffline();
    await setOffline(true);

    const leadRecord = model.root.records.find((r) => r.resId === 1);
    const wonGroup = model.root.groups.find((g) => g.displayName === "Won");
    await model.root.moveRecords([leadRecord.id], false, wonGroup.id);
    expect.verifySteps([]); // not sent while offline
    expect(wonGroup.records.some((r) => r.resId === 1)).toBe(true);

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args).toEqual([[1], { stage_id: 2 }]);

    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((lead) => lead.id === 1).stage_id).toBe(2);
});
