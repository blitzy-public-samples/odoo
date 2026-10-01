import { defineMailModels } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
import { press } from "@odoo/hoot-dom";
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

/**
 * B8/B11/C7 (architecture.md §3.7, offline_inventory.md rows B8/B11/C7,
 * VAL-DIS-002): the AI-probability switch
 * (`<a type="object" name="action_set_automated_probability">`) exists
 * twice in `views/crm_lead_views.xml` -- once in the desktop layout
 * (`d-touch-none`, row B8) and once in the touch layout (`d-touch-flex`,
 * row B11) -- and its model method is `C7`. Reclassified to DISABLE by the
 * milestone-2 user review: predictive scoring is out of scope and the
 * probability only recomputes on the server, so no optimistic UI is
 * possible (unlike Restore/Won, there is nothing useful to mirror locally).
 *
 * Unlike the framework-owned `<button>`s guarded elsewhere in this
 * milestone, this control is a plain `<a>`:
 * `OfflinePlugin.SELECTORS_TO_DISABLE` only matches `button:not([data-
 * available-offline]):not([disabled])`, so the framework never touches it.
 * `CrmFormController.beforeExecuteActionButton` (already extended for B3/
 * C4's Restore button, `views/crm_form/crm_form.js`) must guard this
 * method too, and must return `false` *before* calling `super()`: the
 * base `FormController.beforeExecuteActionButton` unconditionally calls
 * `record.save()` first for any non-"cancel" button click, so returning
 * late would still have queued/sent an unwanted `web_save` as a side
 * effect of a probability switch that itself does nothing offline.
 * `CrmFormController` also toggles `o_disabled_offline` on the two `<a>`
 * nodes directly (not framework-owned), since nothing else gives this
 * plain anchor a visual offline-disabled state.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    won_status = fields.Char({ default: "pending" });
    is_automated_probability = fields.Boolean({ default: false });
    automated_probability = fields.Float({ default: 42 });
    probability = fields.Float({ default: 10 });

    _records = [
        {
            id: 1,
            name: "Lead 1",
            won_status: "pending",
            is_automated_probability: false,
            automated_probability: 42,
            probability: 10,
        },
    ];

    action_set_automated_probability() {
        for (const lead of this) {
            lead.probability = lead.automated_probability;
            lead.is_automated_probability = true;
        }
    }
}

defineModels([Lead]);
defineMailModels();

const AI_SWITCH = "a[name='action_set_automated_probability']";

// Copies of the two occurrences in `views/crm_lead_views.xml` (desktop
// `h2`/B8 and touch `group`/B11), trimmed to what this test needs.
const desktopFormView = {
    resModel: "crm.lead",
    type: "form",
    resId: 1,
    arch: `
        <form js_class="crm_form">
            <field name="won_status" invisible="1"/>
            <field name="is_automated_probability" invisible="1"/>
            <field name="name"/>
            <h2 class="d-none d-sm-flex d-touch-none">
                <div class="col-auto d-flex flex-column">
                    <div>
                        <a class="border-0 mx-2 p-0 mb-1 mb-md-0 btn btn-light"
                            name="action_set_automated_probability"
                            role="button" type="object"
                            invisible="is_automated_probability or won_status == 'lost'">
                            <img class="o_lead_opportunity_form_AI_switch_img" alt="AI"/>
                        </a>
                        <field class="w-auto" name="automated_probability" force_save="1"/>
                    </div>
                    <field name="probability" widget="float"/>
                </div>
            </h2>
        </form>`,
};

const touchFormView = {
    resModel: "crm.lead",
    type: "form",
    resId: 1,
    arch: `
        <form js_class="crm_form">
            <field name="won_status" invisible="1"/>
            <field name="is_automated_probability" invisible="1"/>
            <field name="name"/>
            <group class="d-flex d-sm-none d-touch-flex">
                <field name="probability" widget="float"/>
                <field name="automated_probability" force_save="1"/>
                <a class="btn btn-link p-0"
                    name="action_set_automated_probability"
                    role="button" type="object"
                    invisible="is_automated_probability or won_status == 'lost'">
                    <img class="o_lead_opportunity_form_AI_switch_img mx-1" alt="AI"/>
                </a>
            </group>
        </form>`,
};

// ---------------------------------------------------------------------------
// Desktop layout (B8), desktop preset.
// ---------------------------------------------------------------------------

test.tags("desktop");
test("offline, clicking the AI switch (desktop layout) issues no RPC, queues nothing, and does not save", async () => {
    onRpc("crm.lead", "action_set_automated_probability", () =>
        expect.step("action_set_automated_probability")
    );
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountView(desktopFormView);

    expect(AI_SWITCH).not.toHaveClass("o_disabled_offline");

    // Dirty the record first: the base `beforeExecuteActionButton` saves
    // unconditionally before running the button's action, so a guard that
    // let that save through would still queue a `web_save` as a side
    // effect even though `action_set_automated_probability` itself never
    // runs.
    await contains(".o_field_widget[name=name] input").edit("Changed name");

    const setOffline = mockOffline();
    await setOffline(true);
    expect(AI_SWITCH).toHaveClass("o_disabled_offline");

    await contains(AI_SWITCH).click();

    expect.verifySteps([]); // neither action_set_automated_probability nor web_save fired
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
    expect(AI_SWITCH).not.toHaveClass("o_disabled_offline");
});

test.tags("desktop");
test("offline, pressing Enter on the focused AI switch (desktop layout) issues no RPC and queues nothing", async () => {
    onRpc("crm.lead", "action_set_automated_probability", () =>
        expect.step("action_set_automated_probability")
    );
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountView(desktopFormView);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(AI_SWITCH).focus();
    await press("Enter");

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
});

test.tags("desktop");
test("online, clicking the AI switch (desktop layout) still calls action_set_automated_probability (guard)", async () => {
    onRpc("crm.lead", "action_set_automated_probability", ({ parent }) => {
        expect.step("action_set_automated_probability");
        return parent();
    });
    await mountView(desktopFormView);

    expect(AI_SWITCH).not.toHaveClass("o_disabled_offline");
    await contains(AI_SWITCH).click();

    expect.verifySteps(["action_set_automated_probability"]);
});

// ---------------------------------------------------------------------------
// Touch layout (B11), mobile preset.
// ---------------------------------------------------------------------------

test.tags("mobile");
test("offline, clicking the AI switch (touch layout) issues no RPC, queues nothing, and does not save", async () => {
    onRpc("crm.lead", "action_set_automated_probability", () =>
        expect.step("action_set_automated_probability")
    );
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountView(touchFormView);

    expect(AI_SWITCH).not.toHaveClass("o_disabled_offline");

    await contains(".o_field_widget[name=name] input").edit("Changed name");

    const setOffline = mockOffline();
    await setOffline(true);
    expect(AI_SWITCH).toHaveClass("o_disabled_offline");

    await contains(AI_SWITCH).click();

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
    expect(".o_notification").toHaveCount(0);

    await setOffline(false);
    expect(AI_SWITCH).not.toHaveClass("o_disabled_offline");
});

test.tags("mobile");
test("offline, pressing Enter on the focused AI switch (touch layout) issues no RPC and queues nothing", async () => {
    onRpc("crm.lead", "action_set_automated_probability", () =>
        expect.step("action_set_automated_probability")
    );
    onRpc("crm.lead", "web_save", () => expect.step("web_save"));
    await mountView(touchFormView);

    const setOffline = mockOffline();
    await setOffline(true);

    await contains(AI_SWITCH).focus();
    await press("Enter");

    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync())).toEqual([]);
});

test.tags("mobile");
test("online, clicking the AI switch (touch layout) still calls action_set_automated_probability (guard)", async () => {
    onRpc("crm.lead", "action_set_automated_probability", ({ parent }) => {
        expect.step("action_set_automated_probability");
        return parent();
    });
    await mountView(touchFormView);

    expect(AI_SWITCH).not.toHaveClass("o_disabled_offline");
    await contains(AI_SWITCH).click();

    expect.verifySteps(["action_set_automated_probability"]);
});
