# Team

Team is the account collaboration screen under **More**. It lets users grant precise, directional read access to task history. It is not a social follow list and it does not grant document, wallet, Context, Memory, chat, or task-mutation authority.

## Relationships

Every relationship is represented by one or two explicit subject-to-viewer grants:

| Label | Effective visibility |
| --- | --- |
| Collaborator | Each person can read the other's task history. |
| Manager | The invited manager can read the inviter/direct report's tasks; the direct report cannot read the manager's tasks. |
| Direct Report | The inviter/manager can read the invitee/direct report's tasks; the report cannot read the manager's tasks. |

The cards say both directions explicitly: **You see their tasks** and **They see yours**. A relationship label is presentation over grants, not an independent authorization shortcut.

## User Flow

1. Open **More -> Team** and unlock the linked wallet.
2. Invite an exact Task Node handle or linked PFT wallet and choose the relationship.
3. The recipient accepts or declines the signed invitation. Acceptance creates only the reviewed grant directions.
4. When a grant permits it, select **View tasks** on the member card.
5. Select a task row to open its detail popout. Desktop uses a right-side panel; mobile uses a bottom sheet. The read-only view shows the teammate identity, status, reward, due date, brief, steps, evidence, activity, and task ID when available.
6. Close with the close button, backdrop, or Escape. Focus returns to the selected task row.
7. Stop sharing or revoke the applicable grant. Reads fail immediately after revocation.

## Authorization Boundary

Both task list and individual task detail routes call the same `requireTaskHistoryGrant` gate before resolving the subject wallet:

- `GET /api/team/:accountId/tasks`
- `GET /api/team/:accountId/tasks/:taskId`

The server loads the task under the subject account and linked wallet; it never trusts a viewer-supplied wallet as the authorization boundary. Team is read-only. It cannot accept, refuse, cancel, submit, answer verification, or reward a teammate's task.

Invites, acceptance, and revocation use short-lived, single-use wallet challenges bound to the action, resource ID, and payload digest. Exact identity lookup prevents fuzzy directory enumeration.

## Nostr

A user may bind a Nostr public key to the Task Node account with wallet proof. Teammates may retrieve that binding only through the collaboration boundary. Nostr can carry encrypted teammate messages, but Task Node account and wallet grants remain authoritative for task access. Revoking Nostr does not change Team permissions, and revoking Team permissions does not depend on relay delivery.

## Runtime

- UI: `src/features/team/TeamView.jsx`, `TeamTaskDetailPopout.jsx`, and `team.css`.
- API: `server/collaboration-routes.js`.
- Persistence and authorization: `server/repositories/collaboration.js`.
- Schema: migration `110_docs_team_collaboration.sql`.
- Feature flag: `TASKNODE_TEAM_ENABLED`.

Verification: `npm run collaboration-contract-smoke` and `npm run team-task-popout-smoke`.
