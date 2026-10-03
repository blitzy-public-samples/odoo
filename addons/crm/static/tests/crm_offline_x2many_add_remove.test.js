import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    mockOffline,
    models,
    mountView,
} from "@web/../tests/web_test_helpers";

/**
 * m2-framework-disabled-proofs (VAL-DIS-023). B85 (the merge wizard's
 * `opportunity_ids` many2many list, `wizard/crm_merge_opportunities_views.
 * xml:19-31`) and the team form's `member_ids` kanban (`addons/
 * sales_team/views/crm_team_views.xml:59-76`): add is a plain framework
 * `<button>` in both cases, so `OfflinePlugin.SELECTORS_TO_DISABLE`
 * already disables it with no crm code needed.
 *
 * - `opportunity_ids`'s list sub-view has no `editable` attribute, but
 *   `ListRenderer.displayRowCreates` (`isX2Many && canCreate`) does not
 *   require one: the "Add a line" `CreateRow` button
 *   (`list_renderer.xml:157-184`) and each row's own delete button
 *   (`.o_list_record_remove button[name='delete']`, `:415-429`) both
 *   render regardless, and both are plain `<button>`s with no
 *   `data-available-offline`.
 * - `member_ids`'s kanban sub-view's "Add" button
 *   (`.o-kanban-button-new`, `kanban_renderer.xml:116`) is the generic
 *   `KanbanRenderer` control, distinct from the main kanban view's own
 *   "New" button (`kanban_controller.xml`, which *does* compute
 *   `data-available-offline` dynamically) -- this one never carries the
 *   attribute, in a top-level kanban view or an x2many sub-view alike.
 *   `member_ids`'s own card template (`sales_team/views/
 *   crm_team_views.xml:62-73`) declares no `menu` slot and no delete
 *   affector at all, offline or online, so there is no "remove" row
 *   control to prove here.
 *
 * M2 user-testing round-1 (VAL-DIS-023): `crm_team_member_ids` was
 * mocked as a `Many2many` to `res.users` below; the real field is a
 * `One2many('crm.team.member', 'crm_team_id')` (`sales_team/models/
 * crm_team.py`), fixed here. The relation kind matters a lot more than
 * just a cosmetic dialog label: `addons/web/static/src/views/fields/
 * field.js`'s `validFieldTypes` table marks `one2many` as
 * `{ availableOffline: false }` (unlike `many2many`, which is `true`),
 * and `Field.fieldComponentProps` forces `readonly` for any field whose
 * type isn't offline-available the moment `OfflinePlugin.isOffline()`
 * is true -- independently of and earlier than the generic
 * button-`disabled` pass `SELECTORS_TO_DISABLE` does. So for a true
 * one2many like `crm_team_member_ids`, going offline makes the whole
 * `X2ManyField` instance readonly: `canCreate` becomes `false` and the
 * kanban's "Add" button (`x2many_field.js`'s `rendererProps`, gated on
 * `this.canCreate`) is never rendered at all -- not merely disabled.
 * The previous (wrong) `Many2many` mock hid this: many2many stays
 * writable offline, so its "Add" button renders and only picks up the
 * generic disabled-button treatment, which is what the pre-fix version
 * of this test asserted for both fields alike. `member_ids` (the real
 * many2many a few lines below) still goes through that generic path;
 * only `crm_team_member_ids` goes through the stronger, field-type-wide
 * guard. Both are still proof that the control is unreachable offline,
 * by different (and equally in-scope, equally crm-code-free) framework
 * mechanisms -- confirmed with `console.log`-level introspection of
 * `X2ManyField.prototype.canCreate` during triage, not merely reasoned
 * from reading the source.
 *
 * The relation kind also matters for the delete test further down:
 * `useOpenX2ManyRecord.openRecord()` (`relational_utils.js`) labels the
 * x2many dialog's delete button "Delete" for a one2many and "Remove"
 * for a many2many (`deleteButtonLabel`), and that button --
 * `.o_btn_remove` in `web.X2ManyFieldDialogDefaultButtons`
 * (`relational_utils.xml`) -- is, like every other button in that
 * dialog's footer bar it shares (Save, Save & New, Discard), a plain
 * `<button>` with no `data-available-offline`, so the framework
 * disables all of them with no crm code to change.
 *
 * Scrutiny finding 28 (VAL-DIS-023): `member_ids` is permanently
 * `invisible="is_membership_multi or not is_membership_multi"` (a
 * tautology, always true) in `sales_team`'s own base form -- but a prior
 * version of this file's comment stopped there and concluded
 * `crm_team_member_ids` (the one2many to `crm.team.member` that would
 * otherwise supply a reachable "Add"/"Remove" pair, per
 * offline_inventory.md's BR12) therefore "never renders either". That is
 * wrong: `crm/views/crm_team_views.xml:199-204` is a *crm* view
 * inheritance of that same base form, and it overrides both fields'
 * visibility --
 * `<xpath expr="//field[@name='member_ids']"><attribute
 * name="invisible">assignment_enabled</attribute></xpath>` and the
 * mirror-image `<xpath expr="//field[@name='crm_team_member_ids']">
 * <attribute name="invisible">not assignment_enabled</attribute>`
 * (`crm.team.assignment_enabled`, a stored computed field unrelated to
 * `is_membership_multi`). So on an actual `crm.team` form,
 * `crm_team_member_ids` *does* render -- precisely when
 * `assignment_enabled` is `True`, which is also the one case where
 * `member_ids` is hidden instead. Its kanban sub-view inherits
 * `sales_team`'s base `crm_team_member_view_kanban` with no `create="0"`
 * override, so it keeps the same generic, framework-only "Add" button as
 * `member_ids`'s -- same proof, same crm scope (`crm.team`), reached
 * through a different field.
 */
class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();

    _records = [
        { id: 1, name: "Opportunity 1" },
        { id: 2, name: "Opportunity 2" },
    ];
}

class MergeWizard extends models.Model {
    _name = "crm.merge.opportunity";

    opportunity_ids = fields.Many2many({ relation: "crm.lead" });

    _records = [{ id: 1, opportunity_ids: [1, 2] }];
}

class TeamMember extends models.Model {
    _name = "crm.team.member";

    name = fields.Char();
    crm_team_id = fields.Many2one({ relation: "crm.team" });

    _records = [{ id: 1, name: "Mitchell Admin", crm_team_id: 2 }];
}

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    assignment_enabled = fields.Boolean();
    member_ids = fields.Many2many({ relation: "res.users" });
    // The real field (`sales_team/models/crm_team.py`) is a
    // `One2many('crm.team.member', 'crm_team_id')`, not a many2many --
    // see the module docstring above for why the distinction matters.
    crm_team_member_ids = fields.One2many({
        relation: "crm.team.member",
        relation_field: "crm_team_id",
    });

    _records = [
        { id: 1, name: "Sales Team", assignment_enabled: false, member_ids: [], crm_team_member_ids: [] },
        { id: 2, name: "Assignment Team", assignment_enabled: true, member_ids: [], crm_team_member_ids: [] },
        { id: 3, name: "Team With a Member", assignment_enabled: true, member_ids: [], crm_team_member_ids: [1] },
    ];
}

defineModels([Lead, MergeWizard, TeamMember, Team]);
defineMailModels();

const MERGE_WIZARD_ARCH = `
    <form string="Merge Leads/Opportunities">
        <field name="opportunity_ids" nolabel="1">
            <list>
                <field name="name" string="Title"/>
            </list>
        </field>
        <footer>
            <button name="action_merge" type="object" string="Merge" class="btn-primary"/>
            <button class="btn-secondary" special="cancel"/>
        </footer>
    </form>`;

const TEAM_FORM_ARCH = `
    <form>
        <field name="name"/>
        <field name="member_ids" mode="kanban" class="w-100">
            <kanban>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>
        </field>
    </form>`;

// Mirrors the real `crm/views/crm_team_views.xml:199-204` inheritance:
// `member_ids` and `crm_team_member_ids` are each visible for the
// opposite value of `assignment_enabled`.
const TEAM_FORM_ARCH_WITH_ASSIGNMENT = `
    <form>
        <field name="name"/>
        <field name="assignment_enabled" invisible="1"/>
        <field name="member_ids" mode="kanban" class="w-100" invisible="assignment_enabled">
            <kanban>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>
        </field>
        <field name="crm_team_member_ids" mode="kanban" class="w-100" invisible="not assignment_enabled">
            <kanban>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>
        </field>
    </form>`;

test("offline, the merge wizard's 'Add a line' and row-delete buttons on opportunity_ids are disabled; online they work", async () => {
    await mountView({ resModel: "crm.merge.opportunity", type: "form", resId: 1, arch: MERGE_WIZARD_ARCH });

    const addBtn = ".o_field_x2many_list_row_add button";
    const removeBtn = ".o_data_row:eq(0) .o_list_record_remove button[name='delete']";
    expect(addBtn).toHaveCount(1);
    expect(addBtn).not.toHaveAttribute("disabled");
    expect(removeBtn).toHaveCount(1);
    expect(removeBtn).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(addBtn).toHaveAttribute("disabled");
    expect(addBtn).toHaveClass("o_disabled_offline");
    expect(removeBtn).toHaveAttribute("disabled");
    expect(removeBtn).toHaveClass("o_disabled_offline");

    await contains(addBtn).click();
    expect(".modal").toHaveCount(0); // the "select or create" dialog never opens
    await contains(removeBtn).click();
    expect(".o_data_row").toHaveCount(2); // row count unchanged: the delete never happened

    await setOffline(false);
    expect(addBtn).not.toHaveAttribute("disabled");
    expect(removeBtn).not.toHaveAttribute("disabled");

    await contains(removeBtn).click();
    expect(".o_data_row").toHaveCount(1); // online, delete still works
});

test("offline, the team form's member_ids kanban 'Add' button is disabled; online it works", async () => {
    await mountView({ resModel: "crm.team", type: "form", resId: 1, arch: TEAM_FORM_ARCH });

    const addBtn = "[name='member_ids'] .o-kanban-button-new";
    expect(addBtn).toHaveCount(1);
    expect(addBtn).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(addBtn).toHaveAttribute("disabled");
    expect(addBtn).toHaveClass("o_disabled_offline");
    await contains(addBtn).click();
    expect(".modal").toHaveCount(0); // the "add members" dialog never opens

    await setOffline(false);
    expect(addBtn).not.toHaveAttribute("disabled");
    expect(addBtn).not.toHaveClass("o_disabled_offline");
});

// ---------------------------------------------------------------------------
// Scrutiny finding 28 (VAL-DIS-023): `crm_team_member_ids` is reachable
// -- the opposite of what a prior version of this file's own comment
// claimed -- when `assignment_enabled` is `True`.
// ---------------------------------------------------------------------------

test("offline, with assignment_enabled, the team form's crm_team_member_ids kanban 'Add' button is removed (one2many fields go fully readonly offline); online it works", async () => {
    await mountView({ resModel: "crm.team", type: "form", resId: 2, arch: TEAM_FORM_ARCH_WITH_ASSIGNMENT });

    // member_ids is hidden and crm_team_member_ids renders instead, same
    // as on the real crm.team form once assignment_enabled is set.
    expect("[name='member_ids']").toHaveCount(0);
    const addBtn = "[name='crm_team_member_ids'] .o-kanban-button-new";
    expect(addBtn).toHaveCount(1);
    expect(addBtn).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    // Unlike member_ids's generic disabled-button treatment above, a
    // one2many field is forced fully readonly by field.js's
    // validFieldTypes offline (fieldComponentProps' readonly, passed
    // into X2ManyField as a prop -- not the arch-attribute readonly
    // that drives this wrapper's own o_readonly_modifier class), so
    // canCreate is false and the "Add" control is never rendered --
    // stronger than merely disabled.
    expect(addBtn).toHaveCount(0);

    await setOffline(false);
    expect(addBtn).toHaveCount(1);
    expect(addBtn).not.toHaveAttribute("disabled");
});

// ---------------------------------------------------------------------------
// M2 user-testing round-1 (VAL-DIS-023, BR12): the "Add" tests above only
// prove `crm_team_member_ids`'s generic kanban "Add" control. BR12 also
// names the x2many's own add/remove *row* pair -- the one still missing
// here is removing an existing card through the dialog opened by clicking
// it (`useOpenX2ManyRecord`'s kanban-click path, since the card template
// declares no inline delete affector of its own, see the module
// docstring).
// ---------------------------------------------------------------------------

test("offline, with assignment_enabled, deleting a crm_team_member_ids card through its dialog is disabled; online it still works", async () => {
    await mountView({ resModel: "crm.team", type: "form", resId: 3, arch: TEAM_FORM_ARCH_WITH_ASSIGNMENT });

    expect("[name='crm_team_member_ids'] .o_card_record").toHaveCount(1);
    await contains("[name='crm_team_member_ids'] .o_card_record").click();
    await waitFor(".modal .o_form_view");

    const deleteBtn = ".modal .o_btn_remove";
    expect(deleteBtn).toHaveCount(1);
    expect(deleteBtn).toHaveText("Delete"); // one2many label (deleteButtonLabel), not many2many's "Remove"
    expect(deleteBtn).not.toHaveAttribute("disabled");

    const setOffline = mockOffline();
    await setOffline(true);

    expect(deleteBtn).toHaveAttribute("disabled");
    expect(deleteBtn).toHaveClass("o_disabled_offline");
    await contains(deleteBtn).click();
    expect(".modal").toHaveCount(1); // the dialog is still open, nothing removed
    expect("[name='crm_team_member_ids'] .o_card_record").toHaveCount(1);

    await setOffline(false);
    expect(deleteBtn).not.toHaveAttribute("disabled");
    await contains(deleteBtn).click();
    expect(".modal").toHaveCount(0); // online, removing the record closes the dialog
    expect("[name='crm_team_member_ids'] .o_card_record").toHaveCount(0);
});
