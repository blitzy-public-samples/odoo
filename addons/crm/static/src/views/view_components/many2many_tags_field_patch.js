import { effect, onWillDestroy } from "@odoo/owl";
import { Many2ManyTagsField } from "@web/views/fields/many2many_tags/many2many_tags_field";
import { patch } from "@web/core/utils/patch";
import { useCrmOffline } from "@crm/mobile/offline_hooks/offline_hooks";

/**
 * B55/BR1/BR3/BR11 (VAL-DIS-019): `tag_ids`' color-edit popover
 * (`on_tag_click="edit_color"`) and its "Hide in Kanban" checkbox write
 * `crm.tag` directly (`switchTagColor`/`onTagVisibilityChange`,
 * `many2many_tags_field.js`), never `crm.lead`/`crm.stage`/`crm.team`, so
 * neither is a producer the offline queue covers (architecture.md
 * §3.7) -- DISABLE.
 *
 * One component, `Many2ManyTagsField`, backs all three view occurrences
 * (`crm_lead_views.xml` lead form `:245`, Leads list `:353`, Opportunities
 * list `:753`): `onTagClick`'s own `!this.props.record.isInEdition` guard
 * already keeps the two list occurrences (BR1/BR3) closed offline, as a
 * side effect of `list_renderer_offline_patch.js` -- a selected crm.lead
 * row's cell click never reaches `enterEditMode()` offline
 * (`CELL_EDIT_DISABLED_MODELS`, VAL-DIS-030), so `isInEdition` never
 * becomes true in the first place. The lead *form*'s record is always
 * `isInEdition` (an existing record open in a non-readonly form), so B55's
 * occurrence needs its own guard here.
 *
 * `switchTagColor` and `onTagVisibilityChange` (B55/BR11's "Hide in
 * Kanban") are guarded independently of `onTagClick`, for the
 * popover-already-open-before-offline case: the popover is opened online
 * (always possible on the form), the connection then drops while it is
 * still open, and its color-list / checkbox callbacks were bound once at
 * open time (`this.switchTagColor.bind(this)`) -- they never re-check
 * `onTagClick`. Same reasoning as `group_config_menu_patch.js`'s
 * handler-level guard for an already-open dropdown.
 *
 * Scrutiny finding 20 (VAL-DIS-019): blocking the write is not enough on
 * its own. The popover's `ColorList` buttons are plain `<button>`s, so the
 * framework disables them when the connection drops (proportionate
 * proof); but the "Hide in Kanban" `<CheckBox>` renders a plain
 * `<input type="checkbox">`, which the framework's button-only selector
 * never matches, so without more it would stay enabled and keep toggling
 * its own checked state in the DOM -- nothing is written, but the control
 * itself is neither "disabled" nor "absent", the two outcomes the shared
 * DISABLE convention allows. `Many2ManyTagsFieldColorListPopover` is not
 * exported, so it cannot be patched directly to add a `disabled` prop to
 * its `<CheckBox>`; closing the (exported) popover handle itself instead
 * removes the whole control from the DOM, which satisfies "absent". The
 * `effect()` below watches `isOffline()` and closes an open popover
 * reactively, so it also covers the already-open case, not just future
 * opens (which `onTagClick`'s own guard already blocks).
 *
 * Scoped to `crm.lead` so every other addon's `many2many_tags` field (e.g.
 * project tags) is untouched, online or offline.
 */
patch(Many2ManyTagsField.prototype, {
    setup() {
        super.setup();
        this.crmOffline = useCrmOffline();
        const disposeTagPopoverEffect = effect(() => {
            if (this.isCrmLeadTags && this.crmOffline.isOffline() && this.popover.isOpen) {
                this.popover.close();
            }
        });
        onWillDestroy(disposeTagPopoverEffect);
    },

    get isCrmLeadTags() {
        return this.props.record.resModel === "crm.lead";
    },

    onTagClick(ev, record) {
        if (this.isCrmLeadTags && this.crmOffline.isOffline()) {
            return;
        }
        return super.onTagClick(...arguments);
    },

    switchTagColor(colorIndex, tag) {
        if (this.isCrmLeadTags && this.crmOffline.isOffline()) {
            return;
        }
        return super.switchTagColor(...arguments);
    },

    onTagVisibilityChange(isHidden, tag) {
        if (this.isCrmLeadTags && this.crmOffline.isOffline()) {
            return;
        }
        return super.onTagVisibilityChange(...arguments);
    },
});
