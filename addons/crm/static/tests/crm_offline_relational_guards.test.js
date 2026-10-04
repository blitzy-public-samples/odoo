import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { animationFrame, queryAll } from "@odoo/hoot-dom";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    mountWithCleanup,
    onRpc,
    serverState,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { WebClient } from "@web/webclient/webclient";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";

/**
 * m2-relational-guards (VAL-DIS-019, VAL-DIS-022).
 *
 * VAL-DIS-019 -- B55/BR1/BR3/BR11: `tag_ids`' color-edit popover and its
 * "Hide in Kanban" checkbox write `crm.tag` directly, never a lead/stage/
 * team field, so neither is a producer the offline queue covers
 * (architecture.md §3.7). `many2many_tags_field_patch.js` guards
 * `Many2ManyTagsField`'s `onTagClick`/`switchTagColor`/
 * `onTagVisibilityChange`, scoped to `crm.lead`. The two list occurrences
 * (BR1/BR3) are additionally -- and primarily -- closed by the *other*
 * feature's `list_renderer_offline_patch.js` (VAL-DIS-030): a selected
 * crm.lead row's cell click never reaches `enterEditMode()` offline, so
 * `record.isInEdition` never becomes true, and `onTagClick`'s own
 * `!isInEdition` early return already blocks the tag click before this
 * feature's guard is even reached. The list test below proves that
 * composition holds, it does not re-implement VAL-DIS-030.
 *
 * Scrutiny finding 20: blocking the write alone left the popover's "Hide
 * in Kanban" `<input type="checkbox">` enabled and visually toggleable
 * (never matched by the framework's button-only disable pass) for a
 * popover opened online and left open across the connection drop.
 * `many2many_tags_field_patch.js` now also closes an open popover
 * reactively on going offline (scoped to `crm.lead`), so the control
 * itself becomes absent instead of merely inert; see that file's header
 * for why the popover is closed rather than its `<CheckBox>` disabled.
 *
 * VAL-DIS-022 -- BR10: a many2one's own existing-record open/edit
 * navigation (`openRecordInAction`, distinct from `Many2XAutocomplete`'s
 * create/search-more gate) is reached through the readonly `<a
 * class="o_form_uri">` (not a `<button>`, so the framework's own
 * `SELECTORS_TO_DISABLE` never reaches it) and the editable-mode `<button
 * class="o_external_button">` (also not reached by the framework's
 * button auto-disable: `hasLinkButton` in many2one.js is gated on the
 * same `canOpen` prop as the readonly link, so forcing it false removes
 * the button from the DOM instead of merely disabling it).
 * `many2one_offline_patch.js` forces `canOpen` false offline on
 * `Many2OneField` and `Many2OneAvatarUserField`,
 * scoped to `crm.lead`, `crm.merge.opportunity` and
 * `crm.lead2opportunity.partner.mass`. The lead form's `partner_id`
 * (`widget="res_partner_many2one"`, `partner_autocomplete` addon, not a
 * crm dependency) goes through a third, shared-`Many2One`-level guard
 * instead (`crm_offline_partner_link.test.js`), which additionally
 * neutralizes `linkHref` (scrutiny finding 21) so a middle-click or
 * "open in new tab" on the still-present link has nothing to follow.
 *
 * Every guard is proven not to leak to a non-crm model (`other.thing`
 * below), per "scoped to crm views/models".
 */

class CrmTag extends models.Model {
    _name = "crm.tag";

    name = fields.Char();
    color = fields.Integer({ default: 1 });

    _records = [
        { id: 1, name: "Important", color: 1 },
        { id: 2, name: "Urgent", color: 2 },
        // Dedicated to the non-crm scope-check test below, so it never
        // shares state with tag #1, which other tests in this file also
        // mutate online.
        { id: 3, name: "Other-scope", color: 1 },
    ];
}

class CrmLostReason extends models.Model {
    _name = "crm.lost.reason";

    name = fields.Char();

    _records = [{ id: 1, name: "Too expensive" }];

    _views = {
        form: `<form><field name="name"/></form>`,
    };
}

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    tag_ids = fields.Many2many({ relation: "crm.tag" });
    lost_reason_id = fields.Many2one({ relation: "crm.lost.reason" });

    _records = [
        { id: 1, name: "First lead", tag_ids: [1], lost_reason_id: 1 },
        { id: 2, name: "Second lead", tag_ids: [2], lost_reason_id: 1 },
    ];

    // Registered only for the WebClient/doAction test below, which needs
    // a real `get_views` match; every other test here hands `mountView`
    // an explicit arch directly and never consults this.
    _views = {
        form: `<form edit="0"><field name="name"/><field name="lost_reason_id"/></form>`,
    };
}

// The two conversion-wizard models BR10/the patch also scopes to. Only
// what's needed to prove a many2one widget renders and behaves the same
// way on them, not the real wizard archs.
class CrmMergeOpportunity extends models.Model {
    _name = "crm.merge.opportunity";

    user_id = fields.Many2one({ relation: "res.users" });

    _records = [{ id: 1, user_id: serverState.userId }];
}

// Non-crm control model: same fields/widgets, used to prove every guard
// above stays scoped to crm.lead (+ the two wizard models) and leaves
// every other addon's many2many_tags / many2one field untouched.
class OtherThing extends models.Model {
    _name = "other.thing";

    name = fields.Char();
    tag_ids = fields.Many2many({ relation: "crm.tag" });
    lost_reason_id = fields.Many2one({ relation: "crm.lost.reason" });

    _records = [{ id: 1, name: "Other 1", tag_ids: [3], lost_reason_id: 1 }];
}

defineModels([CrmTag, CrmLostReason, Lead, CrmMergeOpportunity, OtherThing]);
defineMailModels();

const TAG_FORM_ARCH = `
    <form>
        <field name="name"/>
        <field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>
    </form>`;

const TAG_LIST_ARCH = `
    <list multi_edit="1">
        <field name="name"/>
        <field name="tag_ids" widget="many2many_tags" options="{'color_field': 'color', 'on_tag_click': 'edit_color'}"/>
    </list>`;

// ---------------------------------------------------------------------------
// VAL-DIS-019 -- B55: lead form tag color popover.
// ---------------------------------------------------------------------------

test("offline, clicking a tag on the lead form opens no color popover and issues no crm.tag write", async () => {
    onRpc("crm.tag", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: TAG_FORM_ARCH });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(0);

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
});

test("online, clicking a tag on the lead form opens the color popover and writes crm.tag (guard)", async () => {
    onRpc("crm.tag", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: TAG_FORM_ARCH });

    await contains(".o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(1);

    await contains(".o_tag_popover .o_colorlist button[data-color='2']").click();
    expect.verifySteps(["web_save"]);
});

// ---------------------------------------------------------------------------
// VAL-DIS-019 -- B55/BR11: the popover was already open before the
// connection dropped. Scrutiny finding 20: closing the popover reactively
// (rather than leaving its color buttons framework-disabled but its
// "Hide in Kanban" `<input type="checkbox">` still enabled and visually
// toggleable) is what makes the control "absent" per the DISABLE
// convention; see `many2many_tags_field_patch.js`'s header comment.
// ---------------------------------------------------------------------------

test("offline, a tag color popover already open when the connection drops closes itself; its Hide-in-Kanban checkbox is unreachable", async () => {
    onRpc("crm.tag", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: TAG_FORM_ARCH });

    await contains(".o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // "Disabled or absent" (DISABLE convention): the whole popover,
    // color buttons and checkbox alike, is gone instead of staying open
    // with some controls merely inert.
    expect(".o_tag_popover").toHaveCount(0);

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);

    // Online again, the popover opens and behaves exactly as before.
    await contains(".o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(1);
    expect(".o_tag_popover .o_colorlist button:eq(0)").toHaveProperty("disabled", false);
});

test("online, the Hide-in-Kanban checkbox still writes crm.tag (guard)", async () => {
    onRpc("crm.tag", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: TAG_FORM_ARCH });

    await contains(".o_tag:eq(0)").click();
    await contains(".o_tag_popover input[type='checkbox']").click();
    expect.verifySteps(["web_save"]);
});

// ---------------------------------------------------------------------------
// VAL-DIS-019 -- BR1/BR3: the Leads/Opportunities list's tag popover.
// Desktop only: list row selectors aren't rendered under the mobile
// preset (`crm_offline_list_celledit_disable.test.js` already proves
// that), so there is nothing list-selection-specific to exercise there.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, in a selected lead-list row the tag popover does not open because no cell editor opens (VAL-DIS-030); online it still opens", async () => {
    onRpc("crm.tag", "web_save", () => expect.step("web_save"));
    await mountView({ resModel: "crm.lead", type: "list", arch: TAG_LIST_ARCH });

    await contains(".o_data_row:eq(0) .o_list_record_selector input").click();

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // The row's own cell-edit entry point is already blocked offline
    // (VAL-DIS-030): clicking the name cell does not enter edition.
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_field_widget[name='name'] input").toHaveCount(0);

    // So the tag's own `isInEdition` guard (unrelated to this feature's
    // patch) keeps the popover from opening either.
    await contains(".o_data_row:eq(0) .o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(0);

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);

    await setOffline(false);

    // Online, entering edition first makes the tag popover reachable
    // again, exactly as before this feature.
    await contains(".o_data_row:eq(0) [name='name']").click();
    expect(".o_field_widget[name='name'] input").toHaveCount(1);
    await contains(".o_data_row:eq(0) .o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(1);
    await contains(".o_tag_popover .o_colorlist button[data-color='2']").click();
    expect.verifySteps(["web_save"]);
});

// ---------------------------------------------------------------------------
// Scope check: a non-crm model's many2many_tags field is untouched.
// ---------------------------------------------------------------------------

test("offline, a non-crm model's tag color popover still opens and queues the crm.tag write for replay (scope check)", async () => {
    onRpc("crm.tag", "web_save", ({ parent }) => {
        expect.step("web_save");
        return parent();
    });
    await mountView({
        resModel: "other.thing",
        type: "form",
        resId: 1,
        arch: TAG_FORM_ARCH,
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);

    await contains(".o_tag:eq(0)").click();
    expect(".o_tag_popover").toHaveCount(1);
    // Not this feature's guard to apply here: the popover opens exactly
    // like it would online. Its color-list buttons are plain `<button>`s
    // without `data-available-offline`, so the framework's own
    // button-disable pass (not this feature) disables them regardless of
    // model -- clicking one is a no-op, same as the already-open-popover
    // case above, so it does not distinguish this feature's scoping.
    expect(".o_tag_popover .o_colorlist button:eq(0)").toHaveProperty("disabled", true);
    // The "Hide in Kanban" checkbox is not a `<button>`, so it is not
    // framework-disabled; it is this feature's own guard
    // (`onTagVisibilityChange`) that would have to apply for it to be
    // blocked offline, and here it must not: the write proceeds like any
    // other offline save and is queued by the framework itself.
    await contains(".o_tag_popover input[type='checkbox']").click();
    expect.verifySteps([]);
    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    expect(queued[0].value.model).toBe("crm.tag");
    expect(queued[0].value.method).toBe("web_save");

    await setOffline(false);
    expect.verifySteps(["web_save"]);
});

// ---------------------------------------------------------------------------
// VAL-DIS-022 -- BR10: the lead's readonly many2one link (e.g. the lost
// reason) does not navigate offline.
// ---------------------------------------------------------------------------

test("offline, the lost-reason readonly link is absent and issues no get_record_default_action; online it is present", async () => {
    onRpc("crm.lost.reason", "get_record_default_action", () =>
        expect.step("get_record_default_action")
    );
    await mountView({
        resModel: "crm.lead",
        type: "form",
        resId: 1,
        arch: `<form edit="0"><field name="name"/><field name="lost_reason_id"/></form>`,
    });

    expect("a.o_form_uri").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);
    expect("a.o_form_uri").toHaveCount(0);
    expect.verifySteps([]);

    await setOffline(false);
    expect("a.o_form_uri").toHaveCount(1);
});

test("online, clicking the lost-reason readonly link calls get_record_default_action and navigates (guard)", async () => {
    onRpc("crm.lost.reason", "get_record_default_action", () => {
        expect.step("get_record_default_action");
        return {
            type: "ir.actions.act_window",
            res_model: "crm.lost.reason",
            res_id: 1,
            views: [[false, "form"]],
            target: "current",
        };
    });
    await mountWithCleanup(WebClient);
    // Resolves `Lead._views.form` above (a small readonly arch; the real
    // crm form is editable, so this only needs to prove the click ->
    // get_record_default_action -> doAction chain, not reproduce it).
    await getService("action").doAction({
        name: "Lead",
        res_model: "crm.lead",
        res_id: 1,
        type: "ir.actions.act_window",
        views: [[false, "form"]],
    });
    await contains("a.o_form_uri").click();
    expect.verifySteps(["get_record_default_action"]);
});

test("offline, the editable many2one's external button is absent; online it is present again", async () => {
    await mountView({
        resModel: "crm.lead",
        type: "form",
        resId: 1,
        arch: `<form><field name="name"/><field name="lost_reason_id"/></form>`,
    });

    expect(".o_field_widget[name='lost_reason_id'] button.o_external_button").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Same `canOpen` prop gates both the readonly link and this editable
    // button (`hasLinkButton` in many2one.js), so this feature's patch
    // removes the button from the DOM rather than merely disabling it --
    // the framework's own button auto-disable never gets a chance to run.
    expect(".o_field_widget[name='lost_reason_id'] button.o_external_button").toHaveCount(0);

    await setOffline(false);
    await animationFrame();
    // Checked with a plain query rather than the retrying `toHaveCount`/
    // `contains` matchers: the button is reliably back by the very next
    // animation frame (confirmed stable across several), but those two
    // matchers' own internal MutationObserver seems to miss the mutation
    // here -- likely because `Many2One`'s subtree is replaced wholesale
    // rather than patched in place -- and spin for their full 10s
    // timeout instead of finding it immediately. The click -> navigate
    // chain through this exact `canOpen` prop is already proven by the
    // readonly-link guard test above; this test only needs the DOM
    // presence/absence proof for the editable rendering.
    expect(
        queryAll(".o_field_widget[name='lost_reason_id'] button.o_external_button").length
    ).toBe(1);
});

// ---------------------------------------------------------------------------
// VAL-DIS-022 -- BR10 scope: the merge-opportunity wizard model, with the
// mail-based `many2one_avatar_user` widget (covers crm's own
// `Many2OneAvatarLeaderUserField`, which extends it).
// ---------------------------------------------------------------------------

test("offline, a many2one_avatar_user link on the merge-opportunity wizard model is absent; online it is present", async () => {
    await mountView({
        resModel: "crm.merge.opportunity",
        type: "form",
        resId: 1,
        arch: `<form edit="0"><field name="user_id" widget="many2one_avatar_user"/></form>`,
    });

    expect("a.o_form_uri").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);
    expect("a.o_form_uri").toHaveCount(0);

    await setOffline(false);
    expect("a.o_form_uri").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// Scope check: a non-crm model's many2one link is untouched.
// ---------------------------------------------------------------------------

test("online, a non-crm model's readonly many2one link navigates (scope check)", async () => {
    onRpc("crm.lost.reason", "get_record_default_action", () => {
        expect.step("get_record_default_action");
        return {
            type: "ir.actions.act_window",
            res_model: "crm.lost.reason",
            res_id: 1,
            views: [[false, "form"]],
            target: "current",
        };
    });
    await mountView({
        resModel: "other.thing",
        type: "form",
        resId: 1,
        arch: `<form edit="0"><field name="name"/><field name="lost_reason_id"/></form>`,
    });

    await contains("a.o_form_uri").click();
    expect.verifySteps(["get_record_default_action"]);
});

test("offline, a non-crm model's readonly many2one link stays in the DOM (scope check)", async () => {
    // Not clicked here: `mockCrmOffline()` simulates a real connection loss,
    // so an actual RPC attempt would throw an unhandled
    // `ConnectionLostError` regardless of this feature -- unrelated to
    // whether this feature's guard applies. The point of this scope check
    // is only that the link is not removed, as it would be for crm.lead.
    await mountView({
        resModel: "other.thing",
        type: "form",
        resId: 1,
        arch: `<form edit="0"><field name="name"/><field name="lost_reason_id"/></form>`,
    });

    const setOffline = mockCrmOffline();
    await setOffline(true);
    expect("a.o_form_uri").toHaveCount(1);

    await setOffline(false);
});
