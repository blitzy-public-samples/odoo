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
        for crm.lead only; every other model's create() is untouched. """
        for vals in vals_list:
            if vals.get('res_model') == 'crm.lead' and not vals.get('res_model_id'):
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
