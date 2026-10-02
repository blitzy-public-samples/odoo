import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { press, queryAllTexts } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    fields,
    getService,
    MockServer,
    models,
    mockOffline,
    mountView,
    onRpc,
    toggleActionMenu,
    toggleMenuItem,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";

/**
 * Bucket F3 (VAL-DIS-017, rows B48/B59/B60/B61/B68/B90): config and report
 * lists guarded offline.
 *
 * - B59 (`crm_stage_views.xml:23`) / B90 (`sales_team/views/crm_team_views.xml:100`,
 *   retained unchanged by `crm_team_views.xml:123`): the Stages and
 *   inherited Sales Team lists' `widget="handle"` drag calls the shared
 *   `resequence()` util -> `orm.webResequence`, never one of the
 *   framework's four auto-queued producers (architecture.md §3.7).
 * - B40/B74: cell edits on these two lists are DISABLE offline (reclassified
 *   from "still queue" by the m2-list-celledit-disable feature, which also
 *   reclassified B88's multi-edit part the same way for the crm.lead lists
 *   -- see `offline_inventory.md` and that feature's KNOWN-LIMIT). Both
 *   lists are `multi_edit="1"` with no `editable` attribute, so the only
 *   way to open a cell editor at all, online or offline, is to check a row
 *   first and let `onCellClicked`'s `multiEdit && record.selected` branch
 *   (`list_renderer.js`) call `enterEditMode`, which an eventual save would
 *   route through `DynamicList._multiSave`
 *   (`model/relational_model/dynamic_list.js`): unlike every other save
 *   producer, it has no `ConnectionLostError` branch and re-throws,
 *   discarding the edit. Row selection itself stays available offline on
 *   both lists (`canSelectRecord` is untouched -- B67/B69-style
 *   action-menu operations on a selected row must keep working), so the
 *   guard instead sits on the cell-edit entry points themselves
 *   (`onCellClicked`/`onCellKeydownReadOnlyMode`, scoped by resModel in
 *   `list_renderer_offline_patch.js`), covering a row checked before going
 *   offline and a row already mid-edit when the connection drops too. The
 *   crm.lead lists get the identical guard; their tests live in
 *   `crm_offline_list_celledit_disable.test.js`.
 * - B60/B61 (`crm_recurring_plan_views.xml:9`, `crm_lost_reason_views.xml:49`):
 *   `crm.recurring.plan` and `crm.lost.reason` are editable lists outside
 *   rule 1's model scope (not a lead, stage, team or lead activity), so a
 *   cell click must open no editor at all -- there is no handler on the
 *   save itself to guard, only entry into edition.
 * - B68 (same two files): their selected-record Action-menu
 *   Archive/Unarchive/Delete must not queue either, even though
 *   `getStaticActionMenuItems()` marks them `availableOffline: true`
 *   unconditionally for any model (right for B67/B69's `crm.lead`/
 *   `crm.team`, wrong for these two out-of-scope models).
 * - B48 (`report/crm_activity_report_views.xml:31`): the activity report
 *   list's `action="action_open_lead" type="object"` row click must not
 *   call it offline either -- a server-computed report navigation, not a
 *   bare resolvable write.
 *
 * Production code: `views/view_components/list_renderer_offline_patch.js`
 * (handle drag, inline-edit entry) and
 * `views/view_components/list_controller_offline_patch.js` (action-menu
 * callbacks, row-click fallback).
 */

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    rotting_threshold_days = fields.Integer({ default: 30 });

    _records = [
        { id: 1, name: "New", sequence: 1, rotting_threshold_days: 30 },
        { id: 2, name: "Qualified", sequence: 2, rotting_threshold_days: 30 },
        { id: 3, name: "Won", sequence: 3, rotting_threshold_days: 30 },
    ];

    _views = {
        list: `
            <list multi_edit="1">
                <field name="sequence" widget="handle"/>
                <field name="name"/>
                <field name="rotting_threshold_days"/>
            </list>`,
    };
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    alias_full_name = fields.Char();

    _records = [
        { id: 1, name: "Sales Team", sequence: 1, alias_full_name: "sales" },
        { id: 2, name: "Other Team", sequence: 2, alias_full_name: "other" },
    ];

    // Mirrors the real inherited list (`sales_team.crm_team_view_tree`,
    // `multi_edit="1"`, `:100`'s handle, retained unchanged by
    // `crm_team_views.xml:123`'s additive xpath): B74's ordinary cell edit
    // plus B90's handle in the same list.
    _views = {
        list: `
            <list multi_edit="1">
                <field name="sequence" widget="handle"/>
                <field name="name"/>
                <field name="alias_full_name"/>
            </list>`,
    };
}

class RecurringPlan extends models.Model {
    _name = "crm.recurring.plan";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });
    active = fields.Boolean({ default: true });

    _records = [
        { id: 1, name: "Monthly", sequence: 1, active: true },
        { id: 2, name: "Yearly", sequence: 2, active: true },
    ];

    _views = {
        list: `
            <list editable="bottom">
                <field name="sequence" widget="handle"/>
                <field name="name"/>
            </list>`,
    };
}

class LostReason extends models.Model {
    _name = "crm.lost.reason";

    name = fields.Char();
    active = fields.Boolean({ default: true });

    _records = [
        { id: 1, name: "Too expensive", active: true },
        { id: 2, name: "Not interested", active: true },
    ];

    _views = {
        list: `
            <list string="Channel" editable="bottom">
                <field name="name"/>
            </list>`,
    };
}

class ActivityReport extends models.Model {
    _name = "crm.activity.report";

    name = fields.Char();
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        { id: 1, name: "Activity 1", team_id: 1 },
        { id: 2, name: "Activity 2", team_id: 2 },
    ];
}

defineModels([Stage, Team, RecurringPlan, LostReason, ActivityReport]);
defineMailModels();

// ---------------------------------------------------------------------------
// B59/B40: Stages list handle drag inert offline, and -- see this feature's
// handoff KNOWN-LIMIT -- a cell edit is unreachable too, since this list's
// only edit entry point (checking a row to multi-edit it) is itself
// disabled. Both tests below are desktop-only: `ListRenderer.hasSelectors`
// (`list_renderer.js`) is `allowSelectors && !this.uiService.isSmall`, so
// the row-selector column -- and therefore any row selection at all, the
// precondition for both the handle drag (same reasoning as
// crm_offline_kanban_group_guards.test.js's column-drag tests) and
// multi-edit -- never renders on mobile for any list, online or offline;
// there is nothing offline-specific left to prove there.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the Stages list's row checkbox stays enabled but no cell editor opens, including a row checked before going offline; online cell editing still works", async () => {
    onRpc("crm.stage", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.stage", type: "list", arch: Stage._views.list });

    // Checked online, before going offline (VAL-DIS-030's "including rows
    // checked before going offline" case).
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

    const setOffline = mockOffline();
    await setOffline(true);

    // Row selection itself stays available offline (architecture.md §3.7:
    // action-menu Archive/Unarchive/Delete, B67/B69, still queue through
    // it) -- the already-checked row stays checked, and a second row can
    // still be checked too.
    expect(".o_data_row:eq(0) .o_list_record_selector input").toHaveProperty("disabled", false);
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    expect(".o_data_row:eq(1)").toHaveClass("o_data_row_selected");

    // But the only edit entry point this `multi_edit="1"`-with-no-
    // `editable` list has -- a cell click or Enter on a checked row,
    // which online enters multi-edit regardless of `isInlineEditable`
    // (`list_renderer.js`'s `onCellClicked`, never gated by
    // `canSelectRecord`) -- opens no editor on either checked row.
    await contains(".o_data_row:eq(0) [name='rotting_threshold_days']").click();
    expect(".o_field_widget[name='rotting_threshold_days'] input").toHaveCount(0);
    await contains(".o_data_row:eq(1) [name='rotting_threshold_days']").focus();
    await press("Enter");
    expect(".o_field_widget[name='rotting_threshold_days'] input").toHaveCount(0);

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_notification").toHaveCount(0);

    // Uncheck the second row again before going back online, so the
    // single-record save below doesn't trip the framework's own
    // multi-record `ListConfirmationDialog` (shown whenever more than one
    // record is selected) -- that dialog is itself unrelated to this fix.
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    await setOffline(false);

    // Back online, checking a row and editing it still multi-edit-saves.
    await contains(".o_data_row:eq(0) [name='rotting_threshold_days']").click();
    await contains(".o_field_widget[name='rotting_threshold_days'] input").edit("45");
    await contains(".o_list_renderer").click();
    expect.verifySteps(["web_save"]);
});

test.tags("desktop");
test("offline, a Stages list row already mid cell-edit when the connection drops leaves edit mode instead of risking a silent save", async () => {
    onRpc("crm.stage", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.stage", type: "list", arch: Stage._views.list });

    // Online: check the row and open its cell editor (allowed online).
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(0) [name='rotting_threshold_days']").click();
    await contains(".o_field_widget[name='rotting_threshold_days'] input").edit("999", {
        confirm: false, // keep the draft unsubmitted, like a user mid-keystroke
    });
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");
    expect(".o_field_widget[name='rotting_threshold_days'] input").toHaveCount(1);

    // The connection drops mid-edit: the row is forced out of edition
    // (discarding the in-progress "999", never saving it) instead of
    // leaving an edit that could look saved without being sent or queued.
    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_field_widget[name='rotting_threshold_days'] input").toHaveCount(0);
    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(
        MockServer.env["crm.stage"].find((r) => r.id === 1).rotting_threshold_days
    ).toBe(30); // unchanged: the discarded "999" was never sent or queued

    await setOffline(false);
});

test.tags("desktop");
test("offline, dragging the Stages list's handle does not resequence it; online it still does", async () => {
    onRpc("crm.stage", "web_resequence", ({ parent }) => {
        expect.step("web_resequence");
        return parent();
    });
    await mountView({ resModel: "crm.stage", type: "list", arch: Stage._views.list });

    const namesBefore = queryAllTexts(".o_data_row [name='name']");
    expect(namesBefore).toEqual(["New", "Qualified", "Won"]);

    const setOffline = mockOffline();
    await setOffline(true);

    // B59: the handle drag never starts (`canResequenceRows` is false),
    // so the order is unchanged and no `web_resequence` is issued.
    await contains(".o_data_row:eq(0) .o_handle_cell").dragAndDrop(
        ".o_data_row:eq(1) .o_handle_cell"
    );
    expect(queryAllTexts(".o_data_row [name='name']")).toEqual(namesBefore);
    expect.verifySteps([]);

    await setOffline(false);

    // Back online, the handle drag works again.
    await contains(".o_data_row:eq(0) .o_handle_cell").dragAndDrop(
        ".o_data_row:eq(1) .o_handle_cell"
    );
    expect.verifySteps(["web_resequence"]);
    expect(queryAllTexts(".o_data_row [name='name']")).not.toEqual(namesBefore);
});

// ---------------------------------------------------------------------------
// B90/B74: inherited Sales Team list -- same two guards as the Stages list
// above (handle drag inert, row checkbox / multi-edit disabled), desktop-
// only for the same `hasSelectors`/mobile reason.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the inherited Sales Team list's row checkbox stays enabled but no cell editor opens, including a row checked before going offline; online cell editing still works", async () => {
    onRpc("crm.team", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.team", type: "list", arch: Team._views.list });

    // Checked online, before going offline (VAL-DIS-030's "including rows
    // checked before going offline" case).
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

    const setOffline = mockOffline();
    await setOffline(true);

    // Row selection itself stays available offline, and a second row can
    // still be checked too (two or more checked rows).
    expect(".o_data_row:eq(0) .o_list_record_selector input").toHaveProperty("disabled", false);
    expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    expect(".o_data_row:eq(1)").toHaveClass("o_data_row_selected");

    // But no cell editor opens on either checked row.
    await contains(".o_data_row:eq(0) [name='alias_full_name']").click();
    expect(".o_field_widget[name='alias_full_name'] input").toHaveCount(0);
    await contains(".o_data_row:eq(1) [name='alias_full_name']").focus();
    await press("Enter");
    expect(".o_field_widget[name='alias_full_name'] input").toHaveCount(0);

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".o_notification").toHaveCount(0);

    // Uncheck the second row again before going back online (same reason
    // as the Stages list test above: avoid the unrelated multi-record
    // `ListConfirmationDialog`).
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    await setOffline(false);

    await contains(".o_data_row:eq(0) [name='alias_full_name']").click();
    await contains(".o_field_widget[name='alias_full_name'] input").edit("renamed");
    await contains(".o_list_renderer").click();
    expect.verifySteps(["web_save"]);
});

test.tags("desktop");
test("offline, an inherited Sales Team list row already mid cell-edit when the connection drops leaves edit mode instead of risking a silent save", async () => {
    onRpc("crm.team", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.team", type: "list", arch: Team._views.list });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(0) [name='alias_full_name']").click();
    await contains(".o_field_widget[name='alias_full_name'] input").edit("mid-edit draft", {
        confirm: false,
    });
    expect(".o_field_widget[name='alias_full_name'] input").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_field_widget[name='alias_full_name'] input").toHaveCount(0);
    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(MockServer.env["crm.team"].find((r) => r.id === 1).alias_full_name).toBe("sales");

    await setOffline(false);
});

test.tags("desktop");
test("offline, dragging the inherited Sales Team list's handle does not resequence it; online it still does", async () => {
    onRpc("crm.team", "web_resequence", ({ parent }) => {
        expect.step("web_resequence");
        return parent();
    });
    await mountView({ resModel: "crm.team", type: "list", arch: Team._views.list });

    const namesBefore = queryAllTexts(".o_data_row [name='name']");
    expect(namesBefore).toEqual(["Sales Team", "Other Team"]);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_data_row:eq(0) .o_handle_cell").dragAndDrop(
        ".o_data_row:eq(1) .o_handle_cell"
    );
    expect(queryAllTexts(".o_data_row [name='name']")).toEqual(namesBefore);
    expect.verifySteps([]);

    await setOffline(false);

    await contains(".o_data_row:eq(0) .o_handle_cell").dragAndDrop(
        ".o_data_row:eq(1) .o_handle_cell"
    );
    expect.verifySteps(["web_resequence"]);
    expect(queryAllTexts(".o_data_row [name='name']")).not.toEqual(namesBefore);
});

// ---------------------------------------------------------------------------
// B60: Recurring Plans list handle drag inert offline (desktop-only, drag).
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, dragging the Recurring Plans list's handle does not resequence it; online it still does", async () => {
    onRpc("crm.recurring.plan", "web_resequence", ({ parent }) => {
        expect.step("web_resequence");
        return parent();
    });
    await mountView({
        resModel: "crm.recurring.plan",
        type: "list",
        arch: RecurringPlan._views.list,
    });

    const namesBefore = queryAllTexts(".o_data_row [name='name']");
    expect(namesBefore).toEqual(["Monthly", "Yearly"]);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_data_row:eq(0) .o_handle_cell").dragAndDrop(
        ".o_data_row:eq(1) .o_handle_cell"
    );
    expect(queryAllTexts(".o_data_row [name='name']")).toEqual(namesBefore);
    expect.verifySteps([]);

    await setOffline(false);
    await contains(".o_data_row:eq(0) .o_handle_cell").dragAndDrop(
        ".o_data_row:eq(1) .o_handle_cell"
    );
    expect.verifySteps(["web_resequence"]);
    expect(queryAllTexts(".o_data_row [name='name']")).not.toEqual(namesBefore);
});

// ---------------------------------------------------------------------------
// B60/B61: Recurring Plans and Lost Reasons lists are read-only offline --
// a cell click, or Enter on a focused cell, opens no editor and queues
// nothing. Both presets (no drag involved).
// ---------------------------------------------------------------------------

const READONLY_LIST_CASES = [
    { resModel: "crm.recurring.plan", label: "Recurring Plans", arch: RecurringPlan._views.list },
    { resModel: "crm.lost.reason", label: "Lost Reasons", arch: LostReason._views.list },
];

for (const { resModel, label, arch } of READONLY_LIST_CASES) {
    test(`offline, a cell click or Enter on the ${label} list opens no editor and queues nothing; online it still edits and saves`, async () => {
        onRpc(resModel, "web_save", ({ parent }) => {
            expect.step("web_save");
            return parent();
        });
        await mountView({ resModel, type: "list", arch });

        const setOffline = mockOffline();
        await setOffline(true);

        // Click: no editor opens.
        await contains(".o_data_row:eq(0) [name='name']").click();
        expect(".o_data_row.o_selected_row").toHaveCount(0); // not in edition
        expect(".o_field_widget[name='name'] input").toHaveCount(0);

        // Keyboard: Enter on the focused (but not entered) cell does the
        // same nothing.
        await contains(".o_data_row:eq(0) [name='name']").focus();
        await press("Enter");
        expect(".o_data_row.o_selected_row").toHaveCount(0); // not in edition
        expect(".o_field_widget[name='name'] input").toHaveCount(0);

        expect.verifySteps([]); // no web_save queued or sent
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(".o_notification").toHaveCount(0);

        await setOffline(false);

        // Back online, the same cell click enters edition and saves as
        // before.
        await contains(".o_data_row:eq(0) [name='name']").click();
        expect(".o_data_row:eq(0)").toHaveClass("o_selected_row"); // in edition (editable list, not checkbox-selected)
        await contains(".o_field_widget[name='name'] input").edit("Renamed");
        await contains(".o_list_renderer").click();
        expect.verifySteps(["web_save"]);
    });
}

// ---------------------------------------------------------------------------
// Finding 16 (scrutiny round 1, VAL-DIS-017): the New button must stay
// inert offline on these two models even after an online quick-create
// visit. `isNewButtonAvailableOffline` (`list_controller.js`) checks
// `isAvailableOffline(actionId, "list_quick_create", false)` for an
// `editable` list, and the framework marks that key available the first
// time a new row's blank onchange is loaded online
// (`relational_model.js`'s `_setAvailableOffline`, `isMonoRecord` config)
// -- with no per-model component, so this is true for *any* editable list
// on the action once visited. Without a crm-side override the New
// button's `data-available-offline` attribute would therefore read true
// offline too, both re-enabling the button (the framework's own
// `SELECTORS_TO_DISABLE` pass only disables buttons that *lack* the
// attribute) and leaving `onClickCreate`'s handler path unguarded.
//
// `{ visible: false }`: on a small screen, `web.ControlPanel` collapses
// `control-panel-buttons` into a "..." dropdown (`control_panel.xml`'s
// `dropdownifyButtons`), and the always-present copy outside that
// dropdown -- the one these buttons' fixed classes resolve to -- is only
// CSS-hidden there, not absent; `contains()`'s `visible: false` is the
// established way to still interact with it (`kanban_test_helpers.js`
// uses the same option for an analogous collapsed-under-mobile toggle).
// ---------------------------------------------------------------------------

for (const { resModel, label, arch } of READONLY_LIST_CASES) {
    test(`offline, the ${label} list's New button is inert even after an online quick-create visit; online it still creates and saves`, async () => {
        onRpc(resModel, "web_save", ({ parent }) => {
            expect.step("web_save");
            return parent();
        });
        await mountView({ resModel, type: "list", arch });

        // Prime `list_quick_create` as available offline the way a real
        // session would: click New online once and discard the resulting
        // blank row immediately, so no leftover row or queue entry from
        // this priming step has to be accounted for below.
        await contains(".o_list_button_add").click();
        expect(".o_selected_row").toHaveCount(1);
        await contains(".o_list_button_discard", { visible: false }).click();
        expect(".o_selected_row").toHaveCount(0);

        const setOffline = mockOffline();
        await setOffline(true);

        // The base getter's value is now true (primed above): without
        // this fix the button would stay enabled and reachable.
        expect(".o_list_button_add").toHaveProperty("disabled", true);
        await contains(".o_list_button_add").click();
        expect(".o_selected_row").toHaveCount(0); // no in-edit row entered
        expect(".o_data_row").toHaveCount(2); // still just the two seed rows
        expect.verifySteps([]); // no web_save sent or queued
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(".o_notification").toHaveCount(0);

        await setOffline(false);

        // Online, New still works and the row can be saved as before.
        expect(".o_list_button_add").toHaveProperty("disabled", false);
        await contains(".o_list_button_add").click();
        expect(".o_selected_row").toHaveCount(1);
        // `confirm: false`: the default "auto" confirm sends an Enter
        // keypress on `<input>` targets (hoot-dom's `edit()`), which on an
        // editable-bottom list commits this row *and* opens a second
        // blank one for continued typing -- the explicit Save click
        // below would then save that second (empty) row too, double-
        // counting `web_save`.
        await contains(".o_selected_row [name='name'] input").edit("Quarterly", {
            confirm: false,
        });
        await contains(".o_list_button_save", { visible: false }).click();
        expect.verifySteps(["web_save"]);
    });
}

// ---------------------------------------------------------------------------
// Finding 17 (VAL-DIS-017): a row already in create or edit on these two
// models when the connection drops must leave edition, discarding its
// changes, rather than risk `DynamicList.leaveEditMode`'s normal save path
// queuing a `web_save` on a model that must have nothing queued. Covers
// both an *existing* row mid cell-edit and a *brand-new* row started
// through New, both begun online.
// ---------------------------------------------------------------------------

for (const { resModel, label, arch } of READONLY_LIST_CASES) {
    test(`offline, an existing ${label} row already mid cell-edit when the connection drops leaves edit mode instead of risking a silent save`, async () => {
        onRpc(resModel, "web_save", () => expect.step("web_save"));
        await mountView({ resModel, type: "list", arch });

        // Online: open the row's cell editor (allowed online).
        await contains(".o_data_row:eq(0) [name='name']").click();
        await contains(".o_field_widget[name='name'] input").edit("mid-edit draft", {
            confirm: false, // keep the draft unsubmitted, like a user mid-keystroke
        });
        expect(".o_selected_row").toHaveCount(1);

        // The connection drops mid-edit: the row is forced out of edition
        // (discarding the in-progress draft, never saving it).
        const setOffline = mockOffline();
        await setOffline(true);

        expect(".o_selected_row").toHaveCount(0);
        expect.verifySteps([]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env[resModel].find((r) => r.id === 1).name).not.toBe("mid-edit draft");

        await setOffline(false);
    });

    test(`offline, a brand-new ${label} row started online (New, not yet saved) is discarded, not saved or queued, when the connection drops`, async () => {
        onRpc(resModel, "web_save", () => expect.step("web_save"));
        await mountView({ resModel, type: "list", arch });

        await contains(".o_list_button_add").click();
        expect(".o_selected_row").toHaveCount(1);
        await contains(".o_selected_row [name='name'] input").edit("Draft only", {
            confirm: false, // keep the draft unsubmitted, like a user mid-keystroke
        });

        const setOffline = mockOffline();
        await setOffline(true);

        expect(".o_selected_row").toHaveCount(0); // the new, unsaved row is gone, not kept dirty
        expect(".o_data_row").toHaveCount(2); // back to just the two seed rows
        expect.verifySteps([]);
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env[resModel].some((r) => r.name === "Draft only")).toBe(false);

        await setOffline(false);
    });
}

// ---------------------------------------------------------------------------
// B68: selected-record Action-menu Archive/Unarchive/Delete inert offline
// on the Recurring Plans and Lost Reasons lists; nothing is queued on
// either model. Desktop-only: selecting the row this action menu acts on
// needs the selector checkbox, which (`ListRenderer.hasSelectors`) never
// renders on mobile for any list, so the list-level Action-menu is not a
// mobile-reachable interaction at all, independently of this fix.
// ---------------------------------------------------------------------------

for (const { resModel, label, arch } of READONLY_LIST_CASES) {
    test.tags("desktop");
    test(`offline, the ${label} list's Action-menu Archive/Unarchive/Delete do nothing; online they work again`, async () => {
        onRpc(resModel, ["web_unlink", "action_archive", "action_unarchive"], ({ method }) => {
            expect.step(method);
        });
        await mountView({ resModel, type: "list", arch, actionMenus: {} });

        await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

        const setOffline = mockOffline();
        await setOffline(true);

        // The item is reachable (unlike a framework-disabled plain
        // `<button>`, the Actions dropdown toggler itself carries
        // `data-available-offline`), but it is marked `pe-none` by the
        // same mechanism the framework already uses for any item whose
        // `availableOffline` is false (`action_menus.xml`); the crm guard
        // flips that flag for these two out-of-scope models and replaces
        // the callback with a no-op, unlike B67/B69's crm.lead/crm.team
        // where the framework's own `availableOffline: true` is correct.
        // `{ interactive: false }` clicks the item node directly instead
        // of letting hoot climb to the nearest `:interactive` ancestor
        // (which a `pe-none` node is not) -- proving the no-op callback
        // itself runs, not just that the click never lands.
        await toggleActionMenu();
        expect(".o_menu_item:contains(Delete)").toHaveClass("pe-none");
        expect(".o_menu_item:contains(Archive)").toHaveClass("pe-none");
        await contains(".o_menu_item:contains(Delete)").click({ interactive: false });
        expect(".modal").toHaveCount(0); // no confirmation dialog even opened
        expect.verifySteps([]);

        await toggleActionMenu();
        await contains(".o_menu_item:contains(Archive)").click({ interactive: false });
        expect(".modal").toHaveCount(0);
        expect.verifySteps([]);

        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(".o_notification").toHaveCount(0);

        await setOffline(false);

        // Online: Delete still asks for confirmation (it works as before).
        await toggleActionMenu();
        expect(".o_menu_item:contains(Delete)").not.toHaveClass("pe-none");
        await toggleMenuItem("Delete");
        expect(".modal").toHaveCount(1);
        await contains(".modal-footer button.btn-danger").click();
        expect.verifySteps(["web_unlink"]);
    });
}

// ---------------------------------------------------------------------------
// B68 (user-testing evidence): the test above only re-proves Delete
// online; it never exercises Archive online, nor Unarchive at all (the
// menu item an *already archived* row offers instead of Archive). Online
// Archive first (so there is a genuinely archived row to Unarchive), then
// offline Unarchive on it does nothing either, same `pe-none` + no-op
// mechanism as Archive/Delete above; online it still works.
// `context: { active_test: false }` keeps the archived row visible in the
// list afterward (the mock server, like the real ORM, otherwise filters
// it out of `web_search_read`).
// ---------------------------------------------------------------------------

for (const { resModel, label, arch } of READONLY_LIST_CASES) {
    test.tags("desktop");
    test(`online, the ${label} list's Action-menu Archive still archives; offline Unarchive on that archived row does nothing; online Unarchive works again`, async () => {
        onRpc(resModel, ["action_archive", "action_unarchive"], ({ method, parent }) => {
            expect.step(method);
            return parent();
        });
        await mountView({
            resModel,
            type: "list",
            arch,
            actionMenus: {},
            context: { active_test: false },
        });

        // Online: Archive record 1 (the online guard this feature adds).
        await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
        await toggleActionMenu();
        await toggleMenuItem("Archive");
        expect(".modal").toHaveCount(1);
        await contains(".modal-footer .btn-primary").click();
        expect.verifySteps(["action_archive"]);
        expect(MockServer.env[resModel].find((r) => r.id === 1).active).toBe(false);

        const setOffline = mockOffline();
        await setOffline(true);

        // The now-archived row is still right there (`active_test: false`);
        // select it and try Unarchive.
        await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
        await toggleActionMenu();
        expect(".o_menu_item:contains(Unarchive)").toHaveClass("pe-none");
        await contains(".o_menu_item:contains(Unarchive)").click({ interactive: false });
        expect(".modal").toHaveCount(0); // no confirmation dialog (Unarchive never shows one, online either)
        expect.verifySteps([]); // no action_unarchive issued or queued
        expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
        expect(MockServer.env[resModel].find((r) => r.id === 1).active).toBe(false); // still archived
        expect(".o_notification").toHaveCount(0);

        await setOffline(false);

        // Online: Unarchive still works.
        await toggleActionMenu();
        expect(".o_menu_item:contains(Unarchive)").not.toHaveClass("pe-none");
        await toggleMenuItem("Unarchive");
        expect.verifySteps(["action_unarchive"]);
        expect(MockServer.env[resModel].find((r) => r.id === 1).active).toBe(true);
    });
}

// ---------------------------------------------------------------------------
// B48: the activity report list's row click issues no action_open_lead
// offline, by click or by keyboard. Both presets.
// ---------------------------------------------------------------------------

test("offline, a row click or Enter on the activity report list issues no action_open_lead; online it still does", async () => {
    onRpc("crm.activity.report", "action_open_lead", ({ args }) => {
        expect.step("action_open_lead");
        expect(args[0]).toEqual([1]);
        return false; // minimal action: ir.actions.act_window_close
    });
    await mountView({
        resModel: "crm.activity.report",
        type: "list",
        arch: `<list action="action_open_lead" type="object"><field name="name"/></list>`,
    });

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_data_row:eq(0) .o_data_cell").click();
    expect.verifySteps([]);

    await contains(".o_data_row:eq(0) .o_data_cell").focus();
    await press("Enter");
    expect.verifySteps([]);

    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
    await contains(".o_data_row:eq(0) .o_data_cell").click();
    expect.verifySteps(["action_open_lead"]);
});
