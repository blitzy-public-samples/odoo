# Project and services

Active contributors: Thibault, Christophe, Fabien (top authors of `addons/project` on `origin/20.0`, bots and translation imports excluded)

## Purpose

The project family is the 18 addons under `addons/` whose names start with `project`, plus the service-billing and timesheet addons that orbit it (`hr_timesheet`, `hr_timesheet_attendance`, `sale_project*`, `sale_service`, `sale_timesheet*`). `addons/project` owns projects, tasks, stages, milestones, and status updates. The rest glue tasks to accounting, purchases, stock, expenses, mail, and sales. Timesheets are not a model of their own: they are `account.analytic.line` rows extended with employee and task fields.

Three app families that upstream ships as enterprise apps are absent from this repository: `helpdesk` (support tickets), `field_service` / `industry_fsm` (on-site jobs), and `planning` (shift scheduling). The community building blocks here are `project` for tickets and jobs, `project_todo` for lightweight tasks, `hr_timesheet` for time capture, and `sale_service` / `sale_timesheet` for billing that time.

## Family contents

Real directories in `addons/`:

```text
project/                       Core: project.project, project.task, stages, milestones
project_account/               Auto-install: analytic items on projects
project_hr_expense/            Auto-install: expenses charged to projects
project_hr_skills/             Auto-install: employee skills on project tasks
project_mail_plugin/           Auto-install: create tasks from the mail plugin
project_mrp/                   Auto-install: tasks from manufacturing orders
project_mrp_account/           Auto-install: MRP project cost accounting
project_mrp_sale/              Auto-install: MRP tasks on sale orders
project_mrp_stock_landed_costs/ Auto-install: landed costs as project tasks
project_purchase/              Auto-install: purchase orders on projects
project_purchase_stock/        Auto-install: purchase + stock projects
project_sale_expense/          Auto-install: re-invoice project expenses on sales orders
project_sms/                   Auto-install: SMS from projects and tasks
project_stock/                 Auto-install: stock pickings on projects
project_stock_account/         Auto-install: stock project accounting
project_stock_landed_costs/    Auto-install: landed costs as project tasks
project_timesheet_holidays/    Auto-install: timesheets generated while on time off
project_todo/                  Auto-install: the To-Do app (tasks without a project)
hr_timesheet/                  Task Logs: timesheet fields on account.analytic.line
hr_timesheet_attendance/       Auto-install: timesheet/attendance reporting
sale_service/                  Marks sale order lines that are services
sale_project/                  Auto-install: service products create projects and tasks
sale_project_margin/           Auto-install: margins on projects sold through sales orders
sale_project_stock/            Auto-install: stock for service products
sale_project_stock_account/    Auto-install: stock service accounting
sale_timesheet/                Auto-install: bill timesheets on sales orders
sale_timesheet_margin/         Auto-install: service margins on timesheet orders
```

## Key models

| Model | Defined in | Role |
| --- | --- | --- |
| `project.project` | `addons/project/models/project_project.py` | A project: tasks, members, stage, alias, rating, and analytic distribution |
| `project.task` | `addons/project/models/project_task.py` | A task: stage, assignees, planned/allocated time, subtasks, recurrence |
| `project.task.type` | `addons/project/models/project_task_type.py` | Task stages, scoped per project |
| `project.project.stage` | `addons/project/models/project_project_stage.py` | Project-level stages |
| `project.task.stage.personal` | `addons/project/models/project_task_stage_personal.py` | A per-user override of a task's stage |
| `project.milestone` | `addons/project/models/project_milestone.py` | Billable milestones on a project |
| `project.update` | `addons/project/models/project_update.py` | Status updates with a status, progress, and a mail thread |
| `project.tags` | `addons/project/models/project_tags.py` | Task and project tags |
| `project.collaborator` | `addons/project/models/project_collaborator.py` | Project members with their access rights |
| `project.role` | `addons/project/models/project_role.py` | Roles assigned to collaborators |
| `project.task.recurrence` | `addons/project/models/project_task_recurrence.py` | Recurrence rules that clone tasks on a cron |
| `account.analytic.line` | extended in `addons/hr_timesheet/models/account_analytic_line.py` | The timesheet record: employee, task, project, job title, department |
| `project.sale.line.employee.map` | `addons/sale_timesheet/models/project_sale_line_employee_map.py` | Maps an employee to a sales order line for employee-rate billing |

## How it works

Projects and tasks. `project.project` mixes in `portal.mixin`, `mail.alias.mixin`, `rating.parent.mixin`, `mail.activity.mixin`, `mail.tracking.duration.mixin`, and `analytic.plan.fields.mixin` (`addons/project/models/project_project.py:28`). Its `alias_id` receives inbound email, and `_alias_get_creation_values()` points the alias at `project.task`, so email to a project address becomes a task. A project has both a task stage set (`project.task.type`, per project) and a project-level stage (`project.project.stage`, gated by `project.group_project_stages`). `project.task` carries a state selection whose closed values are `1_done` and `1_canceled` (`CLOSED_STATES` in `addons/project/models/project_task.py:85`) plus `stage_id`; `project.task.stage.personal` lets a user move a task to a personal stage without changing the shared one. Subtasks hang off `parent_id`, with `subtask_count` and `closed_subtask_count`; dependencies and recurrence live on the same model. `project.update` records periodic status with a `progress` percentage.

Timesheets. `addons/hr_timesheet` adds no model. It extends `account.analytic.line` with `task_id`, `project_id`, `employee_id`, `job_title`, `department_id`, `manager_id`, and `milestone_id` (`addons/hr_timesheet/models/account_analytic_line.py:59`), and `project.project.allow_timesheets` turns logging on per project. Because the record is an analytic line, timesheet reporting is analytic reporting, and approval is gated by `hr_timesheet.group_hr_timesheet_approver`.

Service billing. `addons/sale_service` adds `sale.order.line.is_service`, computed from `product_id.type == 'service'`, and a `_domain_sale_line_service()` helper that other service addons reuse. `addons/sale_project` puts the creation policy on `product.template`: `service_tracking` selects `no`, `task_global_project`, `task_in_project`, or `project_only`, and `service_policy` selects `ordered_prepaid`, `delivered_milestones` (when the milestone feature is on), or `delivered_manual` (`addons/sale_project/models/product_template.py`). On order confirmation, `sale.order.line._timesheet_create_project()` and `_timesheet_create_task()` create the project and task, honouring `project_template_id` and `task_template_id` when set. `project.project.allow_billable` and `project.project.sale_line_id` then link the project back to the order line.

Billing timesheets. `addons/sale_timesheet` binds `account.analytic.line.so_line` to a `sale.order.line` and exposes `sale.order.line.timesheet_ids`. A project's `pricing_type` is `task_rate`, `fixed_rate`, or `employee_rate` (`addons/sale_timesheet/models/project_project.py:28`); employee rate uses `project.sale.line.employee.map` to pick a sales order line per employee. `billing_type` is `not_billable` or `manually`, and delivered timesheets are invoiced onto the sales order. `sale_timesheet_margin` folds in margins.

To-dos. `project_todo` does not add a field or model: a to-do is a `project.task` with `project_id = False`. The addon adds a form view that hides the project field, auto-names tasks from the first line of the description (`addons/project_todo/models/project_task.py:11`), adds `action_convert_to_task()` to attach a to-do to a project, and splits the systray activity group into "To-Do" (no project) and "Task" (project) in `res.users._get_activity_groups()` (`addons/project_todo/models/res_users.py:9`).

Bridges. `project_account` adds a button on the project to open its analytic items; the `account_id` field it filters on comes from `analytic.plan.fields.mixin` on `project.project`. `project_purchase`, `project_stock`, `project_mrp`, and their `_account`/`_sale` variants attach purchasing, inventory, and manufacturing records to tasks; `project_hr_expense` and `project_sale_expense` route expenses; `project_hr_skills` shows employee skills on tasks; `project_mail_plugin` exposes projects and tasks to the mail plugin so an email can become a task; `project_timesheet_holidays` generates timesheet entries while an employee is on leave; `hr_timesheet_attendance` compares logged time with attendance.

## Integration points

- Accounting and analytics: `project_account`, `project_stock_account`, `project_mrp_account`; projects carry analytic distributions through `analytic.plan.fields.mixin`. See [Accounting](accounting.md).
- Sales: `sale_service`, `sale_project`, `sale_timesheet`, `sale_project_margin`; see [Sales suite](sales-suite.md).
- HR: `hr_timesheet` depends on `hr` and `project`, and `project_hr_expense`, `project_timesheet_holidays`, and `project_hr_skills` bridge back; see [HR suite](hr-suite.md).
- Inventory and manufacturing: `project_stock*`, `project_mrp*`, `project_purchase*`; see [Inventory and manufacturing](inventory-and-manufacturing.md).
- Mail and SMS: `mail.alias.mixin` on projects, `project_mail_plugin` for creating tasks from the mail plugin, `project_sms` for SMS from tasks. See [Mail](mail.md).
- Cron: `project.task.recurrence` clones tasks and the project stage fold logic runs on schedule; see [Cron and scheduled actions](../primitives/cron-and-scheduled-actions.md).

## Entry points for modification

Start from `addons/project/models/project_project.py` and `addons/project/models/project_task.py`. To change what a task can do, add fields on `project.task` and reuse the `state`/`stage_id` split rather than inventing a new state machine. To add a source of tasks, follow the shape of `addons/project_purchase`: depend on `project` and the other addon, and add a `task_id` many2one on the foreign model. To add a timesheet-adjacent behavior, extend `account.analytic.line` from a module that depends on `hr_timesheet`, as `addons/hr_timesheet_attendance` does. New models must be imported in `models/__init__.py`, and new XML data files added to the manifest `data` list in dependency order. In this fork, service and project code is only reached from `addons/crm` through extension points; see [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md).

## Key source files

| File | Purpose |
| --- | --- |
| `addons/project/__manifest__.py` | Project manifest: dependencies and data order |
| `addons/project/models/project_project.py` | `project.project` (1,414 lines) |
| `addons/project/models/project_task.py` | `project.task`, states, stages, subtasks |
| `addons/project/models/project_task_type.py` | `project.task.type` stages |
| `addons/project/models/project_project_stage.py` | `project.project.stage` |
| `addons/project/models/project_milestone.py` | `project.milestone` |
| `addons/project/models/project_update.py` | `project.update` status reports |
| `addons/project/models/project_task_recurrence.py` | Task recurrence rules |
| `addons/hr_timesheet/models/account_analytic_line.py` | Timesheet fields on analytic lines |
| `addons/hr_timesheet/models/project_project.py` | `allow_timesheets` on projects |
| `addons/sale_service/models/sale_order_line.py` | `sale.order.line.is_service` |
| `addons/sale_project/models/product_template.py` | `service_tracking` and `service_policy` |
| `addons/sale_project/models/sale_order_line.py` | Project/task creation from an order line |
| `addons/sale_timesheet/models/project_project.py` | `pricing_type`, `billing_type` |
| `addons/sale_timesheet/models/sale_order_line.py` | `timesheet_ids` on order lines |
| `addons/project_todo/models/project_task.py` | To-do behavior on `project.task` |
| `addons/project_todo/models/res_users.py` | To-Do systray activity group |
| `addons/project_todo/__manifest__.py` | To-Do app manifest and menus |

## Related pages

- [Apps](index.md)
- [Accounting](accounting.md)
- [Sales suite](sales-suite.md)
- [HR suite](hr-suite.md)
- [Inventory and manufacturing](inventory-and-manufacturing.md)
- [Mail](mail.md)
- [Cron and scheduled actions](../primitives/cron-and-scheduled-actions.md)
- [Patterns and conventions](../how-to-contribute/patterns-and-conventions.md)
