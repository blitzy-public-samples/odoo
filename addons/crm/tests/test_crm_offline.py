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

    def test_web_save_queued_lead_edit_equals_online_write(self):
        """ VAL-DATA-018 (architecture.md §3.3 "Leads/stages/teams reads,
        edits, creates, stage moves: framework already covers them -- prove
        with tests, don't reimplement"): the JS-side proof
        (crm_offline_data_queue_replay.test.js's "offline, editing several
        fields of a lead ... queues one web_save") already shows an
        ordinary offline edit of several lead fields -- not the
        email/phone force-save defect's special case covered above -- gets
        queued as a plain `web_save`. This is the server-side half: that
        replaying such a queued call verbatim, with no sudo (as the
        salesperson assigned to the lead, the access an offline user
        actually has), leaves the lead -- and the partner it still
        propagates email/phone to -- in exactly the same state an online
        write of the identical vals would.
        """
        partner_online = self.env['res.partner'].create({'name': 'Queued Edit Partner (online)'})
        partner_offline = self.env['res.partner'].create({'name': 'Queued Edit Partner (offline)'})
        lead_values = {
            'name': 'Queued Edit Lead',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        }
        online_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_online.id})
        offline_lead = self.env['crm.lead'].create({**lead_values, 'partner_id': partner_offline.id})

        # An ordinary user-initiated edit (not the force-copy path): the
        # user directly changes description, expected_revenue and the
        # lead's own email_from/phone.
        changes = {
            'description': 'Edited through the offline queue',
            'expected_revenue': 4242.0,
            'email_from': 'queued.edit@test.example.com',
            'phone': '+1 202 555 0099',
        }

        salesman_online = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(online_lead.id)
        salesman_offline = self.env['crm.lead'].with_user(self.user_sales_salesman).browse(offline_lead.id)

        # Online: the client issues web_save immediately.
        salesman_online.web_save(changes, {})
        # Offline: the identical call -- same model, method, same args and
        # kwargs, no onchange, no field merge (architecture.md §2) -- is
        # instead queued and replayed verbatim on reconnect.
        salesman_offline.web_save(changes, {})

        self.assertEqual(online_lead.description, offline_lead.description)
        self.assertEqual(online_lead.expected_revenue, offline_lead.expected_revenue)
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
        self.assertEqual(online_lead.partner_id.email, online_lead.email_from)
        self.assertEqual(online_lead.partner_id.phone, online_lead.phone)

    def test_action_restore_replay_restores_lead_like_online(self):
        """ B3/C4 (architecture.md §3.7, offline_inventory.md rows B3/C4,
        VAL-QUEUE-006): the offline "Restore" button
        (crm_form.js's `CrmFormController._queueRestoreOffline`) queues a
        bare `crm.lead.action_restore([[id]])` -- no onchange, no id
        remapping, nothing else. Replaying that queued call verbatim, with
        no sudo (as the salesman who owns the lead, same access rights an
        offline user would have), must leave the lead exactly as restoring
        it online would: active again, and its probability reset to its
        (freshly recomputed) automated probability -- not merely
        unarchived, which `action_unarchive` alone would already do.
        """
        lead = self.env['crm.lead'].create({
            'name': 'Lost Lead For Restore',
            'type': 'opportunity',
            'team_id': self.sales_team_1.id,
            'user_id': self.user_sales_salesman.id,
            'stage_id': self.stage_team1_1.id,
        })
        lead.action_set_lost()
        self.assertFalse(lead.active)
        self.assertEqual(lead.probability, 0)

        # Replay exactly as `_syncORM` replays the queued `[[id]]` call:
        # same model, method, args -- no sudo.
        self.env['crm.lead'].with_user(self.user_sales_salesman).browse(lead.ids).action_restore()
        lead.invalidate_recordset()

        self.assertTrue(lead.active)
        self.assertEqual(
            lead.probability, lead.automated_probability,
            'Restoring a lead must reset its probability to the (recomputed) '
            'automated probability, the same result an online Restore gives'
        )
