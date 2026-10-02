import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
import {
    contains,
    defineActions,
    defineModels,
    fields,
    getService,
    MockServer,
    models,
    mockOffline,
    mountView,
    mountWithCleanup,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";

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

    _records = [
        { id: 1, name: "First lead", probability: 10 },
        { id: 2, name: "Second lead", probability: 20 },
        { id: 3, name: "Third lead", probability: 30 },
    ];

    _views = {
        list: `
            <list multi_edit="1">
                <field name="name"/>
                <field name="probability"/>
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
        form: `<form><field name="name"/></form>`,
    };
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [{ id: 1, name: "Sales Team" }];

    _views = {
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
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    // Checked online, before going offline (VAL-DIS-030's "including rows
    // checked before going offline" case).
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

    const setOffline = mockOffline();
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
    await contains(".o_data_row:eq(0) [name='probability']").focus();
    await press("Enter");
    expect(".o_field_widget[name='probability'] input").toHaveCount(0);

    expect.verifySteps([]); // no web_save sent or queued
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);

    // Back online, the same checked row's cell still enters multi-edit
    // and saves as before.
    await contains(".o_data_row:eq(0) [name='name']").click();
    await contains(".o_field_widget[name='name'] input").edit("Renamed lead");
    await contains(".o_list_renderer").click();
    expect.verifySteps(["web_save"]);
});

test.tags("desktop");
test("offline, with two or more rows checked on the Leads list no cell is editable on any of them; online they still are", async () => {
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });

    const setOffline = mockOffline();
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
    await contains(".o_data_row:eq(1) [name='name']").click();
    expect(".o_field_widget[name='name'] input").toHaveCount(0);

    expect.verifySteps([]);
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
    expect.verifySteps(["web_save"]);
});

test.tags("desktop");
test("offline, a Leads list row already mid cell-edit when the connection drops leaves edit mode instead of risking a silent save", async () => {
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
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
    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_field_widget[name='name'] input").toHaveCount(0);
    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.lead"].find((r) => r.id === 1).name).toBe("First lead");

    await setOffline(false);
});

// ---------------------------------------------------------------------------
// VAL-DIS-030, mobile preset: no cell editor is reachable in the first
// place, offline or online, so there is nothing offline-specific to prove.
// ---------------------------------------------------------------------------

test.tags("mobile");
test("under the mobile preset, the Leads list renders no row selector, so no cell editor is reachable at all, offline or online", async () => {
    await mountView({ resModel: "crm.lead", type: "list", arch: Lead._views.list });
    expect(".o_list_record_selector").toHaveCount(0);

    const setOffline = mockOffline();
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

            const setOffline = mockOffline();
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

test.tags("desktop");
test("offline, the systray shows a queued lead form save labeled 'Edited', with no crash", async () => {
    // Matches VAL-DIS-031's exact scenario: the record is opened from its
    // list (cached/visited online), not mounted as a bare form.
    await mountWithCleanup(WebClient);
    await getService("action").doAction(1);
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_form_view").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(`.o_field_widget[name='name'] input`).edit("Edited for the systray check");
    await contains("button.o_form_button_save").click();
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(1);

    await contains(".o_menu_systray .o_nav_entry [data-icon='link_off']").click();
    expect(".o-dropdown--menu").toHaveCount(1);
    expect(".o-dropdown--menu .o-dropdown-item div.ms-auto").toHaveText("Edited");

    await setOffline(false);
});
