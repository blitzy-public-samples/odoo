import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { contains, defineModels, fields, mockOffline, models, mountView, onRpc } from "@web/../tests/web_test_helpers";

/**
 * m2-framework-disabled-proofs (VAL-DIS-028, B49-B52, C5). The four
 * transient wizards' footer confirm buttons -- `crm.lead.lost`'s
 * `action_lost_reason_apply` (`wizard/crm_lead_lost_views.xml:17`),
 * `crm.lead.pls.update`'s `action_update_crm_lead_probabilities`
 * (`wizard/crm_lead_pls_update_views.xml:20-21`),
 * `crm.lead2opportunity.partner.mass`'s `action_apply` (`wizard/
 * crm_lead_to_opportunity_mass_views.xml:48`) and
 * `crm.merge.opportunity`'s `action_merge` (`wizard/
 * crm_merge_opportunities_views.xml:30`) -- are all plain `<button
 * type="object" class="btn-primary">`s with no `data-available-offline`.
 * `OfflinePlugin.SELECTORS_TO_DISABLE` already disables every one of
 * them offline; no crm code change is needed, only this proof. (C5 is
 * `action_apply`'s underlying `crm.lead2opportunity.partner.mass`
 * method, reached only through this same button.)
 *
 * The "Cancel" button next to each (`special="cancel"`) is left out: it
 * only closes the dialog client-side (`ir.actions.act_window_close`, no
 * RPC and no server state change either way), so there is nothing
 * offline-specific to prove about it, and architecture.md's own DISABLE
 * contract is about controls that would otherwise reach the server.
 *
 * The confirm button is reproduced here as a plain body button, not
 * inside its real `<footer>`: `<footer>` only renders into a dialog's
 * `.modal-footer` when the form is opened through the action/dialog
 * flow (`doAction` with `target: "new"`), which plain `mountView` does
 * not go through. `OfflinePlugin.SELECTORS_TO_DISABLE` matches any
 * `<button>` lacking `data-available-offline` regardless of where in
 * the DOM it sits, so this simplification doesn't change what's proven.
 */
class LeadLost extends models.Model {
    _name = "crm.lead.lost";
    lead_ids = fields.Many2many({ relation: "crm.lead" });
    _records = [{ id: 1, lead_ids: [] }];
    action_lost_reason_apply() {
        return { type: "ir.actions.act_window_close" };
    }
}

class PlsUpdate extends models.Model {
    _name = "crm.lead.pls.update";
    pls_fields = fields.Many2many({ relation: "crm.tag" });
    _records = [{ id: 1 }];
    action_update_crm_lead_probabilities() {
        return { type: "ir.actions.act_window_close" };
    }
}

class LeadToOpportunityMass extends models.Model {
    _name = "crm.lead2opportunity.partner.mass";
    name = fields.Selection({ selection: [["convert", "Convert"], ["convert_and_merge", "Convert & Merge"]] });
    _records = [{ id: 1, name: "convert" }];
    action_apply() {
        return { type: "ir.actions.act_window_close" };
    }
}

class MergeOpportunity extends models.Model {
    _name = "crm.merge.opportunity";
    opportunity_ids = fields.Many2many({ relation: "crm.lead" });
    _records = [{ id: 1, opportunity_ids: [] }];
    action_merge() {
        return { type: "ir.actions.act_window_close" };
    }
}

class Tag extends models.Model {
    _name = "crm.tag";
    name = fields.Char();
    _records = [];
}

class Lead extends models.Model {
    _name = "crm.lead";
    name = fields.Char();
    _records = [];
}

defineModels([LeadLost, PlsUpdate, LeadToOpportunityMass, MergeOpportunity, Tag, Lead]);
defineMailModels();

const WIZARDS = [
    {
        resModel: "crm.lead.lost",
        method: "action_lost_reason_apply",
        arch: `
            <form string="Lost Lead">
                <button name="action_lost_reason_apply" string="Mark as Lost" type="object" class="btn-primary"/>
                <button class="btn-secondary" special="cancel"/>
            </form>`,
    },
    {
        resModel: "crm.lead.pls.update",
        method: "action_update_crm_lead_probabilities",
        arch: `
            <form>
                <button name="action_update_crm_lead_probabilities" type="object" string="Update" class="btn-primary"/>
                <button special="cancel"/>
            </form>`,
    },
    {
        resModel: "crm.lead2opportunity.partner.mass",
        method: "action_apply",
        arch: `
            <form string="Convert to Opportunities">
                <button string="Convert" name="action_apply" type="object" class="btn-primary"/>
                <button class="btn-secondary" special="cancel"/>
            </form>`,
    },
    {
        resModel: "crm.merge.opportunity",
        method: "action_merge",
        arch: `
            <form string="Merge Leads/Opportunities">
                <button name="action_merge" type="object" string="Merge" class="btn-primary"/>
                <button class="btn-secondary" special="cancel"/>
            </form>`,
    },
];

for (const { resModel, method, arch } of WIZARDS) {
    test(`offline, ${resModel}'s confirm button ("${method}") is disabled and issues no RPC; online it still works`, async () => {
        onRpc(resModel, method, ({ parent }) => {
            expect.step(method);
            return parent();
        });
        await mountView({ resModel, type: "form", resId: 1, arch });

        const button = `button[name='${method}']`;
        expect(button).not.toHaveAttribute("disabled");

        const setOffline = mockOffline();
        await setOffline(true);

        expect(button).toHaveAttribute("disabled");
        expect(button).toHaveClass("o_disabled_offline");
        await contains(button).click();
        expect.verifySteps([]); // the confirm RPC never fired

        await setOffline(false);
        expect(button).not.toHaveAttribute("disabled");
        expect(button).not.toHaveClass("o_disabled_offline");
        await contains(button).click();
        expect.verifySteps([method]); // online, it still works
    });
}
