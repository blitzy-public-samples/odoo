import { defineMailModels, patchUiSize, SIZES, startServer } from "@mail/../tests/mail_test_helpers";
import { expect, test } from "@odoo/hoot";
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
import { mockCrmOffline } from "@crm/../tests/crm_test_helpers";

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
 * both presets" rather than a `test.tags("desktop")` pair. This is a
 * deliberate scope choice, not an oversight: on a small screen the field
 * swaps to a read-only input whose tap opens `SelectCreateDialog` through
 * `onSearchMore()`, a *different* control that lists `resModel` through
 * the list view's own `web_search_read` (never `web_name_search`), so it
 * never reaches `cacheMany2XSearch`/`searchMany2XRecords` at all -- the
 * many2x cache this feature is about simply isn't the mechanism in play
 * there. That dialog's own offline behavior (its "Create New" button
 * disabled by the framework's generic `SELECTORS_TO_DISABLE`) is already
 * proved, for the same shared `Many2XAutocomplete`, by
 * `crm_offline_relational_suggestions.test.js`'s third test and is not
 * duplicated here.
 */

class Lead extends models.Model {
    _name = "crm.lead";

    name = fields.Char();
    partner_id = fields.Many2one({ relation: "res.partner" });

    _records = [{ id: 1, name: "First lead", partner_id: false }];
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
