# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo import api, models


class MailActivity(models.Model):
    _inherit = "mail.activity"

    @api.model_create_multi
    def create(self, vals_list):
        """ The offline queue replays `mail.activity.create` verbatim
        (architecture.md §2: same model, method, args and kwargs, no
        onchange). The offline Schedule panel resolves `res_model` to the
        literal string 'crm.lead' client-side (it has no cheap way to look
        up the matching `ir.model` id without an extra round trip), but
        `res_model` is itself a field related to `res_model_id` -- leaving
        `res_model_id` unset would make the two inconsistent. Map it here
        for crm.lead only; every other model's create() is untouched.

        The `res_id` check (m5-fix-online-guards, VAL-REPO-013 clause (b))
        matters because `res_model` is `precompute=True, readonly=True`
        (addons/mail/models/mail_activity.py): `BaseModel.create` discards
        whatever value a caller puts in `vals['res_model']` before this
        override even runs, then recomputes it from `res_model_id` on the
        new record. So a bare `{'res_model': 'crm.lead'}` with no
        `res_model_id` and no `res_id` already resolves to
        `res_model=False` on its own, consistent with mail's SQL
        constraint `_check_res_id_is_set_if_model` (both empty) -- it
        creates an untracked activity, not an error. Mapping
        `res_model_id` from `res_model` alone, as this override used to,
        broke that: it made `res_model` recompute back to 'crm.lead' while
        `res_id` stayed unset, violating that same constraint with a
        `CheckViolation` on a create that never raised before this
        override existed. Requiring `res_id` here limits the map to the
        one shape that actually needs it (the Schedule panel's queued
        create, which always supplies a `res_id`), leaving every other
        input -- including one with no `res_id` -- to resolve exactly as
        it did before this override, or on eval/base, existed. """
        for vals in vals_list:
            if (
                vals.get('res_model') == 'crm.lead'
                and vals.get('res_id')
                and not vals.get('res_model_id')
            ):
                vals['res_model_id'] = self.env['ir.model']._get_id('crm.lead')
        return super().create(vals_list)

    def action_create_calendar_event(self):
        """ Small override of the action that creates a calendar.

        If the activity is linked to a crm.lead through the "opportunity_id" field, we include in
        the action context the default values used when scheduling a meeting from the crm.lead form
        view.
        e.g: It will set the partner_id of the crm.lead as default attendee of the meeting. """

        action = super(MailActivity, self).action_create_calendar_event()
        opportunity = self.calendar_event_id.opportunity_id
        if opportunity:
            opportunity_action_context = opportunity.action_schedule_meeting(smart_calendar=False).get('context', {})
            opportunity_action_context['initial_date'] = self.calendar_event_id.start

            action['context'].update(opportunity_action_context)

        return action
