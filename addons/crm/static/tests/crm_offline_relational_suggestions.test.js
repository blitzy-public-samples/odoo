import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { runAllTimers } from "@odoo/hoot-mock";
import { contains, defineModels, fields, mockOffline, models, mountView } from "@web/../tests/web_test_helpers";

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
 * Desktop-only: on mobile, `Many2XAutocomplete`'s own template
 * (`relational_utils.xml`) swaps the whole typing-and-suggestions UI for
 * a single `readonly` input whose click handler is `onSearchMore` --
 * there is no inline dropdown with "Create"/"Search more..." items to
 * gate at all, tapping the field always opens the (framework-owned)
 * select-create dialog directly. Upstream's own suite follows the same
 * split: every typing/suggestion-list test in `many2many_tags_field.
 * test.js` is `test.tags("desktop")`; its few `"mobile"` tests only cover
 * tag/colorpicker rendering, never the autocomplete dropdown.
 */
class Team extends models.Model {
    _name = "crm.team";

    name = fields.Char();

    _records = [
        { id: 1, name: "Team Alpha" },
        { id: 2, name: "Team Beta" },
    ];
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
