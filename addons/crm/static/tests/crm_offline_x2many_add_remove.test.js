import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { contains, defineModels, fields, mockOffline, models, mountView } from "@web/../tests/web_test_helpers";

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
 *   control to prove here -- `crm_team_member_ids`, the field that
 *   would otherwise supply one (per offline_inventory.md's BR12), is
 *   permanently `invisible="is_membership_multi or not is_membership_multi"`
 *   (a tautology, always true) in the current view, so it never renders
 *   either; this is a pre-existing dead condition in `addons/
 *   sales_team`, out of scope to fix here (crm can only extend
 *   `addons/sales_team` from inside `addons/crm`, and the mission scope
 *   is `addons/crm`).
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

class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();
    member_ids = fields.Many2many({ relation: "res.users" });

    _records = [{ id: 1, name: "Sales Team", member_ids: [] }];
}

defineModels([Lead, MergeWizard, Team]);
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
