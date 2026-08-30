#!/usr/bin/env bun
/**
 * Local-only workaround for a wrangler-dev bug.
 *
 * `wrangler d1 migrations apply --local` leaves a 3-column `_cf_ALARM` table
 * (actor_id, scheduled_time, actor_name) in the local miniflare D1/Cache
 * metadata.sqlite. `wrangler dev --local` then inserts only 2 values into that
 * table and workerd aborts at boot:
 *
 *   Fatal uncaught kj::Exception: workerd/util/sqlite.c++:842: failed:
 *   SENTRY_DO SQLite failed; ... table _cf_ALARM has 3 columns but 2 values
 *   were supplied: SQLITE_ERROR
 *
 * This removes only the poisoned metadata.sqlite files (the real D1 database
 * file is preserved) so local dev can boot. Production is unaffected — the
 * bug is confined to the local `.wrangler/state` Durable Object storage.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const targets = [
  join(root, ".wrangler", "state", "v3", "d1", "miniflare-D1DatabaseObject"),
  join(root, ".wrangler", "state", "v3", "cache", "miniflare-CacheObject"),
];

let removed = 0;
for (const dir of targets) {
  for (const suffix of ["metadata.sqlite", "metadata.sqlite-shm", "metadata.sqlite-wal"]) {
    const file = join(dir, suffix);
    if (existsSync(file)) {
      rmSync(file);
      removed += 1;
      console.log(`removed ${file}`);
    }
  }
}
console.log(removed === 0 ? "no poisoned local metadata found" : `removed ${removed} file(s)`);
