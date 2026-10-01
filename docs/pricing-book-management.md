# Price-book responsibility and lifecycle

The isolated candidate exposes operational responsibility separately from price
content. These fields do not grant access, deliver alerts, publish a price, change
a catalog revision, or recompute historical costs.

## Responsibility

`GET /api/dashboard/pricing/books/:id/management` is workspace-scoped and
viewer-readable. It returns the owner label, independent metadata revision,
last actor/time, a lifecycle view, its evaluation time and catalog revision.
New normal and inherited books explicitly assign their creator initially.
Historical books without a management record return an **unassigned** owner and
revision `0`; their `created_by` field is not silently treated as responsibility.

Admins may `PUT /api/dashboard/pricing/books/:id/owner` with `revision`, `owner`,
`reason` and `confirm: true`. The owner is a user/team label of up to 128 characters,
not a role or a notification address. Explicit `null` clears the assignment.
Unknown fields and invalid labels are rejected. Global-book updates additionally
require global administration, as with existing price changes.

The update and `book.owner_changed` audit are atomic. Optimistic concurrency uses
the metadata revision, not the price catalog head. A stale edit returns HTTP409
`pricing_book_metadata_conflict`; the editor keeps the proposed input and blocks
another save until the operator closes/reopens it and reviews the latest owner.
A same-owner update is a no-op after the revision check. Clearing an owner does
not delete audit history. Do not put secrets into responsibility labels or reasons.

## Lifecycle is derived, not a second publish switch

The view uses one read transaction and an explicit evaluation time:

| State | Meaning |
| --- | --- |
| `draft` | No immutable version has been published |
| `active` | At least one binding is inside its half-open effective interval |
| `scheduled` | No current binding, but at least one future binding exists |
| `inactive` | Published versions exist without current or future bindings |

Draft/version/current/future counts are shown separately, so an active book may
still have unpublished drafts and scheduled changes. Bindings are filtered to the
viewer's scope. An active binding does **not** guarantee that a request selects
it: a more specific override can take priority. This is not gateway health or
supplier-support verification. Refresh to inspect a later time; the displayed
timestamp is not a promise of continuous monitoring.

## Additive migration

Migration `pricing-engine-017` creates only `pricing_book_management`, with a
restricted foreign key to its price book. Migrations001–016 and existing book,
version, audit, budget and request rows are unchanged. No owner is backfilled.
Use the existing explicit migration CLI on the selected isolated database first;
application startup never applies this migration. Production migration remains
subject to separate deployment approval and backup/rollback review.

The UI is localized in all seven Dashboard languages and separates this form from
the rate editor. Changing responsibility does not discard an unsaved price draft.
This capability alone is not completion of the [full pricing Goal](pricing-engine-goal-spec.md).
