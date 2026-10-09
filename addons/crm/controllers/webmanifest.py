# Part of Odoo. See LICENSE file for full copyright and licensing details.

from odoo.http import request

from odoo.addons.web.controllers import webmanifest


class WebManifest(webmanifest.WebManifest):

    def _has_share_target(self):
        return True

    def _crm_app_entry_present(self, shortcuts):
        """ Tell whether the parent listed the CRM app among ``shortcuts``.

        The parent only adds the CRM app entry for an authenticated user who
        can see the CRM root menu (salesman and manager groups), and returns
        no shortcut at all on ``AccessError`` (anonymous visitors). Using that
        entry as the single eligibility test keeps the parent's access checks
        authoritative: no extra privilege and no ``sudo()`` are needed, as
        ``env.ref`` only resolves the menu id.

        :param list shortcuts: shortcuts as returned by ``_get_shortcuts``
        :return: True when the CRM app entry is present
        :rtype: bool
        """
        if not shortcuts:
            return False
        root = request.env.ref('crm.crm_menu_root', raise_if_not_found=False)
        if not root:
            return False
        crm_app_url = f'/odoo?menu_id={root.id}'
        return any(shortcut.get('url') == crm_app_url for shortcut in shortcuts)

    def _get_shortcuts(self):
        """ Append the "My Pipeline" and "New Lead" shortcuts to the parent's.

        The parent's entries come first and stay untouched, the CRM app entry
        included. The CRM shortcuts follow in the parent's shape, and only
        when that entry is present and the user's web client can open the
        pipeline menu, so anonymous visitors, users without CRM access and
        users who cannot open the pipeline menu get exactly the parent's list.
        """
        shortcuts = super()._get_shortcuts()
        if not self._crm_app_entry_present(shortcuts):
            return shortcuts
        root = request.env.ref('crm.crm_menu_root')
        # "My Pipeline" opens through the legacy ``menu_id`` URL, which the
        # webclient resolves to the menu's action only among the menus it
        # loads (``load_menus``), and otherwise falls back to the default app.
        # A pipeline menu that is removed, archived or not visible to the user
        # (groups, hidden or archived parent, inaccessible action) leaves the
        # parent's shortcuts untouched rather than publishing a partial CRM set.
        pipeline_menu = request.env.ref('crm.menu_crm_opportunities', raise_if_not_found=False)
        if not pipeline_menu:
            return shortcuts
        user_menus = request.env['ir.ui.menu'].load_menus(request.session.debug)
        if not user_menus.get(pipeline_menu.id, {}).get('action_id'):
            return shortcuts
        shortcuts.append({
            'name': request.env._("My Pipeline"),
            'url': f'/odoo?menu_id={pipeline_menu.id}',
            'description': request.env._("Open your CRM pipeline"),
            'icons': [{
                'sizes': '100x100',
                'src': '/crm/static/description/icon.png',
                'type': 'image/png',
            }],
        })
        # "New Lead" opens the pipeline action's form view on a new record.
        shortcuts.append({
            'name': request.env._("New Lead"),
            'url': f'/odoo?menu_id={root.id}&action=crm.crm_lead_action_pipeline&view_type=form',
            'description': request.env._("Create a new lead"),
            'icons': [{
                'sizes': '100x100',
                'src': '/crm/static/description/icon.png',
                'type': 'image/png',
            }],
        })
        return shortcuts

    def _get_webmanifest(self):
        """ Point the main manifest's icons at the CRM app icon for CRM users.

        Only ``icons`` changes, and only when the CRM app entry is among the
        shortcuts: anonymous visitors and users without CRM keep the parent's
        Odoo icons. Every other key (name, scope, start_url, display, colors,
        shortcuts, share target) stays as the parent built it, and so do
        ``_icon_path`` (offline page, scoped apps) and every route.

        Serving the addon's own icon to CRM users is a product requirement and
        takes precedence over the generic Odoo icon set: with CRM installed,
        an authenticated CRM user gets the CRM icons by design. The 512px asset
        keeps the install-size icon the parent's set provides.
        """
        manifest = super()._get_webmanifest()
        if self._crm_app_entry_present(manifest.get('shortcuts', [])):
            manifest['icons'] = [
                {'src': '/crm/static/description/icon_hi.png', 'sizes': '512x512', 'type': 'image/png'},
                {'src': '/crm/static/description/icon.png', 'sizes': '100x100', 'type': 'image/png'},
            ]
        return manifest
