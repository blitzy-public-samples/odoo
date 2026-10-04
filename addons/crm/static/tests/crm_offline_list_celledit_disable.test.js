import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { animationFrame, expect, test } from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    MockServer,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * List cell editing is DISABLE offline (VAL-DIS-030, VAL-DIS-031,
 * architecture.md §3.7/§3.8) in the crm.lead lists (Leads, Opportunities
 * and the inherited report/forecast lists), the crm.stage list and the
 * inherited crm.team list.
 *
 * All three lists are `multi_edit="1"` with no `editable` attribute
 * (`crm_lead_views.xml:321,708`, `crm_stage_views.xml:22`,
 * `sales_team/views/crm_team_views.xml:100` retained by
 * `crm_team_views.xml:123`), so the only way to open a cell editor at all,
 * online or offline, is `onCellClicked`'s `multiEdit && record.selected`
 * branch (`list_renderer.js`) -- reached through `record.selected` alone,
 * never through `canSelectRecord`. An eventual multi-edit save routes
 * through `DynamicList._multiSave` (`model/relational_model/
 * dynamic_list.js`), which -- unlike every other save producer -- has no
 * `ConnectionLostError` branch: on any save error, offline or not, it
 * discards the edit on every selected record and re-throws. Queuing it
 * would mean patching a save path shared by every multi-edit list in every
 * installed app, not just these three crm models -- out of addons/crm's
 * scope and against AGENTS.md section 4's "never build a second offline
 * engine" rule. architecture.md §3.7 records the resulting decision:
 * `addons/crm` does not patch `_multiSave`; offline, these records are
 * edited from their form instead, whose save already queues a plain
 * `web_save` (VAL-DIS-031 below).
 *
 * Row selection itself stays available offline on all three lists
 * (`canSelectRecord` is untouched): action-menu Archive/Unarchive/Delete
 * on a selected lead must keep queueing
 * (`crm_offline_queue_semantics.test.js`). The guard instead sits on the
 * cell-edit entry points themselves (`onCellClicked`/
 * `onCellKeydownReadOnlyMode`, scoped by resModel in
 * `list_renderer_offline_patch.js`), which also covers a row checked
 * before going offline and a row already mid-edit when the connection
 * drops: an `effect()` forces such a row out of edition (discarding, never
 * saving) the moment offline is detected, so nothing can ever look saved
 * without being sent or queued.
 *
 * The crm.stage and crm.team equivalents of the "checked row, no cell
 * editor" and "mid-edit at disconnect" tests live in
 * `crm_offline_config_list_guards.test.js`. This file covers the
 * crm.lead list and VAL-DIS-031 (one queued `web_save` per model,
 * replayed on reconnect) for all three models.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    probability = fields.Integer({ default: 10 });
    // Mirrors B54's real selection values (crm_stage.py's
    // AVAILABLE_PRIORITIES), for the priority-star widget test below.
    priority = fields.Selection({
        selection: [
            ["0", "Low"],
            ["1", "Medium"],
            ["2", "High"],
            ["3", "Very High"],
        ],
        default: "0",
    });

    _records = [
        { id: 1, name: "First lead", probability: 10, priority: "0" },
        { id: 2, name: "Second lead", probability: 20, priority: "0" },
        { id: 3, name: "Third lead", probability: 30, priority: "0" },
    ];

    _views = {
        list: `
            <list multi_edit="1">
                <field name="name"/>
                <field name="probability"/>
                <field name="priority" widget="priority"/>
            </list>`,
        form: `
            <form>
                <field name="name"/>
                <field name="probability"/>
            </form>`,
    };
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();

    _records = [{ id: 1, name: "New" }];

    _views = {
        list: `<list><field name="name"/></list>`,
        form: `<form><field name="name"/></form>`,
    };
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [{ id: 1, name: "Sales Team" }];

    _views = {
        list: `<list><field name="name"/></list>`,
        form: `<form><field name="name"/></form>`,
    };
}

defineModels([Lead, Stage, Team]);
defineMailModels();
defineActions([
    {
        id: 1,
        name: "Leads",
        res_model: "crm.lead",
        type: "ir.actions.act_window",
        views: [[false, "list"], [false, "form"]],
    },
    {
        id: 2,
        name: "Stages",
        res_model: "crm.stage",
        type: "ir.actions.act_window",
        views: [[false, "list"], [false, "form"]],
    },
    {
        id: 3,
        name: "Teams",
        res_model: "crm.team",
        type: "ir.actions.act_window",
        views: [[false, "list"], [false, "form"]],
    },
]);

// ---------------------------------------------------------------------------
// VAL-DIS-030: the Leads list's cell editing is disabled offline with one
// and with several checked rows, including a row checked before going
// offline, while row selection itself stays available; online cell
// editing with checked rows still works. Desktop-only: `hasSelectors`
// (`list_renderer.js`, `allowSelectors && !this.uiService.isSmall`) never
// renders the row-selector column on mobile for any list, so neither
// selection nor multi-edit is reachable there in the first place -- see
// the dedicated mobile test below.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the Leads list's row checkbox stays enabled but no cell editor opens with one checked row, including a row checked before going offline; online cell editing still works", async () => {
    const steps = [];
    onRpc("crm.lead", ["web_save", "web_save_multi"], ({ method, parent }) => {
        steps.push(method);
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    // Checked online, before going offline (VAL-DIS-030's "including rows
    // checked before going offline" case).
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Row selection itself stays available offline: the already-checked
    // row stays checked and can be unchecked, and the action-menu
    // Archive/Unarchive/Delete it feeds still queue
    // (`crm_offline_queue_semantics.test.js`'s VAL-QUEUE-007/-008).
    expect(".o_data_row:eq(0) .o_list_record_selector input").toHaveProperty("disabled", false);
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

    // But its only edit entry point -- a cell click or Enter, which
    // online enters multi-edit regardless of `isInlineEditable`
    // (`onCellClicked`, never gated by `canSelectRecord`) -- opens no
    // editor.
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_field_widget[name='name'] input").toHaveCount(0);
    expect(".o_data_row:eq(0) [name='name']").toHaveText("First lead"); // the cell still shows its original value
    await contains(".o_data_row:eq(0) [name='probability']").focus();
    await press("Enter");
    expect(".o_field_widget[name='probability'] input").toHaveCount(0);

    expect(steps).toEqual([]); // neither web_save nor web_save_multi sent or queued
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);

    // Back online, the same checked row's cell still enters multi-edit
    // and saves as before.
    await contains(".o_data_row:eq(0) [name='name']").click();
    await contains(".o_field_widget[name='name'] input").edit("Renamed lead");
    await contains(".o_list_renderer").click();
    expect(steps).toEqual(["web_save"]);
});

test.tags("desktop");
test("offline, with two or more rows checked on the Leads list no cell is editable on any of them; online they still are", async () => {
    const steps = [];
    onRpc("crm.lead", ["web_save", "web_save_multi"], ({ method, parent }) => {
        steps.push(method);
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Check two rows while offline: selection keeps working for more than
    // one row.
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");
    expect(".o_data_row:eq(1)").toHaveClass("o_data_row_selected");

    // Neither checked row's cell opens an editor.
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_field_widget[name='name'] input").toHaveCount(0);
    expect(".o_data_row:eq(0) [name='name']").toHaveText("First lead");
    await contains(".o_data_row:eq(1) [name='name']").click();
    expect(".o_field_widget[name='name'] input").toHaveCount(0);
    expect(".o_data_row:eq(1) [name='name']").toHaveText("Second lead");

    expect(steps).toEqual([]); // neither web_save nor web_save_multi
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    await setOffline(false);

    // Online, editing one of the two still checked rows multi-edit-saves
    // both, after the framework's own multi-record confirmation dialog
    // (`ListConfirmationDialog`, shown whenever `selection.length > 1`).
    await contains(".o_data_row:eq(0) [name='name']").click();
    await contains(".o_field_widget[name='name'] input").edit("Both renamed");
    await contains(".o_list_renderer").click();
    expect(".modal").toHaveCount(1);
    await contains(".modal-footer .btn-primary").click();
    expect(steps).toEqual(["web_save"]);
});

test.tags("desktop");
test("offline, a Leads list row already mid cell-edit when the connection drops leaves edit mode instead of risking a silent save", async () => {
    const steps = [];
    onRpc("crm.lead", ["web_save", "web_save_multi"], ({ method, parent }) => {
        steps.push(method);
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    // Online: check the row and open its cell editor (allowed online).
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(0) [name='name']").click();
    await contains(".o_field_widget[name='name'] input").edit("Mid-edit draft", {
        confirm: false, // keep the draft unsubmitted, like a user mid-keystroke
    });
    expect(".o_field_widget[name='name'] input").toHaveCount(1);

    // The connection drops mid-edit: the row is forced out of edition
    // (discarding the in-progress draft, never saving it) instead of
    // leaving an edit that could look saved without being sent or queued.
    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect(".o_field_widget[name='name'] input").toHaveCount(0);
    // The cell shows the record's real, unchanged value -- not the
    // discarded "Mid-edit draft" left looking saved without being sent or
    // queued.
    expect(".o_data_row:eq(0) [name='name']").toHaveText("First lead");
    expect(steps).toEqual([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).name).toBe("First lead");

    await setOffline(false);
});

// ---------------------------------------------------------------------------
// VAL-DIS-030 (user-testing evidence): the same cell-edit guard, proven
// across the Opportunities-style and inherited report/forecast-style list
// families, not just the bare arch above. `list_renderer_offline_patch.js`
// scopes the guard by `record.resModel`, not by `js_class` or arch shape
// (`CELL_EDIT_DISABLED_MODELS`), so this is evidence completeness across
// view families, not a different code path.
// ---------------------------------------------------------------------------

const OPPORTUNITIES_LIKE_LIST_ARCH = `
    <list js_class="crm_list" multi_edit="1">
        <field name="name"/>
        <field name="probability"/>
        <field name="priority" widget="priority"/>
    </list>`;

// Mirrors the shape of the inherited report/forecast lists (B88): same
// model, same guard, non-creatable and with the extra columns collapsed
// the way a report list typically renders them, so the arch isn't just a
// duplicate of the bare one above.
const REPORT_STYLE_LIST_ARCH = `
    <list js_class="crm_list" multi_edit="1" create="0">
        <field name="name"/>
        <field name="probability" column_invisible="True"/>
        <field name="priority" widget="priority" column_invisible="True"/>
    </list>`;

const LIST_ARCH_FAMILIES = [
    { label: "Opportunities-like", arch: OPPORTUNITIES_LIKE_LIST_ARCH },
    { label: "report/forecast-style", arch: REPORT_STYLE_LIST_ARCH },
];

for (const { label, arch } of LIST_ARCH_FAMILIES) {
    test.tags("desktop");
    test(`offline, the ${label} Leads list family also disables cell editing on a checked row, issuing no web_save/web_save_multi, with the cell showing its original value; online it still edits`, async () => {
        const steps = [];
        onRpc("crm.lead", ["web_save", "web_save_multi"], ({ method, parent }) => {
            steps.push(method);
            return parent();
        });
        await mountView({ resModel: "crm.lead", type: "list", arch });

        await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
        expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

        const setOffline = mockCrmOffline();
        await setOffline(true);

        await contains(".o_data_row:eq(0) [name='name']").click();
        expect(".o_field_widget[name='name'] input").toHaveCount(0);
        expect(".o_data_row:eq(0) [name='name']").toHaveText("First lead"); // unchanged display, not just no input

        expect(steps).toEqual([]); // neither web_save nor web_save_multi
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

        await setOffline(false);

        await contains(".o_data_row:eq(0) [name='name']").click();
        await contains(".o_field_widget[name='name'] input").edit("Renamed via family check");
        await contains(".o_list_renderer").click();
        expect(steps).toEqual(["web_save"]);
    });
}

// ---------------------------------------------------------------------------
// Finding 18 (scrutiny round 1, VAL-DIS-030): the priority star carries
// `data-available-offline` on its own `<button>`
// (`priority_field.xml`), so the framework's own disabling pass never
// touches it, and its click handler (`onStarClicked` -> `updateRecord` ->
// `record.update()`) is a different entry point from
// `ListRenderer.onCellClicked`/`onCellKeydownReadOnlyMode` above --
// `t-on-click.stop` never lets the renderer's own handler see the click
// at all. On a *checked* row of this `multi_edit="1"` list, that still
// reaches `DynamicList._multiSave()` (`record.js`'s `selected &&
// model.multiEdit` branch), the exact unqueued path this file exists to
// keep crm.lead/crm.stage/crm.team list cell edits away from. On an
// *unchecked* row the star is a standalone widget, not list cell editing
// at all, and keeps queueing a plain per-record `web_save({priority})`
// (B22/B53/B54's existing producer) exactly as before, online or offline.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the priority star on a checked Opportunities row issues no web_save/web_save_multi and queues nothing, with no visible change; online it still multi-edit-saves", async () => {
    const steps = [];
    onRpc("crm.lead", ["web_save", "web_save_multi"], ({ method, parent }) => {
        steps.push(method);
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // The star stays enabled (it carries its own `data-available-offline`,
    // unlike a plain framework-owned button), but clicking it issues no
    // RPC, queues nothing, and leaves the displayed value unchanged.
    // `:eq(0)` is the first *rendered* star, for selection value "1"
    // ("Medium"): the template skips a star for the first selection
    // option ("0"/"Low", `t-if="!value_first"`), the same offset
    // `crm_offline_queue_semantics.test.js`'s kanban priority click
    // relies on.
    expect(".o_data_row:eq(0) .o_priority button.o_priority_star:eq(0)").toHaveProperty(
        "disabled",
        false
    );
    await contains(".o_data_row:eq(0) .o_priority button.o_priority_star:eq(0)").click();

    expect(steps).toEqual([]); // no web_save or web_save_multi sent or queued
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    // The underlying data is unaffected (the template's own `oi-filled`
    // class on a hovered-over star is just a hover-preview highlight,
    // `t-on-mouseenter="() => this.state.index = value_index"` --
    // unrelated to whether the click's write went through -- so the
    // server/record value, not a DOM class, is the only reliable signal
    // that nothing changed).
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).priority).toBe("0"); // unchanged
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);

    // Online, the same checked row's star still multi-edit-saves as
    // before (B54's existing behavior, unregressed by this guard): a
    // plain Selection value routes `_multiSave` through `orm.webSave`
    // (`dynamic_list.js`), not `webSaveMulti` (that one is only used for
    // Field Operations, e.g. the "+"/"-" increment widgets).
    await contains(".o_data_row:eq(0) .o_priority button.o_priority_star:eq(0)").click();
    expect(steps).toEqual(["web_save"]);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).priority).toBe("1");
});

test.tags("desktop");
test("offline, the priority star on an unchecked Opportunities row still queues a plain web_save, unaffected by the checked-row guard", async () => {
    onRpc("crm.lead", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // No row is checked: this is the ordinary per-record priority
    // producer (B54), not list cell editing, and must keep queueing.
    expect(".o_data_row:eq(0)").not.toHaveClass("o_data_row_selected");
    await contains(".o_data_row:eq(0) .o_priority button.o_priority_star:eq(0)").click();

    expect.verifySteps([]); // not sent while offline: queued instead
    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    expect(queued[0].value.model).toBe("crm.lead");
    expect(queued[0].value.method).toBe("web_save");
    expect(queued[0].value.args).toEqual([[1], { priority: "1" }]);

    await setOffline(false);
    expect.verifySteps(["web_save"]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).priority).toBe("1");
});

// ---------------------------------------------------------------------------
// VAL-DIS-030, mobile preset: no cell editor is reachable in the first
// place, offline or online, so there is nothing offline-specific to prove.
// ---------------------------------------------------------------------------

test.tags("mobile");
test("under the mobile preset, the Leads list renders no row selector, so no cell editor is reachable at all, offline or online", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });
    expect(".o_list_record_selector").toHaveCount(0);

    const setOffline = mockCrmOffline();
    await setOffline(true);
    expect(".o_list_record_selector").toHaveCount(0);

    await setOffline(false);
    expect(".o_list_record_selector").toHaveCount(0);
});

// ---------------------------------------------------------------------------
// VAL-DIS-031: a form save offline for a lead, a stage and a team each
// queues exactly one `web_save` and replays it on reconnect. This is the
// offline alternative to the disabled cell edits above: these three
// records are edited from their form instead, through the framework's own
// (unpatched) save producer.
// ---------------------------------------------------------------------------

const FORM_SAVE_CASES = [
    { resModel: "crm.lead", label: "a lead", arch: Lead._views.form, before: "First lead" },
    { resModel: "crm.stage", label: "a stage", arch: Stage._views.form, before: "New" },
    { resModel: "crm.team", label: "a team", arch: Team._views.form, before: "Sales Team" },
];

for (const { resModel, label, arch, before } of FORM_SAVE_CASES) {
    for (const preset of ["desktop", "mobile"]) {
        test.tags(preset);
        test(`offline, saving ${label}'s form queues exactly one web_save and replays it on reconnect (${preset})`, async () => {
            onRpc(resModel, "web_save", ({ parent }) => {
                expect.step("web_save");
                return parent();
            });
            await mountView({ resModel, type: "form", resId: 1, arch });
            expect(`.o_field_widget[name='name'] input`).toHaveValue(before);

            const setOffline = mockCrmOffline();
            await setOffline(true);

            const after = `Edited offline (${resModel})`;
            await contains(`.o_field_widget[name='name'] input`).edit(after);
            await contains("button.o_form_button_save").click();
            expect.verifySteps([]); // not sent while offline

            const queued = Object.values(getService(OfflinePlugin)._ormToSync());
            expect(queued.length).toBe(1);
            expect(queued[0].value.model).toBe(resModel);
            expect(queued[0].value.method).toBe("web_save");
            expect(queued[0].value.args).toEqual([[1], { name: after }]);

            await setOffline(false);
            expect.verifySteps(["web_save"]);
            expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
            expect(MockServer.env[resModel].find((r) => r.id === 1).name).toBe(after);
        });
    }
}

// VAL-DIS-031 (round-1 user testing): the original version of this test
// only covered crm.lead, desktop-only. The systray's "Edited" label comes
// from `web_save`'s own `extras.changes` (record.js), the same producer
// FORM_SAVE_CASES above already proves for all three models, so the
// systray rendering of it needs the same per-model coverage, plus a
// mobile variant for the toggler quirk noted below.
const SYSTRAY_CASES = [
    { resModel: "crm.lead", label: "a lead", actionId: 1 },
    { resModel: "crm.stage", label: "a stage", actionId: 2 },
    { resModel: "crm.team", label: "a team", actionId: 3 },
];

for (const { resModel, label, actionId } of SYSTRAY_CASES) {
    for (const preset of ["desktop", "mobile"]) {
        test.tags(preset);
        test(`offline, the systray shows a queued ${label} form save labeled 'Edited', with no crash, and replays it on reconnect (${preset})`, async () => {
            // Matches VAL-DIS-031's exact scenario: the record is opened
            // from its list (cached/visited online), not mounted as a
            // bare form.
            onRpc(resModel, "web_save", ({ parent }) => {
                expect.step("web_save");
                return parent();
            });
            await mountWithCleanup(WebClient);
            await getService("action").doAction(actionId);
            await contains(".o_data_row:eq(0) [name='name']").click();
            expect(".o_form_view").toHaveCount(1);

            const setOffline = mockCrmOffline();
            await setOffline(true);

            const after = `Edited offline for the systray check (${resModel})`;
            await contains(`.o_field_widget[name='name'] input`).edit(after);
            await contains("button.o_form_button_save").click();
            expect.verifySteps([]); // not sent while offline
            expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);

            await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
            if (preset === "mobile") {
                // mobile's toggler is a bare div, not the Dropdown's own
                // button (crm_offline_systray_restore.test.js's mobile
                // test needs the same extra frame).
                await animationFrame();
            }
            expect(".o-dropdown--menu").toHaveCount(1);
            expect(".o-dropdown--menu .o-dropdown-item div.ms-auto").toHaveText("Edited");

            await setOffline(false);
            expect.verifySteps(["web_save"]);
            expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
            expect(MockServer.env[resModel].find((r) => r.id === 1).name).toBe(after);
        });
    }
}

// ---------------------------------------------------------------------------
// VAL-DATA-004: unlike FORM_SAVE_CASES/SYSTRAY_CASES above (whose form is
// already mounted, online, before the test goes offline), this proves the
// contract's own wording for crm.stage and crm.team: visited online, then,
// while offline, a *fresh* navigation to the cached form (not the one still
// mounted) and back to the cached list, around the queued save. Both the
// form and the list must render from the disk cache alone, each losing the
// genuine `web_read`/`web_search_read` race it attempts (the same idiom
// `crm_offline_uncached_lead.test.js` uses for the identical two-error
// shape). crm.lead's own form/list cold-navigation is already covered by
// `crm_offline_data_queue_replay.test.js`'s VAL-DATA-001/002 and
// `crm_offline_uncached_lead.test.js`; not duplicated here.
// ---------------------------------------------------------------------------

const COLD_FORM_SAVE_CASES = [
    { resModel: "crm.stage", label: "a crm.stage", actionId: 2, before: "New" },
    { resModel: "crm.team", label: "a crm.team", actionId: 3, before: "Sales Team" },
];

for (const { resModel, label, actionId, before } of COLD_FORM_SAVE_CASES) {
    for (const preset of ["desktop", "mobile"]) {
        test.tags(preset);
        test(`offline, freshly reopening ${label}'s cached form from its cached list and returning to the list queues one web_save and replays it (${preset})`, async () => {
            onRpc(resModel, "web_save", ({ parent }) => {
                expect.step("web_save");
                return parent();
            });
            await mountWithCleanup(WebClient);
            await getService("action").doAction(actionId);
            await contains(".o_data_row:eq(0) [name='name']").click();
            expect(".o_form_view").toHaveCount(1);
            await contains(".o_breadcrumb .o_back_button").click();
            expect(".o_list_view").toHaveCount(1);

            const setOffline = mockCrmOffline();
            await setOffline(true);

            // A fresh navigation to the record's form, not the one still
            // mounted above: `web_read` is genuinely attempted and loses
            // the race to the disk-cache hit, same idiom as
            // crm_offline_uncached_lead.test.js and
            // crm_offline_data_queue_replay.test.js's VAL-DATA-001/002.
            expect.errors(1);
            await contains(".o_data_row:eq(0) [name='name']").click();
            expect(".o_form_view").toHaveCount(1);
            expect(`.o_field_widget[name='name'] input`).toHaveValue(before);
            expect.verifyErrors([
                `Connection to "/web/dataset/call_kw/${resModel}/web_read" couldn't be established or was interrupted`,
            ]);

            const after = `Edited offline, fresh navigation (${resModel})`;
            await contains(`.o_field_widget[name='name'] input`).edit(after);
            await contains("button.o_form_button_save").click();
            expect.verifySteps([]); // not sent while offline

            const queued = Object.values(getService(OfflinePlugin)._ormToSync());
            expect(queued.length).toBe(1);
            expect(queued[0].value.model).toBe(resModel);
            expect(queued[0].value.method).toBe("web_save");
            expect(queued[0].value.args).toEqual([[1], { name: after }]);

            // Back to the list through the breadcrumb: it re-fetches too
            // and loses the same race, so the cached list still renders
            // from the disk cache (the queued, not-yet-replayed, edit is
            // not reflected in it -- only the row count is asserted here).
            // `expect.errors()`'s count is cumulative for the whole test
            // (crm_offline_uncached_lead.test.js's own idiom), hence 2
            // here: the web_read error above plus this one.
            expect.errors(2);
            await contains(".o_breadcrumb .o_back_button").click();
            expect(".o_list_view").toHaveCount(1);
            expect(".o_data_row").toHaveCount(1);
            expect.verifyErrors([
                `Connection to "/web/dataset/call_kw/${resModel}/web_search_read" couldn't be established or was interrupted`,
            ]);

            await setOffline(false);
            expect.verifySteps(["web_save"]);
            expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
            expect(MockServer.env[resModel].find((r) => r.id === 1).name).toBe(after);
        });
    }
}
