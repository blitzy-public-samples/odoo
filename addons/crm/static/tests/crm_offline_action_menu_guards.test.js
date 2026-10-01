import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { animationFrame, expect, test } from "@odoo/hoot";
import { queryOne } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    fields,
    mockOffline,
    mockService,
    models,
    mountView,
    onRpc,
    toggleActionMenu,
} from "@web/../tests/web_test_helpers";

/**
 * m2-action-menu-guards (VAL-DIS-018, VAL-DIS-024). architecture.md §3.7's
 * "`<a>`/`DropdownItem`/drag triggers are not disabled by the framework;
 * every DISABLE row reached through one must be disabled by crm" and the
 * orchestrator note from m2-kanban-group-guards: a `DropdownItem` renders
 * as a `<span>`/`<a role="menuitem">`, never a `<button>`, so the
 * framework's offline button-disable pass only ever blocks a *fresh* open
 * of the dropdown toggler (a real `<button>`); a menu already open before
 * going offline needs a handler-level `isOffline()` guard
 * (`action_menus_patch.js`, same pattern as `group_config_menu_patch.js`).
 * Every test below opens its menu *before* going offline to exercise that
 * exact case, then also checks a fresh open.
 *
 * Rows: B66/C23 (Duplicate), B84 (binding-model openers), B83 (Edit
 * Properties), B70 (select-all-domain and ops on an already-selected
 * domain).
 *
 * `action_menus.xml`/`cog_menu.xml` already add `pe-none` to any item
 * lacking `availableOffline` while offline, which makes it un-clickable by
 * a *real* pointer (hoot's `contains(...).click()` faithfully refuses to
 * interact with a `pointer-events: none` node, exactly like a real mouse
 * would). That already proves the mouse path for those items; what it
 * can't prove is the keyboard path, since `Navigator.select()` calls
 * `target.click()` directly, bypassing `pointer-events` entirely. Every
 * offline click on a dimmed item below therefore uses `queryOne(...).click()`
 * (a direct, unmediated DOM click, exactly what `Navigator.select()` does)
 * instead of `contains(...).click()`, to exercise that bypass. Items this
 * feature exempts (`archive`/`unarchive`/`delete`) are never dimmed, so
 * their offline clicks keep using `contains(...).click()` like any other
 * still-enabled control.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    lead_properties = fields.Properties({
        string: "Properties",
        definition_record: "team_id",
        definition_record_field: "lead_properties_definition",
    });

    _records = [
        { id: 1, name: "Lead 1", team_id: 1, lead_properties: {} },
        { id: 2, name: "Lead 2", team_id: 1, lead_properties: {} },
        { id: 3, name: "Lead 3", team_id: 1, lead_properties: {} },
    ];

    _views = {
        // `team_id` must be in the arch (even hidden) so its relational
        // data is actually loaded: the Properties field's
        // `definitionRecordId` getter reads `record.data.team_id.id`.
        form: `<form><field name="name"/><field name="team_id" invisible="1"/><field name="lead_properties" columns="2"/></form>`,
        list: `<list limit="2"><field name="name"/></list>`,
    };
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    lead_properties_definition = fields.PropertiesDefinition();

    _records = [{ id: 1, name: "Sales Team", lead_properties_definition: [] }];
}

// A second, distinct crm model: proves the guard dispatches on resModel,
// not on a single hardcoded view.
class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();

    _records = [{ id: 1, name: "New" }];
}

// Not one of the crm-scoped models: proves "other apps unaffected".
class OtherModel extends models.Model {
    _name = "other.model";

    name = fields.Char();

    _records = [{ id: 1, name: "Other record" }];
}

defineModels([Lead, Team, Stage, OtherModel]);
defineMailModels();

/**
 * Reopens the (only) action/cog menu toggler. `DropdownItem.onClick`
 * always closes the whole dropdown chain itself (`dropdown_item.js`'s
 * `closingMode` defaults to "all"), independently of whatever `onSelected`
 * does -- so by the time this runs, the previous menu is already closed.
 */
async function reopenActionMenu() {
    await toggleActionMenu();
}

// ---------------------------------------------------------------------------
// B66/C23 / VAL-DIS-018: Duplicate
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, Duplicate on the lead form does nothing from a menu opened before going offline, nor from a fresh open; online it still duplicates (${preset})`, async () => {
        onRpc("crm.lead", "copy", ({ parent }) => {
            expect.step("copy");
            return parent(); // the mock server's own duplicate-record behavior
        });
        // Unrelated to this test: the duplicated record's Properties field
        // probes write access on load; only the "Edit Properties" test
        // below actually cares about that RPC.
        onRpc("has_access", () => true);
        await mountView({
            type: "form",
            resModel: "crm.lead",
            resId: 1,
            arch: Lead._views.form,
            actionMenus: {},
        });

        // Open the cog menu *before* going offline, and leave it open.
        await toggleActionMenu();
        expect(".dropdown-item:contains('Duplicate')").toHaveCount(1);

        const setOffline = mockOffline();
        await setOffline(true);

        // The framework's own CSS already blocks a real pointer click.
        expect(".dropdown-item:contains('Duplicate')").toHaveClass("pe-none");

        // The keyboard path (`Navigator.select()`'s direct `target.click()`)
        // bypasses that CSS -- only the handler-level guard stops it.
        queryOne(".dropdown-item:contains('Duplicate')").click();
        await animationFrame();
        expect.verifySteps([]); // no copy issued or queued
        expect(".o_dialog").toHaveCount(0);

        // A fresh open offline is blocked the same way.
        await reopenActionMenu();
        queryOne(".dropdown-item:contains('Duplicate')").click();
        await animationFrame();
        expect.verifySteps([]);

        await setOffline(false);
        await reopenActionMenu();
        await contains(".dropdown-item:contains('Duplicate')").click();
        expect.verifySteps(["copy"]); // online, it duplicates as before
    });
}

// List row selectors (`.o_list_record_selector`) only render when
// `!this.uiService.isSmall` (`list_renderer.js`); on mobile there is no
// multi-select, so the bulk action menu these tests drive doesn't exist
// there either -- desktop-only, like `crm_offline_list_celledit_disable.test.js`.
test.tags("desktop");
test("offline, Duplicate on the Leads list does nothing (no copy, so copy_data is never reached either); online it still duplicates", async () => {
    onRpc("crm.lead", "copy", ({ parent }) => {
        expect.step("copy");
        return parent();
    });
    await mountView({
        type: "list",
        resModel: "crm.lead",
        arch: Lead._views.list,
        actionMenus: {},
    });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

    const setOffline = mockOffline();
    await setOffline(true);

    await toggleActionMenu();
    expect(".dropdown-item:contains('Duplicate')").toHaveClass("pe-none");
    queryOne(".dropdown-item:contains('Duplicate')").click();
    await animationFrame();
    expect.verifySteps([]); // C23: copy() never called, so copy_data is unreachable too

    await setOffline(false);
    await reopenActionMenu();
    await contains(".dropdown-item:contains('Duplicate')").click();
    expect.verifySteps(["copy"]);
});

test.tags("desktop");
test("offline, Duplicate is also inert on the Stages list -- the guard dispatches by model, not only on crm.lead; online it still duplicates", async () => {
    onRpc("crm.stage", "copy", ({ parent }) => {
        expect.step("copy");
        return parent();
    });
    await mountView({
        type: "list",
        resModel: "crm.stage",
        arch: `<list><field name="name"/></list>`,
        actionMenus: {},
    });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

    const setOffline = mockOffline();
    await setOffline(true);

    await toggleActionMenu();
    queryOne(".dropdown-item:contains('Duplicate')").click();
    await animationFrame();
    expect.verifySteps([]);

    await setOffline(false);
    await reopenActionMenu();
    await contains(".dropdown-item:contains('Duplicate')").click();
    expect.verifySteps(["copy"]);
});

// ---------------------------------------------------------------------------
// B84 / VAL-DIS-018: binding-model Action-menu openers (mass mail,
// followers, merge/Lost wizards -- none has a `callback`, only an `action`
// to `doAction`, so none ever carries `availableOffline`)
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, a binding-model item on the lead form issues no doAction from a menu opened before going offline, nor from a fresh open; online it still opens (${preset})`, async () => {
        let doActionCalls = 0;
        mockService("action", {
            doAction(id) {
                doActionCalls++;
                expect(id).toBe(42);
            },
        });
        // Unrelated to this test: see the Duplicate test above.
        onRpc("has_access", () => true);
        await mountView({
            type: "form",
            resModel: "crm.lead",
            resId: 1,
            arch: Lead._views.form,
            actionMenus: { action: [{ id: 42, name: "Send Email" }] },
        });

        await toggleActionMenu();
        expect(".dropdown-item:contains('Send Email')").toHaveCount(1);

        const setOffline = mockOffline();
        await setOffline(true);

        expect(".dropdown-item:contains('Send Email')").toHaveClass("pe-none");
        queryOne(".dropdown-item:contains('Send Email')").click();
        await animationFrame();
        expect(doActionCalls).toBe(0);

        await reopenActionMenu();
        queryOne(".dropdown-item:contains('Send Email')").click();
        await animationFrame();
        expect(doActionCalls).toBe(0);

        await setOffline(false);
        await reopenActionMenu();
        await contains(".dropdown-item:contains('Send Email')").click();
        expect(doActionCalls).toBe(1); // online, it opens as before
    });
}

// ---------------------------------------------------------------------------
// B83 / VAL-DIS-024: the Properties field's "Edit Properties" cog item
// ---------------------------------------------------------------------------

for (const preset of ["desktop", "mobile"]) {
    test.tags(preset);
    test(`offline, "Edit Properties" on the lead form issues no access probe from a menu opened before going offline, nor from a fresh open; online it still works (${preset})`, async () => {
        onRpc("has_access", () => {
            expect.step("has_access"); // checkDefinitionWriteAccess()'s underlying RPC
            return true;
        });
        await mountView({
            type: "form",
            resModel: "crm.lead",
            resId: 1,
            arch: Lead._views.form,
            actionMenus: {},
        });

        await toggleActionMenu();
        expect(".dropdown-item:contains('Edit Properties')").toHaveCount(1);

        const setOffline = mockOffline();
        await setOffline(true);

        expect(".dropdown-item:contains('Edit Properties')").toHaveClass("pe-none");
        queryOne(".dropdown-item:contains('Edit Properties')").click();
        await animationFrame();
        expect.verifySteps([]); // no has_access probe
        expect(".o_field_property_open_popover").toHaveCount(0); // edit mode never entered

        await reopenActionMenu();
        queryOne(".dropdown-item:contains('Edit Properties')").click();
        await animationFrame();
        expect.verifySteps([]);

        await setOffline(false);
        await reopenActionMenu();
        await contains(".dropdown-item:contains('Edit Properties')").click();
        expect.verifySteps(["has_access"]); // online, the probe runs as before
    });
}

// ---------------------------------------------------------------------------
// B70 / VAL-DIS-018: select-all-domain and operations on an
// already-selected domain
// ---------------------------------------------------------------------------

// Same mobile exception as above: no row selectors, no bulk action menu,
// no "Select all" button at all on mobile.
test.tags("desktop");
test("offline, the \"Select all N records\" button is disabled (the framework's own button-disable pass, no crm code); online it still selects the domain", async () => {
    await mountView({
        type: "list",
        resModel: "crm.lead",
        arch: Lead._views.list,
        actionMenus: {},
    });

    // Select the full page (2 of 3 records: the arch's limit="2") so
    // `SelectionBox` offers "Select all 3".
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    expect(".o_select_domain").toHaveCount(1);
    expect(".o_select_domain").not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    // A real `<button>` without `data-available-offline`: the framework's
    // own disable pass already handles it, offline or online, with no crm
    // code -- a disabled button fires no click, real or programmatic, so
    // there is nothing further to prove by attempting one here.
    expect(".o_select_domain").toHaveAttribute("disabled");
    expect(".o_select_domain").toHaveClass("o_disabled_offline");

    await setOffline(false);
    expect(".o_select_domain").not.toHaveAttribute("disabled");
    await contains(".o_select_domain").click();
    expect(".list-group-item:contains('All')").toHaveCount(1); // online, it still works
});

test.tags("desktop");
test("offline, action-menu Delete on a domain selected before going offline issues no search and no web_unlink; online it still resolves the domain and deletes", async () => {
    onRpc("crm.lead", "search", () => expect.step("search"));
    onRpc("crm.lead", "web_unlink", ({ parent }) => {
        expect.step("web_unlink");
        return parent();
    });
    await mountView({
        type: "list",
        resModel: "crm.lead",
        arch: Lead._views.list,
        actionMenus: {},
    });

    // Select the domain *before* going offline, exactly like the
    // scenario this row covers.
    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
    await contains(".o_data_row:eq(1) .o_list_record_selector input").click();
    await contains(".o_select_domain").click();
    expect(".list-group-item:contains('All')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    // Delete is one of this feature's exemptions (`availableOffline: true`
    // on list_controller.js), so it is never dimmed -- a real click reaches
    // the handler, where the domain-selected check blocks it on its own.
    await toggleActionMenu();
    expect(".dropdown-item:contains('Delete')").not.toHaveClass("pe-none");
    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog").toHaveCount(0); // no confirmation dialog opened
    expect.verifySteps([]); // no search, no web_unlink

    await setOffline(false);
    await reopenActionMenu();
    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog").toHaveCount(1);
    await contains(".modal-footer button.btn-danger").click();
    expect.verifySteps(["search", "web_unlink"]); // online, the domain is resolved and deleted
});

// ---------------------------------------------------------------------------
// "Other apps unaffected": the guard dispatches on resModel, so a
// non-crm-scoped model's Duplicate is left exactly as the framework
// already behaves (its own, pre-existing ConnectionLostError surfaces --
// not swallowed, and not newly blocked, by this feature's guard).
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, Duplicate on a non-crm model's list is untouched by the crm guard", async () => {
    await mountView({
        type: "list",
        resModel: "other.model",
        arch: `<list><field name="name"/></list>`,
        actionMenus: {},
    });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

    const setOffline = mockOffline();
    await setOffline(true);

    expect.errors(1);
    await toggleActionMenu();
    // Dimmed by the framework's own generic CSS (not crm-specific), same
    // as every other model; a direct click still reaches `orm.call`,
    // which is exactly the un-guarded, pre-existing behavior this feature
    // must leave alone outside crm's own models.
    expect(".dropdown-item:contains('Duplicate')").toHaveClass("pe-none");
    queryOne(".dropdown-item:contains('Duplicate')").click();
    await animationFrame();
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/other.model/copy" couldn't be established or was interrupted`,
    ]);
});

// ---------------------------------------------------------------------------
// Regression guard: this feature's guard must not touch the B67/B69 QUEUE
// behavior of a different, already-completed feature
// (crm_offline_queue_semantics.test.js) -- Archive/Delete on an
// individually selected (non-domain) lead still queue offline exactly as
// before.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, action-menu Delete on an individually selected lead (no domain selected) still queues web_unlink, unaffected by this guard", async () => {
    onRpc("crm.lead", "web_unlink", ({ parent }) => {
        expect.step("web_unlink");
        return parent();
    });
    await mountView({
        type: "list",
        resModel: "crm.lead",
        arch: Lead._views.list,
        actionMenus: {},
    });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

    const setOffline = mockOffline();
    await setOffline(true);

    await toggleActionMenu();
    expect(".dropdown-item:contains('Delete')").not.toHaveClass("pe-none");
    await contains(".dropdown-item:contains('Delete')").click();
    expect(".o_dialog").toHaveCount(1);
    await contains(".modal-footer button.btn-danger").click();
    expect.verifySteps([]); // not sent while offline: queued instead, same as before this feature
});
