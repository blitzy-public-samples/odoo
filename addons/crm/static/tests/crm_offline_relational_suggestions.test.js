import { defineMailModels, patchUiSize, SIZES } from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import { runAllTimers } from "@odoo/hoot-mock";
import {
    contains,
    defineModels,
    fields,
    getService,
    mockOffline,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * m2-framework-disabled-proofs (VAL-DIS-020). Rows B25, B63 and the
 * BR2/BR4/BR5/BR6/BR9 group (every `many2one`/`many2many` autocomplete on
 * crm's own views and wizards -- `team_id`, `tag_ids`, `stage_id`,
 * `lost_reason_id`, `partner_id`, ...) all go through the same base
 * `Many2XAutocomplete.suggest()` (`addons/web/static/src/views/fields/
 * relational_utils.js:450-458`): "Create", "Create and edit..." and
 * "Search more..." are only pushed `if (!this.offlinePlugin.
 * isOffline())`. This is a single framework-level gate shared by every
 * many2one/many2many field in the app, crm's included -- already fixed
 * in `addons/web`, with no crm code to change. One many2one and one
 * many2many_tags field (the two autocomplete flavors crm's views use)
 * are a proportionate proof for the whole family.
 *
 * Desktop-only (the two tests below): on mobile, `Many2XAutocomplete`'s
 * own template (`relational_utils.xml`) swaps the whole
 * typing-and-suggestions UI for a single `readonly` input whose click
 * handler is `onSearchMore` -- there is no inline dropdown with
 * "Create"/"Search more..." items to gate at all, tapping the field
 * always opens the (framework-owned) select-create dialog directly.
 * Upstream's own suite follows the same split: every typing/suggestion-
 * list test in `many2many_tags_field.test.js` is `test.tags("desktop")`;
 * its few `"mobile"` tests only cover
 * tag/colorpicker rendering, never the autocomplete dropdown.
 *
 * Scrutiny finding 27 (VAL-DIS-020): that mobile dialog is itself a
 * reachable control, though, and needs its own proof: the third test
 * below forces the small-screen input with `patchUiSize()` (so it runs
 * identically whichever Hoot preset executes it, "one test for both
 * presets") and opens the select/create dialog that `onSearchMore`
 * mounts. Its "Create New" button (`select_create_dialog.xml`) is a
 * plain `<button>` with no `data-available-offline`, so -- same as the
 * two desktop tests above -- the framework's own `SELECTORS_TO_DISABLE`
 * already disables it with no crm code to change; a dialog left open
 * from before the connection dropped is otherwise untouched.
 */
class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [
        { id: 1, name: "Team Alpha" },
        { id: 2, name: "Team Beta" },
    ];

    // The small-screen select/create dialog (finding 27's test, below)
    // renders a kanban view of resModel on a small screen
    // (`SelectCreateDialog.viewProps`), unlike the desktop dialog's list.
    _views = {
        kanban: `
            <kanban>
                <templates>
                    <t t-name="card">
                        <field name="name"/>
                    </t>
                </templates>
            </kanban>`,
    };
}

class Tag extends models.Model {
    _name = "crm.tag";

    name = fields.Char();

    _records = [{ id: 1, name: "Existing Tag" }];
}

class Stage extends models.Model {
    _name = "crm.stage";

    name = fields.Char();
    team_ids = fields.Many2many({ relation: "crm.team" });

    _records = [{ id: 1, name: "New", team_ids: [] }];
}

class ScoringField extends models.Model {
    _name = "crm.lead.scoring.frequency.field";

    name = fields.Char();

    _records = [{ id: 1, name: "Existing Field" }];
}

class PlsUpdateWizard extends models.Model {
    _name = "crm.lead.pls.update";

    pls_fields = fields.Many2many({ relation: "crm.lead.scoring.frequency.field" });

    _records = [{ id: 1, pls_fields: [] }];
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    team_id = fields.Many2one({ relation: "crm.team" });
    tag_ids = fields.Many2many({ relation: "crm.tag" });
    partner_id = fields.Many2one({ relation: "res.partner" });
    user_id = fields.Many2one({ relation: "res.users" });

    _records = [
        { id: 1, name: "Lead 1", team_id: false, tag_ids: [] },
        // A second record, with `team_id` set, is needed for the
        // `user_id`/`many2one_avatar_leader_user` case further down:
        // `Many2OneAvatarLeaderUserField.m2oProps` reads
        // `record.data[teamField].id` unconditionally
        // (`many2one_avatar_leader_user.js`), which throws on a `false`
        // `team_id` -- record 1 is kept team-less for the existing
        // `team_id` tests above, unaffected by this.
        { id: 2, name: "Lead 2", team_id: 1, tag_ids: [], partner_id: false, user_id: false },
    ];
}

defineModels([Team, Tag, Stage, ScoringField, PlsUpdateWizard, Lead]);
defineMailModels();

const FORM_ARCH = `
    <form>
        <field name="team_id"/>
        <field name="tag_ids" widget="many2many_tags"/>
    </form>`;

test.tags("desktop");
test("offline, 'Search more...' is not suggested on a many2one with matches; online it is", async () => {
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    await contains("[name='team_id'] input").click();
    await contains("[name='team_id'] input").edit("Team", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Team Alpha')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Search more')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains("[name='team_id'] input").edit("Team B", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Team Beta')").toHaveCount(1); // cached match still offered
    expect(".o-autocomplete--dropdown-item:contains('Search more')").toHaveCount(0); // but not the action suggestion

    await setOffline(false);
    await contains("[name='team_id'] input").edit("Team", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Search more')").toHaveCount(1); // online, it's back
});

test.tags("desktop");
test("offline, 'Create \"...\"' and 'Create and edit...' are not suggested on a many2many_tags field; online they are", async () => {
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    await contains("[name='tag_ids'] input").click();
    await contains("[name='tag_ids'] input").edit("Brand New Tag", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Create "Brand New Tag"')`).toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create and edit')").toHaveCount(1);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains("[name='tag_ids'] input").edit("Another New Tag", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0); // no create suggestion at all
    expect(".o-autocomplete--dropdown-item:contains('No records')").toHaveCount(1);

    await setOffline(false);
    await contains("[name='tag_ids'] input").edit("Yet Another Tag", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Create "Yet Another Tag"')`).toHaveCount(1); // online, it's back
});

// ---------------------------------------------------------------------------
// Scrutiny finding 27 (VAL-DIS-020): the small-screen select/create
// dialog (not the desktop suggestion dropdown above) is the mobile
// path's own reachable control, and needs its own proof.
// ---------------------------------------------------------------------------

test("offline, the small-screen select/create dialog's Create New is disabled and issues no name_create; online it works", async () => {
    patchUiSize({ size: SIZES.SM });
    onRpc("crm.team", "name_create", () => expect.step("name_create"));
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    // On a small screen the many2one swaps its typing/suggestions UI for
    // a single readonly input; tapping it opens the select/create
    // dialog directly (`onSearchMore`), skipping the "Create"/"Search
    // more..." dropdown items the two desktop tests above cover.
    await contains("[name='team_id'] input").click();
    await waitFor(".modal .o_create_button");

    const setOffline = mockOffline();
    await setOffline(true);

    // The dialog was already open before the connection dropped: its
    // "Create New" button is a plain `<button>` with no
    // `data-available-offline`, so the framework's own
    // `SELECTORS_TO_DISABLE` disables it on its own.
    expect(".modal .o_create_button").toHaveAttribute("disabled");
    await contains(".modal .o_create_button").click();
    expect.verifySteps([]); // no name_create even attempted
    expect(".modal .o_form_view").toHaveCount(0); // the create form never opened

    await setOffline(false);
    expect(".modal .o_create_button").not.toHaveAttribute("disabled");
    await contains(".modal .o_create_button").click();
    await waitFor(".modal .o_form_view"); // online, Create New still opens the form
});

// ---------------------------------------------------------------------------
// M2 user-testing round-1 (VAL-DIS-020): the two tests above prove the
// shared `Many2XAutocomplete.suggest()` gate once on `team_id` (many2one)
// and once on `tag_ids` (many2many_tags) -- a proportionate stand-in for
// every BR2/BR4/BR5/BR6/BR9-listed occurrence. Round-1 user testing asked
// for the specific occurrences the contract names, by field and view, not
// just the mechanism: quick-create form `partner_id`
// (`crm_lead_views.xml:409`), the lead-list `tag_ids` column (`:354`, no
// `no_create_edit`), the stage-list `team_ids` column
// (`crm_stage_views.xml:26`, no restriction), the PLS wizard's
// `pls_fields` (`crm_lead_pls_update_views.xml`), and the form's `user_id`
// through `many2one_avatar_leader_user` (`crm_lead_views.xml:238-239`).
// ---------------------------------------------------------------------------

const QUICK_CREATE_PARTNER_ARCH = `
    <form>
        <field name="partner_id" placeholder="Contact"/>
    </form>`;

test.tags("desktop");
test("offline, 'Create...' is not suggested on the quick-create form's partner_id; online it is", async () => {
    await mountView({ resModel: "crm.lead", type: "form", resId: 2, arch: QUICK_CREATE_PARTNER_ARCH });

    await contains("[name='partner_id'] input").click();
    await contains("[name='partner_id'] input").edit("Brand New Contact", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Create "Brand New Contact"')`).toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("[name='partner_id'] input").edit("Another Contact", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);
    expect(".o-autocomplete--dropdown-item:contains('No records')").toHaveCount(1);

    await setOffline(false);
    await contains("[name='partner_id'] input").edit("Yet Another Contact", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Create "Yet Another Contact"')`).toHaveCount(1);
});

const PLS_WIZARD_ARCH = `
    <form>
        <field name="pls_fields" widget="many2many_tags"/>
    </form>`;

test.tags("desktop");
test("offline, 'Create \"...\"' is not suggested on the PLS wizard's pls_fields; online it is", async () => {
    await mountView({ resModel: "crm.lead.pls.update", type: "form", resId: 1, arch: PLS_WIZARD_ARCH });

    await contains("[name='pls_fields'] input").click();
    await contains("[name='pls_fields'] input").edit("Brand New Field", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Create "Brand New Field"')`).toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("[name='pls_fields'] input").edit("Another New Field", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);

    await setOffline(false);
    await contains("[name='pls_fields'] input").edit("Yet Another Field", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Create "Yet Another Field"')`).toHaveCount(1);
});

const USER_AVATAR_ARCH = `
    <form>
        <field name="team_id" invisible="1"/>
        <field name="user_id" widget="many2one_avatar_leader_user" teamField="team_id"/>
    </form>`;

test.tags("desktop");
test("offline, 'Invite...'/'Search more...' are not suggested on user_id's many2one_avatar_leader_user widget; online they are", async () => {
    await mountView({ resModel: "crm.lead", type: "form", resId: 2, arch: USER_AVATAR_ARCH });

    await contains("[name='user_id'] input").click();
    await contains("[name='user_id'] input").edit("Brand New User", { confirm: false });
    await runAllTimers();
    // `Many2XAvatarUserAutocomplete.actionSuggestions`
    // (`avatar_many2x_autocomplete.js`) replaces the base "Create"/
    // "Create and edit" entries with its own "Invite..." one, but it's
    // still built from the exact same `actionSuggestions` array
    // `suggest()` gates as a whole (`relational_utils.js`) -- so this
    // only needs to prove *a* suggestion from that array is gone offline,
    // under whatever label this widget gives it.
    expect(`.o-autocomplete--dropdown-item:contains('Invite "Brand New User"')`).toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains("[name='user_id'] input").edit("Another New User", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Invite')").toHaveCount(0);

    await setOffline(false);
    await contains("[name='user_id'] input").edit("Yet Another User", { confirm: false });
    await runAllTimers();
    expect(`.o-autocomplete--dropdown-item:contains('Invite "Yet Another User"')`).toHaveCount(1);
});

// The lead-list `tag_ids` column and the stage-list `team_ids` column are
// both reachable only through a checked row's cell click
// (`list_renderer_offline_patch.js`'s `onCellClicked`), on two of the
// three models (`crm.lead`, `crm.stage`) that guard blocks from entering
// cell edition at all while offline -- so the autocomplete gate these
// tests exist to prove is moot there: there's no cell editor, and so no
// autocomplete, to suggest "Create" from in the first place. Proven
// end-to-end rather than skipped, so the clause's citation of these two
// occurrences is actually covered, not just reasoned around.
const LEAD_LIST_TAG_ARCH = `
    <list js_class="crm_list" multi_edit="1">
        <field name="name"/>
        <field name="tag_ids" widget="many2many_tags"/>
    </list>`;

const STAGE_LIST_TEAM_ARCH = `
    <list multi_edit="1">
        <field name="name"/>
        <field name="team_ids" widget="many2many_tags"/>
    </list>`;

const BLOCKED_LIST_CASES = [
    {
        label: "the Leads list's tag_ids column",
        resModel: "crm.lead",
        arch: LEAD_LIST_TAG_ARCH,
        fieldName: "tag_ids",
    },
    {
        label: "the Stages list's team_ids column",
        resModel: "crm.stage",
        arch: STAGE_LIST_TEAM_ARCH,
        fieldName: "team_ids",
    },
];

for (const { label, resModel, arch, fieldName } of BLOCKED_LIST_CASES) {
    test.tags("desktop");
    test(`offline, ${label}'s cell editor never opens on a checked row, so no 'Create' suggestion is reachable there either; online it still opens and suggests Create`, async () => {
        await mountView({ resModel, type: "list", arch });

        await contains(".o_data_row:eq(0) .o_list_record_selector input").click();
        expect(".o_data_row:eq(0)").toHaveClass("o_data_row_selected");

        const setOffline = mockCrmOffline();
        await setOffline(true);

        await contains(`.o_data_row:eq(0) [name='${fieldName}']`).click();
        expect(`.o_field_widget[name='${fieldName}'] input`).toHaveCount(0); // no editor, so no autocomplete at all
        expect(Object.keys(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

        await setOffline(false);

        await contains(`.o_data_row:eq(0) [name='${fieldName}']`).click();
        await contains(`.o_field_widget[name='${fieldName}'] input`).edit("Brand New", {
            confirm: false,
        });
        await runAllTimers();
        expect(`.o-autocomplete--dropdown-item:contains('Create "Brand New"')`).toHaveCount(1); // online, the editor (and its Create suggestion) is back
    });
}
