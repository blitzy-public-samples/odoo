# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.addons.web.controllers import webmanifest
from odoo.exceptions import AccessError
from odoo.http import request


class WebManifest(webmanifest.WebManifest):

    def _get_shortcuts(self):
        shortcuts = super()._get_shortcuts()
        env = request.env
        # Gate both CRM shortcuts on the CRM root menu, the same visibility
        # check web's own module shortcuts use (ir.ui.menu.get_user_roots()),
        # so a user who cannot open CRM from the app menu does not get a
        # shortcut to it either. Both menu ids are resolved from their XML
        # ids at request time (current user, current environment), never
        # hardcoded, so they always match whatever data update renumbered them.
        # get_user_roots() raises AccessError for a user with no read access
        # to ir.ui.menu at all (the public user: it has no ir.model.access
        # entry for the model), the same way the parent's own module-shortcut
        # lookup can raise for ir.module.module -- caught the same way.
        try:
            crm_menu_root = env.ref('crm.crm_menu_root', raise_if_not_found=False)
            has_crm_menu = bool(crm_menu_root) and crm_menu_root in env['ir.ui.menu'].get_user_roots()
        except AccessError:
            has_crm_menu = False
        if not has_crm_menu:
            return shortcuts
        icons = [{
            'sizes': '100x100',
            'src': '/crm/static/description/icon.png',
            'type': 'image/png',
        }]
        pipeline_menu = env.ref('crm.menu_crm_opportunities', raise_if_not_found=False)
        if pipeline_menu:
            shortcuts.append({
                'name': env._("My Pipeline"),
                'url': '/odoo?menu_id=%s' % pipeline_menu.id,
                'description': env._("Open your sales pipeline"),
                'icons': icons,
            })
        shortcuts.append({
            'name': env._("New Lead"),
            'url': '/odoo?menu_id=%s&action=crm&resId=new' % crm_menu_root.id,
            'description': env._("Create a new lead"),
            'icons': icons,
        })
        return shortcuts

    def _has_share_target(self):
        return True
