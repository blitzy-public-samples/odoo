import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { advanceTime, expect, runAllTimers, test } from "@odoo/hoot";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    makeServerError,
    mockOffline,
    models,
    MockServer,
    mountView,
    mountWithCleanup,
    onRpc,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { CrmStage } from "@crm/../tests/mock_server/mock_models/crm_stage";
import { CrmTeam } from "@crm/../tests/mock_server/mock_models/crm_team";

/**
 * m2-queue-semantics-tests (VAL-QUEUE-001/002/003/007/008). AGENTS.md
 * section 2 "Conflict behavior" / "Where failed calls go", and
 * architecture.md section 4 invariants: "Queue semantics unchanged; no
 * conflict dialog; no CRM-specific error UI". This is purely
 * `addons/web`'s `OfflinePlugin`/producers/systray behavior, which crm
 * consumes verbatim (AGENTS.md section 4: "Don't change the queue's
 * conflict semantics..."); every test below drives it through crm's own
 * models and views, per the feature's "tests only unless a defect is
 * found" scope -- no production code accompanies this file, because no
 * defect was found: `offline_plugin.js`'s `_syncORM` already replays by
 * `extras.timeStamp` with no comparison of any kind, and
 * `getStaticActionMenuItems()` on both list and form controllers already
 * mark Delete/Archive/Unarchive `availableOffline: true`, so the
 * CogMenu/ActionMenus template never disables them offline
 * (search/cog_menu.xml, search/action_menus/action_menus.xml).
 *
 * Server-state assertions and the simulated "someone else edited the
 * record" go through `MockServer.env["crm.lead"]` (the mock model's own
 * live store), not the `Lead` class's static `_records` (that one is only
 * the seed used to build the live store; it does not track later writes).
 */

class Users extends models.Model {
    name = fields.Char();
    _records = [{ id: 1, name: "Mitchell Admin" }];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    active = fields.Boolean({ default: true });
    priority = fields.Selection({
        selection: [
            ["0", "Low"],
            ["1", "Medium"],
            ["2", "High"],
        ],
        default: "0",
    });
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    user_id = fields.Many2one({ string: "Salesperson", relation: "users" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        { id: 1, name: "First lead", active: true, priority: "0", stage_id: 1, team_id: 1, user_id: 1 },
        { id: 2, name: "Second lead", active: false, priority: "0", stage_id: 1, team_id: 1, user_id: 1 },
    ];

    // `defineActions`'s `views: [[false, "..."]]` resolves against these
    // (uncached_lead.test.js, crm_offline_systray_restore.test.js use the
    // same convention), independently of the standalone archs below that
    // `mountView` is handed directly.
    _views = {
        kanban: `
            <kanban>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                        <field name="priority" widget="priority"/>
                    </t>
                </templates>
            </kanban>`,
        form: `
            <form>
                <field name="active"/>
                <field name="name"/>
                <field name="priority" widget="priority"/>
            </form>`,
        search: `<search/>`,
    };
}

CrmStage._records = [{ id: 1, name: "New" }];
CrmTeam._records = [{ id: 1, name: "Sales Team" }];

defineModels([Lead, Users, CrmStage, CrmTeam]);
defineMailModels();

defineActions([
    {
        // Kanban + form on the same window action, so navigating from the
        // card into its own form (and back) stays in one environment, one
        // OfflinePlugin instance -- two independent `mountView` calls would
        // instead start two environments, each with its own copy of the
        // plugin's online-RPC-driven startup sync and "online" listener,
        // double-replaying the same IndexedDB-backed queue.
        id: 1,
        name: "Pipeline",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [
            [false, "kanban"],
            [false, "form"],
        ],
    },
    {
        id: 2, // direct form of the active lead (id 1)
        name: "Lead 1",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
    {
        id: 3, // direct form of the already-archived lead (id 2)
        name: "Lead 2",
        res_model: "crm.lead",
        res_id: 2,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    },
]);

const WEB_READ_ERROR = `Connection to "/web/dataset/call_kw/crm.lead/web_read" couldn't be established or was interrupted`;

// ---------------------------------------------------------------------------
// VAL-QUEUE-001: two offline writes to one lead replay in timestamp order,
// and the later one wins.
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`two offline writes to the same lead replay in timestamp order, and the later one wins (${preset})`, async () => {
        const steps = [];
        onRpc("crm.lead", "web_save", ({ args, parent }) => {
            steps.push(args[1].priority);
            return parent();
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(1);

        // Genuinely visit the lead's form online first (the same idiom as
        // crm_offline_uncached_lead.test.js): opening it a second time,
        // offline, below, needs it to already be in the RPC disk cache.
        await contains(".o_kanban_record:contains('First lead')").click();
        expect(".o_form_view").toHaveCount(1);
        await contains(".o_breadcrumb .o_back_button").click();
        expect(".o_kanban_view").toHaveCount(1);

        // Flush the plugin's harmless "sync shortly after startup" pass
        // (offline_plugin.js's constructor, 3s after mount while online)
        // now, while the queue is empty, so it can't fire a second time
        // concurrently with the explicit replay below once `advanceTime`
        // and `runAllTimers` are in play.
        await runAllTimers();

        const setOffline = mockOffline();
        await setOffline(true);

        // Entry A: a kanban priority click. `PriorityField.updateRecord`
        // calls `record.update()`, which auto-saves immediately because a
        // kanban row is never "in edition" (record.js's `update()`).
        await contains(
            ".o_kanban_record:contains('First lead') .o_priority button.o_priority_star:eq(0)"
        ).click();

        let queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        const firstKey = queued[0].key;
        const firstTimeStamp = queued[0].value.extras.timeStamp;
        expect(queued[0].value.args[1]).toEqual({ priority: "1" });

        // Force a later, unambiguous timestamp for entry B regardless of
        // real wall-clock jitter: `Date.now()` is hoot-mocked and reflects
        // `advanceTime` (lib/hoot/mock/date.js's `MockDate.now`), and every
        // producer stamps `Date.now()` at save time
        // (relational_model/utils.js's `getScheduleORMExtras`).
        await advanceTime(2000);

        // Open the same lead's form again, now offline. It was visited
        // online above, so `isAvailableOffline` lets the navigation
        // through, but `web_read` is still genuinely attempted and loses
        // the race to the disk-cache hit (same accounting as
        // crm_offline_uncached_lead.test.js).
        expect.errors(1);
        await contains(".o_kanban_record:contains('First lead')").click();
        expect(".o_form_view").toHaveCount(1);
        expect.verifyErrors([WEB_READ_ERROR]);

        // Entry B: a form save of the same field on the same lead -- a
        // different Record instance than the kanban row, so it gets its
        // own `_offlineId` / queue entry instead of merging into entry A's
        // (record.js's `_offlineSave`: `id: this._offlineId`).
        await contains(".o_form_view .o_priority button.o_priority_star:eq(1)").click();
        await contains("button.o_form_button_save").click();

        queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(2);
        const second = queued.find((q) => q.key !== firstKey);
        expect(second.value.extras.timeStamp).toBeGreaterThan(firstTimeStamp);
        expect(second.value.args[1]).toEqual({ priority: "2" });

        await setOffline(false);
        await runAllTimers(); // flush _syncORM's 1s pause between the two replays

        // Replayed in extras.timeStamp order (offline_plugin.js's
        // `_syncORM` sorts by it), and the queue ends empty.
        expect(steps).toEqual(["1", "2"]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        // Last write wins: the server holds the later value.
        expect(MockServer.env["crm.lead"].find((r) => r.id === 1).priority).toBe("2");
    });
}

// ---------------------------------------------------------------------------
// VAL-QUEUE-002: no conflict detection or dialog.
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`no conflict dialog: a newer server-side change does not block the replay, and the offline edit wins (${preset})`, async () => {
        const setOffline = mockOffline();
        await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: Lead._views.form });
        await setOffline(true);

        await contains(`.o_field_widget[name="name"] input`).edit("Offline name");
        await contains("button.o_form_button_save").click();

        const queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        expect(queued[0].value.args).toEqual([[1], { name: "Offline name" }]);
        expect("write_date" in queued[0].value.kwargs).toBe(false);

        // "Someone else" edits the same lead directly on the server while
        // this tab is still offline: call the mock model's own `write`
        // directly (not through this tab's RPC layer, which is offline),
        // the same way a different browser session would. AGENTS.md
        // section 2: "no write_date comparison" -- the queue has no
        // mechanism to even notice this.
        MockServer.env["crm.lead"].write([1], { name: "Changed by someone else" });

        let webSaveCalls = 0;
        onRpc("crm.lead", "web_save", ({ args, kwargs, parent }) => {
            webSaveCalls++;
            // Sent verbatim: the offline value, no merge with the
            // concurrent change, and no write_date read/comparison.
            expect(args[1]).toEqual({ name: "Offline name" });
            expect("write_date" in kwargs).toBe(false);
            return parent();
        });

        await setOffline(false);

        expect(webSaveCalls).toBe(1);
        expect(".modal").toHaveCount(0); // no conflict dialog
        expect(MockServer.env["crm.lead"].find((r) => r.id === 1).name).toBe("Offline name"); // last write wins
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    });
}

// ---------------------------------------------------------------------------
// VAL-QUEUE-003: a rejected replay is parked under "Sync issues", with no
// CRM-specific error UI.
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`a rejected replay is parked under "Sync issues" with no CRM-specific error UI (${preset})`, async () => {
        onRpc("crm.lead", "web_save", ({ args, parent }) => {
            if (args[1]?.name === "Rejected edit") {
                throw makeServerError({
                    type: "UserError",
                    message: "Blocked by a validation rule.",
                });
            }
            return parent();
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(2);

        const setOffline = mockOffline();
        await setOffline(true);

        await contains(`.o_field_widget[name="name"] input`).edit("Rejected edit");
        await contains("button.o_form_button_save").click();
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);

        await setOffline(false);
        await runAllTimers(); // let _syncORM attempt the replay and fail

        // Stays parked (not dropped), with the error recorded
        // (offline_plugin.js's `_syncORM` catch branch).
        let queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        expect(queued[0].value.extras.error).toInclude("Blocked by a validation rule.");

        // No CRM-specific error UI: no notification, no dialog.
        expect(".o_notification").toHaveCount(0);
        expect(".modal").toHaveCount(0);

        // Web's own systray surfaces it as "Sync issues", in red --
        // addons/web's existing UI (webclient/offline_systray/
        // offline_systray.js's `inError`/`labelIcon`), unaffected by crm's
        // label patch (web_save already has a built-in STATUS entry).
        expect(".o_menu_systray .o_nav_entry [data-icon='error']").toHaveCount(1);
        await contains(".o_menu_systray .o_nav_entry [data-icon='error']").click();
        expect(".o-dropdown--menu").toHaveCount(1);
        // Scoped to the error label itself, not the (always-red) per-entry
        // discard button that sits next to it (offline_systray.xml).
        expect(".o-dropdown--menu .o-dropdown-item div.text-truncate.text-danger").toHaveCount(1);

        // Not replayed again automatically: another sync pass issues no
        // further web_save for it (`_syncORM` filters out entries that
        // already carry `extras.error`).
        await setOffline(true);
        await setOffline(false);
        await runAllTimers();
        queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1); // still the same single parked entry
    });
}

// ---------------------------------------------------------------------------
// VAL-QUEUE-007 (B67): action-menu Delete on crm.lead queued offline
// (web_unlink) and replayed.
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, action-menu Delete on a lead queues web_unlink and replays on reconnect (${preset})`, async () => {
        onRpc("crm.lead", "web_unlink", ({ parent }) => {
            expect.step("web_unlink");
            return parent();
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(2);

        const setOffline = mockOffline();
        await setOffline(true);

        // getStaticActionMenuItems() marks `delete: { availableOffline:
        // true, ... }` (form_controller.js), so the CogMenu/ActionMenus
        // template never disables it offline -- no crm wiring needed.
        await toggleActionMenu();
        await toggleMenuItem("Delete");
        expect(".modal").toHaveCount(1);
        await contains(".modal-footer button.btn-danger").click();

        expect.verifySteps([]); // not sent while offline: queued instead

        const queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        expect(queued[0].value.model).toBe("crm.lead");
        expect(queued[0].value.method).toBe("web_unlink");
        expect(queued[0].value.args).toEqual([[1]]);

        await setOffline(false);
        expect.verifySteps(["web_unlink"]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env["crm.lead"].some((r) => r.id === 1)).toBe(false); // deleted server-side
    });
}

// ---------------------------------------------------------------------------
// VAL-QUEUE-008 (B69): action-menu Archive, then (separately) Unarchive on
// crm.lead, queued offline and replayed. Two tests, like the generic
// reference ([Offline] archiving a record / [Offline] Unarchiving a
// record in form_view.test.js): a `ConnectionLostError` offline archive
// never flips `record.data.active` locally (record.js's `_toggleArchive`
// only calls `_load()` on the online success path), so a single record
// cannot be driven through "Archive" then "Unarchive" by the UI in one
// go: the "Unarchive" entry needs a record that was loaded archived.
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, action-menu Archive on an active lead queues action_archive and replays on reconnect (${preset})`, async () => {
        onRpc("crm.lead", "action_archive", ({ parent }) => {
            expect.step("action_archive");
            return parent();
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(2); // lead 1, active

        const setOffline = mockOffline();
        await setOffline(true);

        await toggleActionMenu();
        await toggleMenuItem("Archive");
        expect(".modal").toHaveCount(1);
        await contains(".modal-footer .btn-primary").click();
        expect.verifySteps([]);

        const queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        expect(queued[0].value.method).toBe("action_archive");
        expect(queued[0].value.args).toEqual([[1]]);

        await setOffline(false);
        expect.verifySteps(["action_archive"]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env["crm.lead"].find((r) => r.id === 1).active).toBe(false);
    });
}

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, action-menu Unarchive on an archived lead queues action_unarchive and replays on reconnect (${preset})`, async () => {
        onRpc("crm.lead", "action_unarchive", ({ parent }) => {
            expect.step("action_unarchive");
            return parent();
        });
        await mountWithCleanup(WebClient);
        await getService("action").doAction(3); // lead 2, already archived

        const setOffline = mockOffline();
        await setOffline(true);

        await toggleActionMenu();
        await toggleMenuItem("Unarchive"); // no confirmation dialog for unarchive
        expect.verifySteps([]);

        const queued = Object.values(getService(OfflinePlugin)._ormToSync());
        expect(queued.length).toBe(1);
        expect(queued[0].value.method).toBe("action_unarchive");
        expect(queued[0].value.args).toEqual([[2]]);

        await setOffline(false);
        expect.verifySteps(["action_unarchive"]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env["crm.lead"].find((r) => r.id === 2).active).toBe(true);
    });
}
