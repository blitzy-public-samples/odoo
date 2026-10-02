import { Many2One } from "@web/views/fields/many2one/many2one";
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
 * Two layers, for two different field-wrapper situations:
 *
 * 1. `Many2One` itself never sees the host record (only the
 *    already-computed `relation`/`value`/`canOpen`/... props built by
 *    `computeM2OProps()`), so for the two wrapper classes crm already
 *    knows about -- `Many2OneField` (the default "many2one" widget, web)
 *    and `Many2OneAvatarUserField` (the "many2one_avatar_user" widget,
 *    mail -- an existing crm dependency) -- `disableRecordOpenOffline()`
 *    patches *their* `m2oProps` getter, which does own `this.props.record`,
 *    and forces `canOpen` false offline. That removes the `<a>` from the
 *    template entirely (`t-if="this.props.canOpen"` -- "absent" per the
 *    DISABLE semantics convention) and leaves the button unrendered too
 *    (`hasLinkButton` requires `canOpen`), a strict subset of what the
 *    framework's button-disable pass already does for the button, so
 *    there is no regression there. Patching `Many2OneAvatarUserField`
 *    also covers crm's own `Many2OneAvatarLeaderUserField` (`js/fields/
 *    many2one_avatar_leader_user.js`, the lead form's `user_id` widget),
 *    which extends it and calls `super.m2oProps`.
 *
 * 2. The lead form's `partner_id` (`widget="res_partner_many2one"`) uses a
 *    third field-wrapper class, `PartnerAutoCompleteMany2one`
 *    (`partner_autocomplete` addon, not a crm dependency): it extends
 *    `Component` directly, not `Many2OneField`, and computes its own
 *    `m2oProps` from `computeM2OProps(this.props)` without going through
 *    either patched class above. Statically `import`ing that class to
 *    patch it the same way would be an undeclared dependency on an addon
 *    that may be absent from an installation -- forbidden by the repo
 *    AGENTS.md section 4 ("No new dependency"); per this feature's stated
 *    precedence, section 4 wins over architecture.md's BR10 ("every
 *    many2one occurrence"). What *is* a safe, already-existing crm
 *    dependency is `Many2One` itself (`addons/web`), which
 *    `PartnerAutoCompleteMany2one` reaches through its own
 *    `PartnerMany2One extends Many2One` (`partner_autocomplete_many2one.js`):
 *    patching `Many2One.prototype` reaches every many2one wrapper built on
 *    it, present or future, with no import of the wrapper class needed.
 *    `disableSharedRecordOpenOffline()` below patches `hasLinkButton`
 *    (hides the editable button, same as layer 1) and `openRecordInAction`
 *    (the method both the readonly `<a>` and the button's "action"/"tab"
 *    modes call) to no-op offline. `Many2One` has no `props.record`
 *    either, so scoping reads `this.env.model.config.resModel` instead --
 *    set by every view controller that can render a many2one
 *    (`useSubEnv({ model: this.model })` in `form_controller.js`,
 *    `form_renderer.js`, `list_controller.js`, `kanban_controller.js`) and
 *    inherited down to field components regardless of nesting depth,
 *    exactly like `RottingStatusBarDurationField` already reads
 *    `this.env.model.config.resModel` from a field widget
 *    (`mail/static/src/js/rotting_mixin/rotting_statusbar.js`).
 *
 *    This layer cannot reproduce layer 1's "absent" readonly link: the
 *    template's `t-if="this.props.canOpen"` reads the prop directly, and
 *    `Many2One` cannot override a prop handed to it by its parent, only
 *    its own methods. So for `partner_id` the readonly link stays
 *    *present* but inert offline (no RPC, no navigation) rather than
 *    disappearing -- which is exactly what this feature's own
 *    expectedBehavior asks for ("issues no get_record_default_action...
 *    and no navigation", not "is absent"), unlike BR10's "absent" wording
 *    used for the two fields layer 1 already covers.
 *
 *    Scrutiny finding 21 (VAL-DIS-022): "present but inert" still left
 *    one path open. `openRecordInAction` only guards the primary click
 *    (`t-on-click.prevent.stop`, `many2one.xml:24`); the same `<a
 *    href="...">` keeps its real `linkHref` value regardless, and a
 *    middle-click or the browser's "Open link in new tab" follows that
 *    `href` natively, bypassing the click handler (and this component)
 *    entirely. `linkHref` is patched here too, so the href itself is
 *    empty while scoped crm offline -- `t-att-href` then omits the
 *    attribute altogether, so there is nothing for a native navigation to
 *    follow. This still can't make the `<a>` itself absent (same
 *    `canOpen`-is-a-prop limit as above), but "no usable href" is exactly
 *    what this feature's expectedBehavior asks for.
 *
 *    Layer 2 is intentionally *not* a replacement for layer 1: removing
 *    the two `m2oProps` patches would regress `lost_reason_id`/`user_id`'s
 *    committed "absent" assertions in
 *    `crm_offline_relational_guards.test.js` (that file's own canOpen=
 *    false-via-props mechanism is the only way to make the *link* vanish
 *    from the DOM, not just stop navigating) -- so both layers run
 *    together, each covering what the other cannot.
 *
 * Scoped to crm's own models (the lead and the two conversion wizards
 * that render many2one fields with `canOpen` true) so every other addon's
 * many2one field is untouched, online or offline.
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

function disableSharedRecordOpenOffline(ComponentClass) {
    patch(ComponentClass.prototype, {
        setup() {
            super.setup();
            this.crmOffline = useCrmOffline();
        },

        get isCrmScopedOffline() {
            return (
                this.crmOffline.isOffline() &&
                CRM_SCOPED_MODELS.includes(this.env.model?.config?.resModel)
            );
        },

        get hasLinkButton() {
            if (this.isCrmScopedOffline) {
                return false;
            }
            return super.hasLinkButton;
        },

        get linkHref() {
            if (this.isCrmScopedOffline) {
                // `undefined` makes `t-att-href` omit the attribute
                // entirely (many2one.xml:24), so there is no href left for
                // a middle-click or "Open link in new tab" to follow.
                return undefined;
            }
            return super.linkHref;
        },

        async openRecordInAction(newWindow) {
            if (this.isCrmScopedOffline) {
                return;
            }
            return super.openRecordInAction(newWindow);
        },
    });
}

disableSharedRecordOpenOffline(Many2One);
