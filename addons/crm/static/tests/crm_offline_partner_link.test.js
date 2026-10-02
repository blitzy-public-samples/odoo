import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { Component, useProps } from "@odoo/owl";
import { expect, test } from "@odoo/hoot";
import {
    contains,
    defineModels,
    fields,
    mockOffline,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { registry } from "@web/core/registry";
import { computeM2OProps, Many2One } from "@web/views/fields/many2one/many2one";
import { buildM2OFieldDescription, many2OneFieldProps } from "@web/views/fields/many2one/many2one_field";

/**
 * m2-test-stability-partner-link (VAL-DIS-022 gap closure).
 *
 * The lead form's `partner_id` uses `widget="res_partner_many2one"`
 * (`PartnerAutoCompleteMany2one`, `partner_autocomplete` addon -- not a
 * crm dependency), a third many2one field-wrapper class that
 * `many2one_offline_patch.js`'s original two patches (`Many2OneField`,
 * `Many2OneAvatarUserField`) never reached. That widget is *not*
 * registered in this unit-test environment though (confirmed
 * empirically: mounting a `res_partner_many2one` field here logs
 * "Missing widget" and falls back to a plain `<span>`, even though the
 * addon is installed in a real `crm_offline` database and does ship
 * JS/XML in `web.assets_backend` -- the unit-test asset bundle in this
 * harness is apparently scoped to `-u crm,web`'s dependency closure, not
 * every installed module). Per this feature's instructions, falling back
 * to testing the shared building block directly (the real-browser proof
 * that `partner_id` itself behaves this way, on the actual lead form, is
 * recorded in this feature's handoff instead).
 *
 * `TestMany2OneField` below is a structural clone of the real
 * `Many2OneField` (same props, same `computeM2OProps`, same
 * `web.Many2OneField` template, which is nothing but `<Many2One
 * t-props="this.m2oProps"/>`) registered under its own field name so it
 * is never touched by `disableRecordOpenOffline(Many2OneField)` -- it
 * only ever reaches the shared, patched `Many2One` the exact same way
 * `PartnerMany2One extends Many2One` (and so `PartnerAutoCompleteMany2one`
 * through it) does. Mounted through a real form view, `env.model` is set
 * by `form_controller.js`/`form_renderer.js` exactly as it would be for
 * the real lead form, so `disableSharedRecordOpenOffline(Many2One)`'s
 * `env.model.config.resModel` scoping check is exercised unchanged.
 *
 * `many2one_offline_patch.js`'s `disableSharedRecordOpenOffline(Many2One)`
 * patches the shared `Many2One` component itself (`addons/web`, already a
 * crm dependency) rather than importing `PartnerAutoCompleteMany2one` --
 * see that file's header comment for why this leaves the readonly link
 * *present but inert* offline (no RPC, no navigation) instead of
 * *absent*, unlike `lost_reason_id`/`user_id` in
 * `crm_offline_relational_guards.test.js`.
 *
 * Scrutiny finding 21 (VAL-DIS-022): "present but inert" was not enough
 * on its own -- a middle-click or "Open link in new tab" follows the
 * `<a href>` directly, bypassing `openRecordInAction`'s click guard
 * entirely. `disableSharedRecordOpenOffline` now also patches `linkHref`
 * so the href itself is empty while scoped crm offline; the test below
 * asserts that in addition to the click-and-no-RPC behavior it already
 * covered.
 */

class TestMany2OneField extends Component {
    static template = "web.Many2OneField";
    static components = { Many2One };
    props = useProps(many2OneFieldProps);

    get m2oProps() {
        return computeM2OProps(this.props);
    }
}

registry.category("fields").add("test_many2one", buildM2OFieldDescription(TestMany2OneField));

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    partner_id = fields.Many2one({ relation: "res.partner" });

    _records = [{ id: 1, name: "First lead", partner_id: 1 }];
}

// Non-crm control model: same field/widget, used to prove the guard stays
// scoped to crm.lead and leaves every other model's many2one untouched,
// online or offline.
class OtherThing extends models.Model {
    _name = "other.thing";

    name = fields.Char();
    partner_id = fields.Many2one({ relation: "res.partner" });

    _records = [{ id: 1, name: "Other 1", partner_id: 1 }];
}

defineModels([Lead, OtherThing]);
defineMailModels();

const FORM_ARCH = `
    <form edit="0">
        <field name="name"/>
        <field name="partner_id" widget="test_many2one"/>
    </form>`;

test("offline, the lead form's partner_id readonly link issues no get_record_default_action and does not navigate; online it still does", async () => {
    onRpc("res.partner", "get_record_default_action", () => {
        expect.step("get_record_default_action");
        return {
            type: "ir.actions.act_window",
            res_model: "res.partner",
            res_id: 1,
            views: [[false, "form"]],
            target: "current",
        };
    });
    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    expect("a.o_form_uri").toHaveCount(1);
    expect("a.o_form_uri").toHaveAttribute("href", "/odoo/res.partner/1");

    const setOffline = mockOffline();
    await setOffline(true);

    // Unlike `lost_reason_id`/`user_id` (closed by the per-wrapper
    // `m2oProps` patch, which can force the whole link absent), the
    // shared `Many2One`-level patch cannot override the `canOpen` prop
    // it was handed, only its own methods -- so the link stays present,
    // but clicking it is a no-op.
    expect("a.o_form_uri").toHaveCount(1);
    await contains("a.o_form_uri").click();
    expect.verifySteps([]);

    // Scrutiny finding 21: the href itself is neutralized too, so a
    // middle-click or "Open link in new tab" -- which never goes through
    // the click handler just asserted above -- has nothing to navigate
    // to either.
    expect("a.o_form_uri").not.toHaveAttribute("href");

    await setOffline(false);
    expect("a.o_form_uri").toHaveAttribute("href", "/odoo/res.partner/1");
    await contains("a.o_form_uri").click();
    expect.verifySteps(["get_record_default_action"]);
});

test("offline, a non-crm model's partner_id readonly link still attempts get_record_default_action (scope check)", async () => {
    onRpc("res.partner", "get_record_default_action", () => {
        expect.step("get_record_default_action");
        return {
            type: "ir.actions.act_window",
            res_model: "res.partner",
            res_id: 1,
            views: [[false, "form"]],
            target: "current",
        };
    });
    await mountView({ resModel: "other.thing", type: "form", resId: 1, arch: FORM_ARCH });

    const setOffline = mockOffline();
    await setOffline(true);

    // Not this feature's guard to apply here: the href stays intact and
    // the click reaches `openRecordInAction` exactly as it would online.
    // `mockOffline()` fails the RPC itself (a real `ConnectionLostError`,
    // unrelated to this feature, same as the committed scope-check
    // convention in `crm_offline_relational_guards.test.js`), but the
    // call is still attempted -- this feature's guard would otherwise
    // return *before* ever calling `orm.call`.
    expect("a.o_form_uri").toHaveAttribute("href", "/odoo/res.partner/1");
    expect.errors(1);
    await contains("a.o_form_uri").click();
    expect.verifyErrors([
        `Connection to "/web/dataset/call_kw/res.partner/get_record_default_action" couldn't be established or was interrupted`,
    ]);
});
