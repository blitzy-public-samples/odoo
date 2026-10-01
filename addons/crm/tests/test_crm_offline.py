# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.addons.crm.tests.common import TestCrmCommon


class TestCrmOffline(TestCrmCommon):
    """ Server-side proof of the offline-fixes milestone's central invariant
    (architecture.md §2, AGENTS.md §2): the queue stores and replays each
    offline write verbatim -- same model, method, args and kwargs, no
    onchange, no id remapping, no field merge. So applying a queued call on
    reconnect must leave the record in exactly the state an online write of
    the same values would.
    """

    def test_web_save_force_saved_email_phone_matches_online_write(self):
        """ crm_form.js's CrmFormRecord._save() override force-copies the
        lead's current email_from/phone into the record's changes whenever
        the partner still needs to be synced (partner_email_update /
        partner_phone_update), even though the user only touched another
        field (architecture.md §3.2 defect 2). That force-copy runs
        unconditionally, online and offline alike: offline, the resulting
        web_save call -- forced values included -- is simply queued instead
        of being sent immediately, then replayed verbatim on reconnect.

        This test proves that equivalence: replaying such a queued
        `web_save` (vals included) leaves the lead, and the partner it
        propagates to, in exactly the same state as an online write of the
        identical vals.
        """
        partner_online = self.env['res.partner'].create({'name': 'Force Save Partner (online)'})
        partner_offline = self.env['res.partner'].create({'name': 'Force Save Partner (offline)'})
        lead_values = {
            'name': 'Force Save Lead',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'email_from': 'fresh.lead.email@test.example.com',
            'phone': '+1 202 555 0002',
        }
        online_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_online.id})
        offline_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_offline.id})

        # Creating the lead with partner_id and email_from/phone together
        # already syncs the (blank) partner via the inverse methods. Void
        # the partner again to reproduce the "partner needs sync" state
        # crm_form.js checks before it force-copies email_from/phone --
        # test_crm_ui.py's tour test uses the same setup (create, then void
        # the partner) for the same reason.
        partner_online.write({'email': False, 'phone': False})
        partner_offline.write({'email': False, 'phone': False})

        # Sanity: both leads start identically, and the partner still needs
        # the sync crm_form.js checks before it force-copies email_from/phone
        # into the save it is about to issue (online) or queue (offline).
        self.assertTrue(online_lead.partner_email_update)
        self.assertTrue(online_lead.partner_phone_update)
        self.assertTrue(offline_lead.partner_email_update)
        self.assertTrue(offline_lead.partner_phone_update)
        self.assertEqual(online_lead.email_from, offline_lead.email_from)
        self.assertEqual(online_lead.phone, offline_lead.phone)

        # The vals crm_form.js actually sends: the field the user touched
        # (description) plus the unchanged, force-copied email_from/phone.
        online_changes = {
            'description': 'Edited while connected',
            'email_from': online_lead.email_from,
            'phone': online_lead.phone,
        }
        offline_changes = {
            'description': 'Edited while connected',
            'email_from': offline_lead.email_from,
            'phone': offline_lead.phone,
        }

        # Online: the client issues the web_save RPC immediately -- modeled
        # here as the plain write() web_save delegates to (see
        # addons/web/models/models.py BaseModel.web_save).
        online_lead.write(online_changes)
        # Offline: the identical call (same model, method, same args and
        # kwargs) is instead queued and replayed verbatim on reconnect.
        offline_lead.web_save(offline_changes, {})

        self.assertEqual(online_lead.description, offline_lead.description)
        self.assertEqual(online_lead.email_from, offline_lead.email_from)
        self.assertEqual(online_lead.phone, offline_lead.phone)
        self.assertEqual(
            online_lead.partner_id.email, offline_lead.partner_id.email,
            'Replaying the queued web_save must propagate the email to the '
            'partner exactly as an online write of the same vals would'
        )
        self.assertEqual(
            online_lead.partner_id.phone, offline_lead.partner_id.phone,
            'Replaying the queued web_save must propagate the phone to the '
            'partner exactly as an online write of the same vals would'
        )
        self.assertEqual(online_lead.partner_id.email, online_lead.email_from,
                          'Partner email should have moved away from its stale value')
        self.assertEqual(online_lead.partner_id.phone, online_lead.phone,
                          'Partner phone should have moved away from its stale value')
