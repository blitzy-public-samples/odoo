import { fields, models } from "@web/../tests/web_test_helpers";

/**
 * Shared `crm.stage` mock for the offline test suite, so tests that need a
 * pipeline stage (rainbowman/won defects, kanban grouping, ...) can
 * `defineModels` it instead of redeclaring their own local model class. Add
 * fields here only when a test actually needs them.
 */
export class CrmStage extends models.ServerModel {
    _name = "crm.stage";

    sequence = fields.Integer({ string: "Sequence", default: 10 });
    is_won = fields.Boolean({ string: "Is Won" });
    team_ids = fields.Many2many({ string: "Sales Teams", relation: "crm.team" });
}
