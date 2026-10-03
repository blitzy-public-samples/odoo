import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { hover, queryAllTexts, queryOne, runAllTimers } from "@odoo/hoot-dom";
import { mockDate } from "@odoo/hoot-mock";
import {
    contains,
    defineModels,
    fields,
    getKanbanColumn,
    getKanbanRecordTexts,
    mockOffline,
    models,
    mountView,
    onRpc,
    quickCreateKanbanColumn,
    toggleKanbanColumnActions,
} from "@web/../tests/web_test_helpers";

/**
 * Bucket F2 (architecture.md §3.7 / offline_inventory.md rows
 * B56-B58/B62/B71-73/B79/B80/B89/B91, A24/A27): every *group*-level control
 * of the CRM pipeline kanban (and the activity-report list, which shares
 * the same `GroupConfigMenu`) must be inert offline and fully restored
 * online, without poisoning anything that is memoized for later. None of
 * `name_create` (add a column), `web_unlink`/the edit dialog's `web_save`
 * (column config menu), or `web_resequence`/`web_read_group` (column drag,
 * rotting filter, forecast "add next period") is one of the framework's
 * four auto-queued producers (architecture.md §3.7), so every row here is
 * DISABLE, never queued.
 *
 * A dropdown already open *before* going offline is the one case the
 * framework's own `SELECTORS_TO_DISABLE` button-disable pass cannot catch
 * on its own, because `DropdownItem` renders as a `<span>`/`<a>`, not a
 * `<button>` (AGENTS.md §2's "Offline-availability attribute" section);
 * several tests below open a menu first and only go offline afterwards to
 * prove the handler-level guard also covers that case.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    kanban_state = fields.Selection({
        selection: [
            ["normal", "Normal"],
            ["done", "Ready"],
            ["blocked", "Blocked"],
        ],
    });
    expected_revenue = fields.Float();
    is_rotting = fields.Boolean();
    date_deadline = fields.Date({ string: "Expected Closing" });

    _records = [
        {
            id: 1,
            name: "Lead 1",
            stage_id: 1,
            team_id: 1,
            kanban_state: "normal",
            expected_revenue: 100,
            is_rotting: true,
        },
        {
            id: 2,
            name: "Lead 2",
            stage_id: 1,
            team_id: 1,
            kanban_state: "done",
            expected_revenue: 200,
            is_rotting: false,
        },
        {
            id: 3,
            name: "Lead 3",
            stage_id: 2,
            team_id: 1,
            kanban_state: "blocked",
            expected_revenue: 50,
            is_rotting: false,
        },
        {
            id: 4,
            name: "Lead 4",
            stage_id: 3,
            team_id: 2,
            kanban_state: "normal",
            expected_revenue: 10,
            is_rotting: false,
        },
    ];
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    sequence = fields.Integer({ default: 10 });

    _records = [
        { id: 1, name: "New", sequence: 1 },
        { id: 2, name: "Qualified", sequence: 2 },
        { id: 3, name: "Won", sequence: 3 },
    ];

    _views = {
        // Minimal, just enough for `editGroup()`'s FormViewDialog to open
        // online without erroring.
        form: `<form><field name="name"/></form>`,
    };
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [
        { id: 1, name: "Sales Team" },
        { id: 2, name: "Other Team" },
    ];

    // Minimal, just enough for `editGroup()`'s FormViewDialog to open
    // online without erroring (same idiom as `Stage._views.form` above).
    _views = {
        form: `<form><field name="name"/></form>`,
    };
}

// A standalone model, distinct from `crm.lead`, so the config-menu guard's
// scoping to crm's own resModels (B89) is actually exercised against a
// *second* model, not just re-proven on the same one.
class ActivityReport extends models.Model {
    _name = "crm.activity.report";

    name = fields.Char();
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });

    _records = [
        { id: 1, name: "Activity 1", team_id: 1 },
        { id: 2, name: "Activity 2", team_id: 2 },
    ];
}

defineModels([Lead, Stage, Team, ActivityReport]);
defineMailModels();

// The `group_by_tooltip` option on `stage_id` (crm_lead_views.xml:505) and
// an `is_rotting` field (crm_lead_views.xml) so the rotting badge renders.
const pipelineArch = `
    <kanban js_class="crm_kanban" default_group_by="stage_id">
        <field name="stage_id" options='{"group_by_tooltip": {"name": "Description"}}'/>
        <field name="is_rotting" invisible="1"/>
        <progressbar field="kanban_state" colors='{"done": "success", "blocked": "danger", "normal": "muted"}' sum_field="expected_revenue"/>
        <templates>
            <t t-name="card">
                <field name="name"/>
            </t>
        </templates>
    </kanban>`;

// ---------------------------------------------------------------------------
// B56 / VAL-DIS-015: "Add a column"
// ---------------------------------------------------------------------------

test("offline, the pipeline's \"Add a column\" area is hidden, including one already unfolded; online it works again", async () => {
    onRpc("crm.stage", "name_create", () => expect.step("name_create"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    expect(".o_column_quick_create").toHaveCount(1);
    // Unfold it and start typing *before* going offline. `{ confirm: false }`
    // matters here: `.edit()`'s default `confirm: "auto"` presses Enter on
    // an `<input>`, which would submit immediately through
    // `onInputKeydown` -- the opposite of what this is testing (an
    // *unsubmitted* draft lost to the remount).
    await quickCreateKanbanColumn();
    expect(".o_column_quick_create.o_quick_create_unfolded").toHaveCount(1);
    await contains(".o_column_quick_create input").edit("In progress", { confirm: false });

    const setOffline = mockOffline();
    await setOffline(true);

    // The whole area -- unfolded or not -- disappears: nothing is left to
    // submit, so `name_create` can never fire from it while offline.
    expect(".o_column_quick_create").toHaveCount(0);

    await setOffline(false);
    expect(".o_column_quick_create").toHaveCount(1);
    // The area remounts unfolded, not folded: `state.columnQuickCreateIsFolded`
    // lives on the renderer, which never unmounted, so it's unchanged by
    // the child's own unmount/remount -- only the typed text (the child's
    // own DOM) was actually lost.
    expect(".o_column_quick_create.o_quick_create_unfolded").toHaveCount(1);

    await contains(".o_column_quick_create input").edit("In progress", { confirm: false });
    await contains(".o_column_quick_create .o_kanban_add").click();
    expect.verifySteps(["name_create"]); // online, it still creates the column
    expect(".o_kanban_group:contains('In progress')").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// B58/B71/B73 / VAL-DIS-015/016: column drag resequence (desktop only --
// `KanbanRenderer.canUseSortable` is itself gated on `!uiService.isSmall`,
// so there is no mobile drag to disable in the first place)
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, dragging a pipeline column does not resequence it; online it still does", async () => {
    onRpc("crm.stage", "web_resequence", () => expect.step("web_resequence"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    const titlesBefore = queryAllTexts(".o_column_title");
    expect(titlesBefore.length).toBe(3);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_kanban_group:eq(0) .o_column_title").dragAndDrop(
        ".o_kanban_group:eq(1) .o_column_title"
    );
    expect(queryAllTexts(".o_column_title")).toEqual(titlesBefore); // unchanged
    expect.verifySteps([]); // no web_resequence

    await setOffline(false);
    await contains(".o_kanban_group:eq(0) .o_column_title").dragAndDrop(
        ".o_kanban_group:eq(1) .o_column_title"
    );
    expect(queryAllTexts(".o_column_title")).not.toEqual(titlesBefore); // changed
    expect.verifySteps(["web_resequence"]);
});

// Same mechanism, grouped by a non-stage many2one field (B71/B73): the
// `canResequenceGroups` override doesn't branch on which field the view is
// grouped by, so this proves the fix isn't accidentally stage-specific.
test.tags("desktop");
test("offline, dragging a pipeline column grouped by sales team does not resequence it either; online it still does", async () => {
    onRpc("crm.team", "web_resequence", () => expect.step("web_resequence"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["team_id"],
        arch: pipelineArch,
    });

    const titlesBefore = queryAllTexts(".o_column_title");
    expect(titlesBefore.length).toBe(2);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_kanban_group:eq(0) .o_column_title").dragAndDrop(
        ".o_kanban_group:eq(1) .o_column_title"
    );
    expect(queryAllTexts(".o_column_title")).toEqual(titlesBefore);
    expect.verifySteps([]);

    await setOffline(false);
    await contains(".o_kanban_group:eq(0) .o_column_title").dragAndDrop(
        ".o_kanban_group:eq(1) .o_column_title"
    );
    expect(queryAllTexts(".o_column_title")).not.toEqual(titlesBefore);
    expect.verifySteps(["web_resequence"]);
});

// B71-73 / VAL-DIS-016: the config toggler itself when grouped by a
// non-stage many2one -- `GroupConfigMenu`'s own guard
// (`group_config_menu_patch.js`) does not branch on which field the view
// is grouped by, same as the drag guard above, but this proves the
// *toggler* (the framework's own plain `<button>`, auto-disabled offline)
// rather than only the drag.
test("offline, the pipeline's column config toggler is disabled when grouped by sales team; online it opens the menu again", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["team_id"],
        arch: pipelineArch,
    });

    const toggler = ".o_kanban_group:eq(0) .o_group_config .dropdown-toggle";
    expect(toggler).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(toggler).toHaveAttribute("disabled");
    expect(toggler).toHaveClass("o_disabled_offline");

    await setOffline(false);
    expect(toggler).not.toHaveAttribute("disabled");
    // Same `{ visible: false }` as `toggleKanbanColumnActions` above: the
    // toggle's own icon button never satisfies hoot's strict visibility
    // heuristic, offline or not.
    await contains(toggler, { visible: false }).click();
    expect(".dropdown-item:contains('Edit')").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// B57/B62/B71-73 / VAL-DIS-015/016: the kanban column config menu
// ---------------------------------------------------------------------------

test("offline, a column config menu already open before going offline can't Edit; a fresh open is blocked too; online it works again", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    // Open column 0's menu *before* going offline, and leave it open.
    const clickMenuItem = await toggleKanbanColumnActions(0);
    expect(".dropdown-item:contains('Edit')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    // A fresh open elsewhere is blocked by the framework's own
    // button-disable pass (the toggler is a plain `<button>`).
    expect(".o_kanban_group:eq(1) .o_group_config .dropdown-toggle").toHaveAttribute("disabled");
    expect(".o_kanban_group:eq(1) .o_group_config .dropdown-toggle").toHaveClass(
        "o_disabled_offline"
    );

    // Column 0's menu was already open: its "Edit" is a `DropdownItem`
    // (not a `<button>`), so only the handler-level guard can stop it.
    await clickMenuItem("Edit");
    expect(".o_dialog").toHaveCount(0);
    expect(".o_form_view").toHaveCount(0);

    await setOffline(false);
    const clickMenuItemAgain = await toggleKanbanColumnActions(0);
    await clickMenuItemAgain("Edit");
    expect(".o_dialog .o_form_view").toHaveCount(1);
    // `.btn-close` only renders on a non-fullscreen dialog (web.Dialog.header);
    // on mobile the dialog is fullscreen and shows a back arrow instead, but
    // both share `aria-label="Close"`, so target that to close either way.
    await contains(".o_dialog header button[aria-label='Close']").click();
});

test("offline, a column config menu already open before going offline can't Delete either; online it still asks to delete", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    const clickMenuItem = await toggleKanbanColumnActions(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await clickMenuItem("Delete");
    expect(".o_dialog").toHaveCount(0); // no confirmation dialog opened
    expect(getKanbanColumn(1)).not.toBe(undefined); // the column is still there

    await setOffline(false);
    const clickMenuItemAgain = await toggleKanbanColumnActions(1);
    await clickMenuItemAgain("Delete");
    expect(".o_dialog .modal-body:contains('delete this column')").toHaveCount(1);
    await contains(".o_dialog footer button:contains(Discard)").click();
});

// B57 (scrutiny finding 12): the guard above only runs when "Delete" is
// selected. If the connection drops *after* that confirmation dialog is
// already open -- "Delete" clicked while still online -- its "Delete"
// button carries `data-available-offline` and stays clickable; its
// `confirm` callback is a closure created when the dialog was added, so a
// guard only at `deleteGroup()`'s own entry (already past by then) cannot
// stop it. `group_config_menu_patch.js` re-checks offline inside that
// closure too.
test("offline, a delete confirmation opened online does nothing if confirmed after going offline; online it still deletes", async () => {
    onRpc("crm.stage", "unlink", () => expect.step("unlink"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    const clickMenuItem = await toggleKanbanColumnActions(1);
    await clickMenuItem("Delete"); // online: opens the confirmation dialog
    expect(".o_dialog .modal-body:contains('delete this column')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_dialog footer button:contains(Delete)").click();
    expect.verifySteps([]); // no unlink issued or queued
    expect(getKanbanColumn(1)).not.toBe(undefined); // the column is still there

    await setOffline(false);
    const clickMenuItemAgain = await toggleKanbanColumnActions(1);
    await clickMenuItemAgain("Delete");
    expect(".o_dialog .modal-body:contains('delete this column')").toHaveCount(1);
    await contains(".o_dialog footer button:contains(Delete)").click();
    expect.verifySteps(["unlink"]); // online, the same button still deletes
});

// ---------------------------------------------------------------------------
// B89 / VAL-DIS-016: the same `GroupConfigMenu`, used by a *list* grouped by
// a many2one, scoped to `crm.activity.report` as well as `crm.lead`
// ---------------------------------------------------------------------------

test("offline, the activity-report list's column config menu is inert if left open; online it works again", async () => {
    await mountView({
        type: "list",
        resModel: "crm.activity.report",
        groupBy: ["team_id"],
        arch: `<list><field name="name"/></list>`,
    });

    await contains(".o_group_header:eq(0) .o_group_config .dropdown-toggle", {
        visible: false,
    }).click();
    expect(".dropdown-item:contains('Delete')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_group_header:eq(1) .o_group_config .dropdown-toggle").toHaveAttribute("disabled");

    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog").toHaveCount(0);

    await setOffline(false);
    await contains(".o_group_header:eq(0) .o_group_config .dropdown-toggle", {
        visible: false,
    }).click();
    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog .modal-body:contains('delete this column')").toHaveCount(1);
    await contains(".o_dialog footer button:contains(Discard)").click();
});

// B89 / VAL-DIS-016: same list, same menu, the "Edit" item left open
// instead of "Delete" -- `editGroup()` opens a `FormViewDialog` on the
// group's own `crm.team` record (`group_config_menu_patch.js`'s
// `isCrmView` guard also scopes `crm.activity.report`).
test("offline, the activity-report list's column config menu can't Edit if left open; online it works again", async () => {
    await mountView({
        type: "list",
        resModel: "crm.activity.report",
        groupBy: ["team_id"],
        arch: `<list><field name="name"/></list>`,
    });

    await contains(".o_group_header:eq(0) .o_group_config .dropdown-toggle", {
        visible: false,
    }).click();
    expect(".dropdown-item:contains('Edit')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".dropdown-item:contains('Edit')").click();
    expect(".o_dialog").toHaveCount(0); // unreachable: no FormViewDialog opened

    await setOffline(false);
    await contains(".o_group_header:eq(0) .o_group_config .dropdown-toggle", {
        visible: false,
    }).click();
    await contains(".dropdown-item:contains('Edit')").click();
    expect(".o_dialog .o_form_view").toHaveCount(1);
    await contains(".o_dialog header button[aria-label='Close']").click();
});

// ---------------------------------------------------------------------------
// B79/B91 / VAL-DIS-029: the progress bar segment and the rotting badge
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, the progress bar is marked inert and the rotting badge is inert; online both work again", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    expect(".o_kanban_group:eq(0) .o_column_progress").not.toHaveClass("pe-none");
    expect(getKanbanRecordTexts(0).length).toBe(2);

    // VAL-DIS-029 (user-testing round 2 evidence): count the reload RPCs
    // the click itself triggers -- `group.applyFilter()`'s `list.load()`
    // issues one of these two methods, never one of the framework's four
    // auto-queued producers -- rather than only inferring "no reload"
    // from the unchanged record count.
    let reloadCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        reloadCount++;
        return parent();
    });

    const setOffline = mockOffline();
    await setOffline(true);

    // B79: `web.ColumnProgress`'s own template already applies this class
    // offline -- the mechanism itself is generic and already proven
    // (kanban_column_progressbar.test.js); this only checks that crm's
    // `ColumnProgress` subclass still has the same wrapper div.
    expect(".o_kanban_group:eq(0) .o_column_progress").toHaveClass("pe-none");

    // B91: the rotting badge is a sibling of that wrapper, not a child of
    // it (crm_column_progress.xml), and it's a plain `<div>`, not a
    // `<button>` -- without the crm guard it would stay fully clickable.
    expect(".o_kanban_group:eq(0) .badge.rounded-pill.text-bg-danger").toHaveCount(1);
    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .badge.rounded-pill.text-bg-danger").click();
    expect(getKanbanRecordTexts(0).length).toBe(2); // unchanged: the rotting filter never applied
    expect(reloadCount).toBe(0); // the click issued no web_read_group/web_search_read offline

    await setOffline(false);
    expect(".o_kanban_group:eq(0) .o_column_progress").not.toHaveClass("pe-none");
    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .badge.rounded-pill.text-bg-danger").click();
    expect(getKanbanRecordTexts(0).length).toBe(1); // now filtered to the single rotting record
    expect(reloadCount).toBeGreaterThan(0); // online, the same click reloads the column
});

// B79 (scrutiny finding 14): the `pe-none` class above only blocks a real
// pointer hit test; it does not guard the handler itself.
// `contains(...).click()` dispatches the click event directly on the
// target segment, the same way a direct call to the handler would, so
// this proves `CrmKanbanHeader.onBarClicked`'s own guard, not just the
// generic wrapper CSS the previous test already covers.
test.tags("desktop");
test("offline, clicking a progress bar segment directly applies no filter; online it still does", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    expect(getKanbanRecordTexts(0).length).toBe(2);

    // VAL-DIS-029: same click-scoped reload count as the test above.
    let reloadCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        reloadCount++;
        return parent();
    });

    const setOffline = mockOffline();
    await setOffline(true);

    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .progress-bar.o_bar_has_records").click();
    expect(getKanbanRecordTexts(0).length).toBe(2); // unchanged: no filter applied, no reload
    expect(reloadCount).toBe(0);

    await setOffline(false);
    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .progress-bar.o_bar_has_records").click();
    expect(getKanbanRecordTexts(0).length).toBe(1); // now filtered
    expect(reloadCount).toBeGreaterThan(0);
});

// VAL-DIS-029 (user-testing evidence): mobile-tagged copies of the two
// tests above. Both guards are DOM-class/handler-level, independent of
// viewport size, so the same clicks and assertions apply unchanged under
// the mobile preset.
test.tags("mobile");
test("offline, the progress bar is marked inert and the rotting badge is inert; online both work again (mobile)", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    expect(".o_kanban_group:eq(0) .o_column_progress").not.toHaveClass("pe-none");
    expect(getKanbanRecordTexts(0).length).toBe(2);

    // VAL-DIS-029 (user-testing round 2 evidence): same click-scoped
    // reload count as the desktop test above.
    let reloadCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        reloadCount++;
        return parent();
    });

    const setOffline = mockOffline();
    await setOffline(true);

    expect(".o_kanban_group:eq(0) .o_column_progress").toHaveClass("pe-none");

    expect(".o_kanban_group:eq(0) .badge.rounded-pill.text-bg-danger").toHaveCount(1);
    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .badge.rounded-pill.text-bg-danger").click();
    expect(getKanbanRecordTexts(0).length).toBe(2); // unchanged: the rotting filter never applied
    expect(reloadCount).toBe(0); // the click issued no web_read_group/web_search_read offline

    await setOffline(false);
    expect(".o_kanban_group:eq(0) .o_column_progress").not.toHaveClass("pe-none");
    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .badge.rounded-pill.text-bg-danger").click();
    expect(getKanbanRecordTexts(0).length).toBe(1); // now filtered to the single rotting record
    expect(reloadCount).toBeGreaterThan(0); // online, the same click reloads the column
});

test.tags("mobile");
test("offline, clicking a progress bar segment directly applies no filter; online it still does (mobile)", async () => {
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    expect(getKanbanRecordTexts(0).length).toBe(2);

    // VAL-DIS-029: same click-scoped reload count as the desktop test above.
    let reloadCount = 0;
    onRpc(["web_read_group", "web_search_read"], ({ parent }) => {
        reloadCount++;
        return parent();
    });

    const setOffline = mockOffline();
    await setOffline(true);

    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .progress-bar.o_bar_has_records").click();
    expect(getKanbanRecordTexts(0).length).toBe(2); // unchanged: no filter applied, no reload
    expect(reloadCount).toBe(0);

    await setOffline(false);
    reloadCount = 0;
    await contains(".o_kanban_group:eq(0) .progress-bar.o_bar_has_records").click();
    expect(getKanbanRecordTexts(0).length).toBe(1); // now filtered
    expect(reloadCount).toBeGreaterThan(0);
});

// ---------------------------------------------------------------------------
// B80 / VAL-SKIP-004: the stage header hover tooltip
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, hovering a column title skips the tooltip without poisoning its memo; online it still shows", async () => {
    onRpc("crm.stage", "read", () => expect.step("read"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    const setOffline = mockOffline();
    await setOffline(true);

    await hover(".o_column_title:eq(0)");
    await runAllTimers();
    expect(".o-tooltip").toHaveCount(0);
    expect.verifySteps([]); // `loadTooltip`'s memoized body was never invoked

    await setOffline(false);
    // Hover away first: hoot's `hover()` only (re-)dispatches `mouseenter`
    // when the pointer target actually changes, so re-hovering the exact
    // same title a second time needs a different target in between.
    await hover(".o_kanban_renderer");
    await hover(".o_column_title:eq(0)");
    await runAllTimers();
    expect(".o-tooltip").toHaveCount(1); // the memo wasn't poisoned by the offline attempt
    expect(".o-tooltip").toHaveText("Description\nNew");
    expect.verifySteps(["read"]);
});

// VAL-SKIP-004 (user-testing evidence): mobile-tagged copy. Touch screens
// have no hover state at all, so there is no mouse-driven tooltip to open
// in the first place on mobile, online or offline -- this is a platform
// fact, not an offline-specific behavior. What *is* offline-specific and
// worth proving here is that a tap on the title -- the touch equivalent
// interaction -- triggers no `read` RPC while offline either, so the skip
// proof still holds on this preset even though the tooltip itself never
// renders from a tap on any preset.
test.tags("mobile");
test("offline, tapping a column title issues no tooltip read; online a tap alone still issues none either (mobile)", async () => {
    onRpc("crm.stage", "read", () => expect.step("read"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(".o_column_title:eq(0)").click();
    await runAllTimers();
    expect(".o-tooltip").toHaveCount(0);
    expect.verifySteps([]); // no read while offline

    await setOffline(false);
    await contains(".o_column_title:eq(0)").click();
    await runAllTimers();
    expect(".o-tooltip").toHaveCount(0); // a tap, unlike a real hover, never opens it on any preset
    expect.verifySteps([]); // so no read is issued online from a tap either -- confirms the offline
    // assertion above is a genuine "skipped", not merely "the tooltip
    // never fires from this interaction regardless of connectivity"
});

// VAL-SKIP-004 (user-testing round 2 evidence): the tap test above proves
// the "skipped" claim for mobile's own real interaction, but it never
// exercises `onTitleMouseEnter` at all (a tap dispatches `click`, not
// `mouseenter`), so it can't show the memo recovers once the browser is
// back online. `CrmKanbanHeader.onTitleMouseEnter`'s guard has no device
// check (`crm_kanban_renderer.js`): the handler is bound with a plain
// `t-on-mouseenter` regardless of screen size (`kanban_header.xml`), it's
// hoot-dom's own `hover()` helper that, under the mobile preset's touch
// emulation, mirrors a real touchscreen and never fires `mouseenter` at
// all -- consistent with the tap test above never seeing a tooltip
// either. Dispatching the `mouseenter`/`mouseleave` events directly is
// the only way to reach that branch under the mobile preset, so this test
// synthesizes them instead of going through `hover()`.
test.tags("mobile");
test("offline, hovering a column title skips the tooltip without poisoning its memo; online it still shows (mobile)", async () => {
    onRpc("crm.stage", "read", () => expect.step("read"));
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        groupBy: ["stage_id"],
        arch: pipelineArch,
    });

    const setOffline = mockOffline();
    await setOffline(true);

    queryOne(".o_column_title:eq(0)").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await runAllTimers(); // past the 400ms debounce
    expect(".o-tooltip").toHaveCount(0);
    expect.verifySteps([]); // no read while offline, and no error

    await setOffline(false);
    // Same reason as the desktop hover test above: leave first so the
    // debounced handler sees a fresh enter, not a no-op repeat.
    queryOne(".o_column_title:eq(0)").dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    queryOne(".o_column_title:eq(0)").dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await runAllTimers();
    expect(".o-tooltip").toHaveCount(1); // the offline attempt didn't poison the memo
    expect(".o-tooltip").toHaveText("Description\nNew");
    expect.verifySteps(["read"]); // exactly one read, issued only once back online
});

// ---------------------------------------------------------------------------
// A24/A27 / VAL-DIS-013: the forecast kanban
// ---------------------------------------------------------------------------

const forecastArch = `
    <kanban js_class="forecast_kanban" default_group_by="date_deadline">
        <templates>
            <t t-name="card">
                <field name="name"/>
            </t>
        </templates>
    </kanban>`;

test.tags("desktop");
test("online, \"add next period\" reloads the forecast kanban with a wider window; offline it is not offered", async () => {
    mockDate("2024-05-15 00:00:00");
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: forecastArch,
        context: { forecast_field: "date_deadline" },
        groupBy: ["date_deadline"],
    });

    expect(".o_column_quick_create").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);
    expect(".o_column_quick_create").toHaveCount(0); // A27: not offered offline

    await setOffline(false);
    expect(".o_column_quick_create").toHaveCount(1); // back online

    onRpc("crm.lead", "web_read_group", () => expect.step("web_read_group"));
    await quickCreateKanbanColumn();
    await runAllTimers();
    expect.verifySteps(["web_read_group"]); // addForecastColumn() genuinely reloads with the expanded window
});

test.tags("desktop");
test("a connection lost while loading the forecast board shows the generic offline helper safely", async () => {
    mockDate("2024-05-15 00:00:00");
    // Forces the board's *first* `web_read_group` to lose the connection,
    // decoupled from `mockOffline()` -- the same way
    // crm_offline_team_switcher.test.js's "a connection lost while
    // fetching the team switcher data..." test does -- because
    // `relational_model.js`'s `load()` sets `couldNotLoadRootOffline` (and
    // the kanban controller renders `OfflineActionHelper` for it,
    // kanban_controller.xml) for *any* `ConnectionLostError` on the root
    // read, not only ones caused by a real disconnect. A real "never
    // visited this exact search state before" offline is not reachable
    // through the UI once *anything* has been cached: the search bar
    // menu's own toggler is a plain `<button>` with no
    // `data-available-offline` (disabled offline by the framework on its
    // own); its offline replacement
    // (addons/web/static/src/search/search_bar/offline_search_bar.js) can
    // only *select* previously-visited searches, never request a new one;
    // the view-switcher buttons are gated the same way
    // (control_panel.xml's `data-available-offline="this.isViewAvailable(view)"`,
    // proven disabled-for-an-unvisited-view-type in
    // window_action.test.js's own "[Offline] navigate through window
    // actions" assertions); and revisiting the same action id with a
    // *different* `additionalContext`
    // also changes `/web/action/load`'s own cache key
    // (`action_plugin.js`'s `_loadAction`), aborting the whole action back
    // to whatever was mounted before it ever reaches the kanban's own
    // read (window_action.test.js's "[Offline] execute unavailable
    // action") -- so forcing the RPC directly is the only way to exercise
    // this safety net at all (KNOWN-LIMIT: out of crm's kanban/header
    // guards' scope either way, since none of those gates belong to crm,
    // and AGENTS.md §4 forbids a parallel offline stack to work around
    // them).
    onRpc("crm.lead", "web_read_group", () => new Response("", { status: 502 }));
    expect.errors(1);
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: forecastArch,
        context: { forecast_field: "date_deadline" },
        groupBy: ["date_deadline"],
    });

    expect(".o_kanban_renderer").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(1); // A24: the generic OfflineActionHelper, not a crash
    expect(".o_notification").toHaveCount(0);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established or was interrupted`,
    ]);
});

// VAL-DIS-013 (user-testing evidence): mobile-tagged copies of both
// forecast tests above. Neither guard is desktop-specific
// (`.o_column_quick_create` not being offered offline, and the generic
// `OfflineActionHelper` on a root connection loss, are both plain DOM/data
// conditions), so the same scenarios and assertions apply unchanged under
// the mobile preset.
test.tags("mobile");
test('online, "add next period" reloads the forecast kanban with a wider window; offline it is not offered (mobile)', async () => {
    mockDate("2024-05-15 00:00:00");
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: forecastArch,
        context: { forecast_field: "date_deadline" },
        groupBy: ["date_deadline"],
    });

    expect(".o_column_quick_create").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);
    expect(".o_column_quick_create").toHaveCount(0); // A27: not offered offline

    await setOffline(false);
    expect(".o_column_quick_create").toHaveCount(1); // back online

    onRpc("crm.lead", "web_read_group", () => expect.step("web_read_group"));
    await quickCreateKanbanColumn();
    await runAllTimers();
    expect.verifySteps(["web_read_group"]); // addForecastColumn() genuinely reloads with the expanded window
});

test.tags("mobile");
test("a connection lost while loading the forecast board shows the generic offline helper safely (mobile)", async () => {
    mockDate("2024-05-15 00:00:00");
    onRpc("crm.lead", "web_read_group", () => new Response("", { status: 502 }));
    expect.errors(1);
    await mountView({
        type: "kanban",
        resModel: "crm.lead",
        arch: forecastArch,
        context: { forecast_field: "date_deadline" },
        groupBy: ["date_deadline"],
    });

    expect(".o_kanban_renderer").toHaveCount(0);
    expect(".o_view_nocontent").toHaveCount(1); // A24: the generic OfflineActionHelper, not a crash
    expect(".o_view_nocontent:contains('There is no data to display offline for the given filters')").toHaveCount(1);
    expect(".o_error_dialog").toHaveCount(0); // no error dialog, only the declared connection error
    expect(".o_notification").toHaveCount(0);
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/crm.lead/web_read_group" couldn't be established or was interrupted`,
    ]);
});
