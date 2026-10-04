# -*- coding: utf-8 -*-
# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.addons.crm.tests.common import TestCrmCommon
from odoo.tests import HttpCase, tagged


@tagged('post_install', '-at_install')
class TestCrmOffline(HttpCase, TestCrmCommon):
    """ VAL-E2E-001 (architecture.md §3.6 "Tours"): one
    `crm_offline_e2e_tour` run, at the mobile viewport every mobile
    behavior in this fork is gated on (AGENTS.md §3), covering the whole
    offline flow in a single pass -- pipeline online, open a lead, go
    offline (in-page simulation, see the tour file), edit the lead, create
    a lead through the mobile quick create, schedule an activity, mark the
    lead won, reconnect -- then asserting every effect on the server here,
    in Python, the same way `test_crm_offline.py`'s replay tests do.

    This class intentionally shares its name with the other two
    `TestCrmOffline` classes already in this package (`test_crm_offline.py`,
    a plain `TestCrmCommon`; `test_crm_offline_webmanifest.py`, an
    `HttpCaseWithUserDemo`): `odoo/tests/tag_selector.py` matches
    `--test-tags` by class name only, independent of the file that defines
    it, so `./scripts/dev/test-py.sh TestCrmOffline` already runs all three
    without needing a new tag or a rename.
    """
    browser_size = '375x667'
    touch_enabled = True

    def test_offline_e2e_tour(self):
        # One lead, assigned to admin (who runs the tour) and in the first
        # pipeline stage: `crm_lead_action_pipeline`'s context filters to
        # 'assigned to me', and a lone card keeps every tour step
        # unambiguous -- `test_crm_ui.py`'s propagation test clears leads
        # for the same reason.
        self.env['crm.lead'].search([]).unlink()
        admin = self.env['res.users'].search([('login', '=', 'admin')])
        # Not `crm.stage_lead1` (the demo "New" stage): setUpClass pushes
        # every demo stage's sequence to 9999 ("ensure search will find
        # test data first"), so it would land last, not first, in the
        # pipeline. `stage_team1_1` is this package's own first-sequence
        # stage, scoped to `sales_team_1` -- the same pairing
        # test_crm_offline.py's replay tests already use.
        stage_new = self.stage_team1_1
        lead = self.env['crm.lead'].create({
            'name': 'Offline Tour Lead',
            'type': 'opportunity',
            'user_id': admin.id,
            'team_id': self.sales_team_1.id,
            'stage_id': stage_new.id,
        })

        self.start_tour("/odoo", "crm_offline_e2e_tour", login="admin", timeout=120)

        # 1) The queued web_save edit replayed on reconnect.
        lead.invalidate_recordset()
        self.assertEqual(
            lead.name, 'Offline Tour Lead - edited offline',
            "the offline edit queued while offline must have replayed on reconnect",
        )

        # 2) The queued create from the mobile quick create replayed,
        # landed as an opportunity (crm_lead_action_pipeline's
        # default_type context, since the quick create's own vals never
        # set `type`), with every field the sheet collected.
        quick_create_lead = self.env['crm.lead'].search([
            ('name', '=', 'Offline Quick Create Lead'),
        ])
        self.assertEqual(len(quick_create_lead), 1, "the offline quick-create lead must have synced")
        self.assertEqual(quick_create_lead.type, 'opportunity')
        self.assertEqual(quick_create_lead.contact_name, 'Jane Tourist')
        self.assertEqual(quick_create_lead.phone, '+1 555 0100')
        self.assertEqual(quick_create_lead.email_from, 'jane.tourist@example.com')
        self.assertEqual(quick_create_lead.expected_revenue, 1234.0)
        self.assertEqual(quick_create_lead.stage_id, stage_new)

        # 3) The queued mail.activity.create replayed, linked to the
        # original lead through res_model/res_id (not a relational field
        # the queue would need to remap, architecture.md §2).
        activity = self.env['mail.activity'].search([
            ('res_model', '=', 'crm.lead'),
            ('res_id', '=', lead.id),
            ('summary', '=', 'Offline tour follow-up'),
        ])
        self.assertEqual(len(activity), 1, "the offline-scheduled activity must have synced")
        self.assertEqual(activity.user_id, admin)

        # 4) The queued action_set_won replayed: won stage, full
        # probability, won_status -- the same outcome an online "Won"
        # click gives (test_crm_offline.py's replay test asserts the same
        # triple for the bare action_set_won call this button queues).
        self.assertTrue(lead.stage_id.is_won)
        self.assertEqual(lead.probability, 100)
        self.assertEqual(lead.won_status, 'won')
