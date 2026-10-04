import { defineMailModels, patchUiSize, SIZES, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, test, waitFor } from "@odoo/hoot";
import { runAllTimers } from "@odoo/hoot-mock";
import {
    contains,
    defineModels,
    fields,
    getService,
    models,
    mountView,
    onRpc,
} from "@web/../tests/web_test_helpers";
import { OfflinePlugin } from "@web/core/offline/offline_plugin";
import { mockCrmOffline } from "@crm/../tests/mock_server/crm_offline_test_helpers";
import { ResPartner } from "@mail/../tests/mock_server/mock_models/res_partner";

// The small-screen picker (`SelectCreateDialog`) renders `resModel` as a
// kanban (`SelectCreateDialog.viewProps` picks `kanban` under `isSmall`),
// which needs a `card` template -- `defineMailModels()`'s own
// `ResPartner` mock model has no `_views` of its own. Setting it directly
// on the imported class (not redeclaring the model, which would conflict
// with `defineMailModels()`'s own registration -- see
// `crm_offline_utm_campaign.test.js`) is test-scoped, like every other
// `X._views = ...`/`X._records.push(...)` mutation this suite's sibling
// files already do on framework mock models.
const PARTNER_KANBAN_ARCH = `
    <kanban>
        <templates>
            <t t-name="card">
                <field name="name"/>
            </t>
        </templates>
    </kanban>`;

/**
 * m3-contact-lookup (VAL-DATA-021, architecture.md §3.3 "Contact lookup":
 * "the lead's partner many2one searches/reads offline via the existing
 * many2x cache; no create option offline (web already hides it -- prove
 * it)"). No production code change: the whole mechanism is
 * `Many2XAutocomplete.search()`/`OfflinePlugin.cacheMany2XSearch`/
 * `searchMany2XRecords` (`addons/web/static/src/views/fields/
 * relational_utils.js:349-368`, `addons/web/static/src/core/offline/
 * offline_plugin.js:297-312`), already exercised generically for
 * `team_id`/`tag_ids` by `crm_offline_relational_suggestions.test.js`
 * (VAL-DIS-020). That file only ever asserts the *absence* of the
 * Create/Create-and-edit/Search-more suggestions offline; it never needed
 * two records to tell a cache *hit* from a cache *miss*, because its
 * point was the create-suggestion gate, not the search results
 * themselves. This file adds that: one partner cached by an earlier
 * online search is found offline, a second, never-searched-for partner is
 * not, with no create path and no error either way, and selecting the
 * cached one queues the lead's `web_save` with the new `partner_id` --
 * the "selecting the cached partner sets the field and the save is
 * queued" half of VAL-DATA-021 that no earlier file covers either.
 *
 * `patchUiSize({ size: SIZES.LG })` forces the desktop typing-and-
 * dropdown template (`web.Many2XAutocomplete`'s `t-if="uiService.isSmall
 * and props.dropdown"` branch is only taken under SM) regardless of
 * which Hoot preset runs this file, the same technique
 * `crm_offline_relational_suggestions.test.js`'s small-screen test uses
 * in the other direction -- so the single test below is "one test for
 * both presets" rather than a `test.tags("desktop")` pair.
 *
 * On a small screen, before m3-mobile-contact-lookup, the field instead
 * swapped to a read-only input whose tap opens `SelectCreateDialog`
 * through `onSearchMore()`, a *different* control that lists `resModel`
 * through the dialog's own kanban view (`SelectCreateDialog.viewProps`
 * picks `kanban` under `isSmall`, never a list) and its own
 * `web_search_read` (never `web_name_search`), so it never reached
 * `cacheMany2XSearch`/`searchMany2XRecords` at all -- offline, that left
 * phones unable to look up a contact (mission.md, VAL-DATA-021).
 * `many2x_autocomplete_offline_patch.js` fixes that for `crm.lead`'s own
 * `partner_id`: offline, on a small screen, the template falls back to
 * this same typed branch instead, proved by the two small-screen tests
 * appended below. This LG-forced test still documents the desktop
 * template (and, unaffected by that patch, the small-screen *online*
 * picker dialog -- the production patch only changes the *offline*
 * branch), including that dialog's own offline behavior (its "Create
 * New" button disabled by the framework's generic
 * `SELECTORS_TO_DISABLE`), already proved for the same shared
 * `Many2XAutocomplete` by `crm_offline_relational_suggestions.test.js`'s
 * third test and not duplicated here.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    partner_id = fields.Many2one({ relation: "res.partner" });

    _records = [
        { id: 1, name: "First lead", partner_id: false },
        // A second, separately-visited record stands in for the
        // pipeline's quick-create dialog below: a different lead, never
        // opened before, whose `partner_id` goes through the exact same
        // patched `Many2XAutocomplete`/template.
        { id: 2, name: "Second lead", partner_id: false },
    ];
}

defineModels([Lead]);
defineMailModels();

// `search_threshold: 1` (`many2one_field.js:90`, read into
// `Many2XAutocomplete`'s `searchThreshold` prop, default 0) matters here
// specifically: with the default 0, merely opening the dropdown on an
// empty input (the `click()` below) already issues a blank-name
// `web_name_search`, which `name_search`'s own `!name || ...` matches
// *every* record regardless of query -- caching "Ready Mat" as a side
// effect before this test ever types anything, and defeating the whole
// cached-vs-uncached comparison. At threshold 1 the empty click's
// request length (0) stays below it, so it shows only the "Start typing"
// placeholder and searches nothing.
const FORM_ARCH = `
    <form>
        <field name="name"/>
        <field name="partner_id" options="{'search_threshold': 1}"/>
    </form>`;

test("offline, the lead's partner_id finds a partner cached by an earlier online search but not an uncached one, offers no create option, and queues the save when the cached partner is selected", async () => {
    await patchUiSize({ size: SIZES.LG });

    const pyEnv = await startServer();
    const [decoId] = pyEnv["res.partner"].create([{ name: "Deco Addict" }, { name: "Ready Mat" }]);

    onRpc("res.partner", "name_create", () => expect.step("name_create"));
    onRpc("crm.lead", "web_save", () => expect.step("web_save")); // never reached offline: mockOffline fails the transport before the mock route runs

    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    // Online: searching "Deco" matches and caches only "Deco Addict"
    // ("Ready Mat" doesn't match, so it is never cached by this search).
    await contains("[name='partner_id'] input").click();
    await contains("[name='partner_id'] input").edit("Deco", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Deco Addict')").toHaveCount(1);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Offline: a *different* query than the one just run online
    // ("Addict", not "Deco") still matches the same cached partner --
    // proving the IndexedDB-backed `searchMany2XRecords` fallback
    // (triggered by `web_name_search`'s `ConnectionLostError`), not just
    // `memoizedSearch()`'s own same-text JS shortcut -- with no create
    // option.
    await contains("[name='partner_id'] input").edit("Addict", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Deco Addict')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);
    expect(".o-autocomplete--dropdown-item:contains('Create and edit')").toHaveCount(0);

    // Offline: a query matching only the partner that was never searched
    // for online (so never cached) finds nothing -- the many2x cache
    // only knows what it was told while online, not the whole table.
    await contains("[name='partner_id'] input").edit("Ready", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Ready')").toHaveCount(0);
    expect(".o-autocomplete--dropdown-item:contains('No records')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);

    // No RPC was issued or queued by any of the searches above (no error
    // dialog or uncaught error either -- an unexpected one would fail
    // the test since it isn't declared with `expect.errors`).
    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);

    // Selecting the cached partner sets the field, and saving queues the
    // lead's web_save with the new partner_id -- replayed verbatim like
    // any other offline edit (`crm_offline_data_queue_replay.test.js`
    // already proves that replay step; not repeated here).
    await contains("[name='partner_id'] input").edit("Addict", { confirm: false });
    await runAllTimers();
    await contains(".o-autocomplete--dropdown-item:contains('Deco Addict')").click();
    expect("[name='partner_id'] input").toHaveValue("Deco Addict");

    await contains("button.o_form_button_save").click();
    expect.verifySteps([]); // not sent while offline

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1].partner_id).toBe(decoId);

    // Online guard: the save replays, and the previously-uncached partner
    // is now reachable by a fresh online search (sanity that nothing
    // above left the field's normal online behavior broken).
    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save"]);
    await contains("[name='partner_id'] input").edit("Ready", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Ready Mat')").toHaveCount(1);
});

// ---------------------------------------------------------------------------
// m3-mobile-contact-lookup (VAL-DATA-021 "Both presets", mission.md "a
// salesperson on a phone ... can ... look up contacts"). `patchUiSize`
// forces SM so each test below runs the small-screen template
// identically whichever Hoot preset executes it -- "one test for both
// presets" the same way the test above forces LG for the opposite
// branch. `many2x_autocomplete_offline_patch.js`/`.xml` are the only
// production change these two tests cover; see their own doc comments.
// ---------------------------------------------------------------------------

test("offline, on a small screen, the lead's partner_id drops the picker for typed search, finds only cached partners, offers no create option, issues no RPC and queues partner_id on save; online the picker is back", async () => {
    await patchUiSize({ size: SIZES.SM });
    ResPartner._views = { kanban: PARTNER_KANBAN_ARCH };

    const pyEnv = await startServer();
    const [decoId] = pyEnv["res.partner"].create([{ name: "Deco Addict" }, { name: "Ready Mat" }]);

    onRpc("res.partner", "name_create", () => expect.step("name_create"));
    onRpc("crm.lead", "web_save", () => expect.step("web_save")); // never reached offline

    await mountView({ resModel: "crm.lead", type: "form", resId: 1, arch: FORM_ARCH });

    // Online, small screen: unchanged. The field is still the
    // framework's read-only input, and tapping it still opens the
    // picker dialog (`onSearchMore` -> `SelectCreateDialog`), not the
    // typed search this feature adds -- only offline.
    expect("[name='partner_id'] input").toHaveAttribute("readonly");
    await contains("[name='partner_id'] input").click();
    await waitFor(".modal .o_select_create_dialog_content");
    await contains(".modal .o_form_button_cancel").click();
    expect(".modal").toHaveCount(0);

    // Seed the many2x cache the same way an earlier online search would:
    // `Many2XAutocomplete.search()` itself calls this exact
    // `OfflinePlugin.cacheMany2XSearch` on a successful `web_name_search`
    // (`relational_utils.js`) -- so this is that same framework API, not
    // a direct IndexedDB write, standing in for a search that would have
    // had to run through the typed branch this fix only reaches offline.
    const offlinePlugin = getService(OfflinePlugin);
    await offlinePlugin.cacheMany2XSearch("res.partner", [
        { id: decoId, display_name: "Deco Addict" },
    ]);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    // Offline, small screen: the read-only picker is gone -- the field
    // is now the typed `AutoComplete`, reaching the same
    // `searchMany2XRecords` fallback the LG test above exercises, with
    // the same cache-hit, cache-miss and no-create behavior.
    expect("[name='partner_id'] input").not.toHaveAttribute("readonly");
    await contains("[name='partner_id'] input").edit("Addict", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Deco Addict')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);
    expect(".o-autocomplete--dropdown-item:contains('Create and edit')").toHaveCount(0);

    await contains("[name='partner_id'] input").edit("Ready", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Ready')").toHaveCount(0);
    expect(".o-autocomplete--dropdown-item:contains('No records')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);

    // No RPC was issued or queued by any search above, and no modal was
    // reopened (the dialog this field used to open is out of the
    // picture entirely while this fix is active).
    expect.verifySteps([]);
    expect(Object.values(getService(OfflinePlugin)._ormToSync()).length).toBe(0);
    expect(".modal").toHaveCount(0);

    // Selecting the cached partner shows its real name -- never
    // "Unnamed", the dialog-selection fallback this fix sidesteps by
    // not using the dialog at all -- and saving queues it.
    await contains("[name='partner_id'] input").edit("Addict", { confirm: false });
    await runAllTimers();
    await contains(".o-autocomplete--dropdown-item:contains('Deco Addict')").click();
    expect("[name='partner_id'] input").toHaveValue("Deco Addict");

    await contains("button.o_form_button_save").click();
    expect.verifySteps([]); // not sent while offline

    const queued = Object.values(getService(OfflinePlugin)._ormToSync());
    expect(queued.length).toBe(1);
    const [{ value }] = queued;
    expect(value.model).toBe("crm.lead");
    expect(value.method).toBe("web_save");
    expect(value.args[0]).toEqual([1]);
    expect(value.args[1].partner_id).toBe(decoId);

    // Back online: the save replays and the read-only picker returns.
    await setOffline(false);
    await runAllTimers();
    expect.verifySteps(["web_save"]);
    expect("[name='partner_id'] input").toHaveAttribute("readonly");
    await contains("[name='partner_id'] input").click();
    await waitFor(".modal .o_select_create_dialog_content");
});

const QUICK_CREATE_PARTNER_ARCH = `
    <form>
        <field name="partner_id" placeholder="Contact" options="{'search_threshold': 1}"/>
    </form>`;

test("offline, on a small screen, the quick-create form's partner_id gets the same typed-search fix as the lead form's", async () => {
    await patchUiSize({ size: SIZES.SM });
    ResPartner._views = { kanban: PARTNER_KANBAN_ARCH };

    const pyEnv = await startServer();
    const [decoId] = pyEnv["res.partner"].create([{ name: "Deco Addict" }, { name: "Ready Mat" }]);

    onRpc("res.partner", "name_create", () => expect.step("name_create"));

    // Record 2: a different lead than the one the test above used, so
    // this exercises the quick-create form's own `partner_id` -- the
    // same `PartnerMany2XAutocomplete`/`Many2XAutocomplete` component,
    // reached through the quick-create dialog's own crm.lead form.
    await mountView({ resModel: "crm.lead", type: "form", resId: 2, arch: QUICK_CREATE_PARTNER_ARCH });

    expect("[name='partner_id'] input").toHaveAttribute("readonly");

    const offlinePlugin = getService(OfflinePlugin);
    await offlinePlugin.cacheMany2XSearch("res.partner", [
        { id: decoId, display_name: "Deco Addict" },
    ]);

    const setOffline = mockCrmOffline();
    await setOffline(true);

    expect("[name='partner_id'] input").not.toHaveAttribute("readonly");
    await contains("[name='partner_id'] input").edit("Addict", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('Deco Addict')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);

    await contains("[name='partner_id'] input").edit("Ready", { confirm: false });
    await runAllTimers();
    expect(".o-autocomplete--dropdown-item:contains('No records')").toHaveCount(1);
    expect(".o-autocomplete--dropdown-item:contains('Create')").toHaveCount(0);
    expect.verifySteps([]);

    await contains("[name='partner_id'] input").edit("Addict", { confirm: false });
    await runAllTimers();
    await contains(".o-autocomplete--dropdown-item:contains('Deco Addict')").click();
    expect("[name='partner_id'] input").toHaveValue("Deco Addict");

    await setOffline(false);
    await runAllTimers();
    expect("[name='partner_id'] input").toHaveAttribute("readonly");
});
