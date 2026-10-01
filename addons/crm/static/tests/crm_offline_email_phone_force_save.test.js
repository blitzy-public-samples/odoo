import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountView,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { CrmStage } from "@crm/../tests/mock_server/mock_models/crm_stage";
import { CrmTeam } from "@crm/../tests/mock_server/mock_models/crm_team";

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    email_from = fields.Char();
    phone = fields.Char();
    partner_email_update = fields.Boolean();
    partner_phone_update = fields.Boolean();
    team_id = fields.Many2one({ string: "Sales Team", relation: "crm.team" });
    stage_id = fields.Many2one({ string: "Stage", relation: "crm.stage" });

    _records = [
        {
            id: 1,
            name: "Needs partner sync",
            email_from: "lead.email@test.example.com",
            phone: "+1 202 555 0100",
            partner_email_update: true,
            partner_phone_update: true,
            team_id: 1,
            stage_id: 1,
        },
        {
            id: 2,
            name: "Already synced",
            email_from: "synced@test.example.com",
            phone: "+1 202 555 0200",
            partner_email_update: false,
            partner_phone_update: false,
        },
    ];
}

CrmTeam._records = [{ id: 1, name: "Sales Team" }];
CrmStage._records = [{ id: 1, name: "New" }];

defineModels([Lead, CrmTeam, CrmStage]);
defineMailModels();

const leadFormView = {
    resModel: "crm.lead",
    type: "form",
    arch: `
        <form js_class="crm_form">
            <sheet>
                <field name="name"/>
                <field name="team_id" invisible="1"/>
                <field name="stage_id" invisible="1"/>
                <field name="email_from" invisible="1"/>
                <field name="phone" invisible="1"/>
                <field name="partner_email_update" invisible="1"/>
                <field name="partner_phone_update" invisible="1"/>
            </sheet>
        </form>`,
};

test("offline save force-includes the pending email/phone sync in the queued web_save", async () => {
    // Defect 2 (architecture.md §3.2): CrmFormRecord._save() copies
    // email_from/phone from `_values` into `_changes` whenever
    // partner_email_update/partner_phone_update is true, even though the
    // user only edits "name" here. The queue stores whatever `_save()`
    // handed it verbatim (AGENTS.md §2), so those forced values must show
    // up in the queued web_save even though the stage never changed (no
    // get_rainbowman_message is involved).
    const setOffline = mockOffline();
    await mountView({ ...leadFormView, resId: 1 });
    await setOffline(true);
    expect(getService(OfflinePlugin).isOffline()).toBe(true);

    await contains(`.o_field_widget[name="name"] input`).edit("Edited offline");
    await contains(`.o_form_button_save`).click();

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1]).toEqual({
        name: "Edited offline",
        email_from: "lead.email@test.example.com",
        phone: "+1 202 555 0100",
    });
});

test("offline save does not force a sync that isn't pending", async () => {
    // Guard: when the partner is already in sync, nothing is force-copied
    // -- the queued web_save only holds what the user actually changed.
    const setOffline = mockOffline();
    await mountView({ ...leadFormView, resId: 2 });
    await setOffline(true);

    await contains(`.o_field_widget[name="name"] input`).edit("Edited offline again");
    await contains(`.o_form_button_save`).click();

    const [{ value }] = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(value.args[1]).toEqual({ name: "Edited offline again" });
});
