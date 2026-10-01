import { Many2OneField } from "@web/views/fields/many2one/many2one_field";
import { Many2OneAvatarUserField } from "@mail/views/web/fields/many2one_avatar_user_field/many2one_avatar_user_field";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * BR10 (VAL-DIS-022): a many2one's own existing-record open/edit
 * navigation (`Many2One.openRecordInAction`, `many2one.js:233-258`) is a
 * mechanism distinct from `Many2XAutocomplete`'s create/search-more gate
 * (already hidden offline by the framework, `relational_utils.js`) and is
 * reached through two renderings of the same `canOpen` prop
 * (`many2one.xml:19-36`): the readonly `<a class="o_form_uri">` (any field
 * rendered readonly, including every many2one list column not in edit
 * mode) is not a `<button>`, so the framework's own
 * `SELECTORS_TO_DISABLE` never reaches it; the editable-mode `<button
 * class="o_external_button">` *is* a plain `<button>` without
 * `data-available-offline`, so the framework already disables it
 * (proportionate proof: a DOM-only test, no handler guard needed there).
 *
 * `Many2One` itself never sees the host record (only the already-computed
 * `relation`/`value`/`canOpen`/... props built by `computeM2OProps()`), so
 * the guard sits one level up, in the field-wrapper classes that call
 * `computeM2OProps(this.props)` and own `this.props.record`: `Many2OneField`
 * (the default "many2one" widget, web) and `Many2OneAvatarUserField` (the
 * "many2one_avatar_user" widget, mail -- an existing crm dependency).
 * Forcing `canOpen` false offline removes the `<a>` from the template
 * entirely (`t-if="this.props.canOpen"` -- "absent" per the DISABLE
 * semantics convention) and leaves the button unrendered too
 * (`hasLinkButton` requires `canOpen`), a strict subset of what the
 * framework's button-disable pass already does, so there is no regression
 * there. Patching `Many2OneAvatarUserField` also covers crm's own
 * `Many2OneAvatarLeaderUserField` (`js/fields/
 * many2one_avatar_leader_user.js`, the lead form's `user_id` widget),
 * which extends it and calls `super.m2oProps`.
 *
 * KNOWN-LIMIT (recorded in this feature's handoff): the lead form's
 * `partner_id` (`widget="res_partner_many2one"`) uses a third
 * field-wrapper class, `PartnerAutoCompleteMany2one`
 * (`partner_autocomplete` addon). `partner_autocomplete` is not in crm's
 * manifest `depends`; a static `import` of its module would be an
 * undeclared dependency and could break crm's whole asset bundle if that
 * addon is ever absent from an installation -- forbidden by the repo
 * AGENTS.md section 4 ("No new dependency"). Per this feature's stated
 * precedence, section 4 wins over architecture.md's BR10 ("every many2one
 * occurrence"): `partner_id`'s own-record-open link stays unguarded by
 * this patch, offline exactly as online.
 *
 * Scoped to crm's own models (the lead and the two conversion wizards
 * that render these two widgets with `canOpen` true) so every other
 * addon's many2one field is untouched, online or offline.
 */
const CRM_SCOPED_MODELS = [
    "crm.lead",
    "crm.merge.opportunity",
    "crm.lead2opportunity.partner.mass",
];

function disableRecordOpenOffline(FieldClass) {
    patch(FieldClass.prototype, {
        setup() {
            super.setup();
            this.crmOffline = useCrmOffline();
        },

        get m2oProps() {
            const props = super.m2oProps;
            if (
                this.crmOffline.isOffline() &&
                CRM_SCOPED_MODELS.includes(this.props.record.resModel)
            ) {
                return { ...props, canOpen: false };
            }
            return props;
        },
    });
}

disableRecordOpenOffline(Many2OneField);
disableRecordOpenOffline(Many2OneAvatarUserField);
