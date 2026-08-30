# Agent Notes — EVM Address Notifications

Multi-tenant service that sends signed webhooks for EVM address activity
(top-level transactions, native value, ERC-20, ERC-721). See
`docs/implementation-plan.md` for the product spec and milestones, and
`docs/implementation-notes.md` for build notes.

## Reading this repo

- **`docs/implementation-plan.md` is the source of truth** for behavior,
  Milestone 0-5 scope, and exit criteria. Consult it before making changes.
- **`docs/implementation-notes.md` documents what has actually been built** and
  open items. Update it before committing whenever the implementation changes.
- If a plan detail and implementation disagree, prefer fixing the implementation
  to match the plan (or call out the divergence in implementation-notes).

## Tech stack

- Cloudflare Workers, `wrangler` (`wrangler.toml`), D1, Durable Objects, Queues.
- Hono for routing, Zod for every boundary, viem for address/chain types.
- Providers: webhooks delivered as signed POSTs; rpc-racer feed at
  `https://evm.stupidtech.net` via `RPC_RACER_BASE_URL` (M1 uses public HTTP;
  Migr 0 plans a private service binding).

## Architecture rules

- **D1 is the canonical control-plane store.** Durable Object storage is the
  scanner's operational state, reconciled against D1.
- **Control-plane changes and their scanner commands go to D1 in one batch**,
  then dispatch to the owning shard. Command ids are deterministic for
  idempotency; a reconciliation job redelivers unapplied commands.
- Two queues (matched-activity, webhook-delivery) keep ingestion decoupled from
  subscriber fanout and slow endpoints (added in later milestones).
- Subscriptions are created `pending` and move to `active`/`unsupported` when
  the scanner resolves the chain; `active_from_block = head + 1` is filled by
  the real scanner (M2).

## Coding style

- TypeScript on Cloudflare Workers. Prefer plainly written functions over
  classes outside `DurableObject`. Sensible naming wins over brevity.
- Refer to the global `~/.config/opencode/AGENTS.md`: bun-first, viem for
  node access, zod for validation, named parameters over positional, no
  backwards-compat unless asked (warn instead).
- After editing: `bun run format` (oxfmt) and `bun run lint` (oxlint).
  `bun run check` runs both. `bunx tsc --noEmit` for typecheck. `bun test`
  for unit tests.

## Local development

- `bun install`, `cp .dev.vars.example .dev.vars`, `bun run db:migrate:local`,
  then `bun run dev`.
- Operator provisioning: `bun scripts/operator.mts` (see README).
- Known local-only wrangler-dev bug: `wrangler d1 migrations apply --local` can
  leave a 3-column `_cf_ALARM` that crashes `wrangler dev` at boot
  ("table _cf_ALARM has 3 columns but 2 values"). `db:migrate:local` runs
  `scripts/fix-local.mts` to remove the poisoned metadata. Do not "fix" this in
  a way that changes production deployments — it is a local runtime issue.

## Git

- Conventional commits (e.g. `feat:`, `fix:`, `chore:`).
- Before committing, consult `docs/implementation-notes.md` and update it for
  what changed.
