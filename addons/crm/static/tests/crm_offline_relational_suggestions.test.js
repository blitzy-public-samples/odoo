import { defineMailModels, patchUiSize, SIZES } from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import { runAllTimers } from "@odoo/hoot-mock";
import {
    contains,
    defineModels,
    fields,
    mockOffline,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";

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

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    team_id = fields.Many2one({ relation: "crm.team" });
    tag_ids = fields.Many2many({ relation: "crm.tag" });

    _records = [{ id: 1, name: "Lead 1", team_id: false, tag_ids: [] }];
}

defineModels([Team, Tag, Lead]);
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
