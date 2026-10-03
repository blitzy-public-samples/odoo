import { patch } from "@web/core/utils/patch";
import { Many2XAutocomplete } from "@web/views/fields/relational_utils";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * m3-mobile-contact-lookup (VAL-DATA-021). On a small screen,
 * `web.Many2XAutocomplete`'s template (`relational_utils.xml`) always
 * swaps the typed/suggestions UI for a single `readonly` input whose tap
 * opens `SelectCreateDialog` (`onSearchMore`). That dialog lists records
 * through the view's own `web_search_read`, which offline is only
 * answered from the RPC disk cache on an exact key hit (the lead's own
 * context -- `default_name`, `default_email`, ... -- is baked into that
 * key), and even then shows "Unnamed" after a selection
 * (`record.js`'s `_completeMany2OneValue`, by design: see its own
 * comment) because the dialog never goes through `web_name_search`. It
 * never reaches `OfflinePlugin`'s many2x cache at all: only the typed
 * `Many2XAutocomplete.search()` branch (`relational_utils.js`) falls
 * back to `searchMany2XRecords` on a `ConnectionLostError`, and only that
 * branch's `suggest()` already hides Create/Create-and-edit/Search-more
 * offline (`crm_offline_relational_suggestions.test.js` proves that part
 * generically). Offline on a phone, for the lead's own `partner_id`,
 * swap to that typed branch instead -- it is the one path that already
 * does everything VAL-DATA-021 asks for.
 *
 * Scoped narrowly on purpose: `crm.lead`'s `partner_id` only. Every
 * other many2one/many2many on every model, on every screen size, keeps
 * exactly the framework's own behavior -- online or offline.
 */
patch(Many2XAutocomplete.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
    },

    get crmUseTypedSearchOffline() {
        return (
            this.crmOffline.isOffline() &&
            this.env.model?.config?.resModel === "crm.lead" &&
            this.props.resModel === "res.partner"
        );
    },
});
