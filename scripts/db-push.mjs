/**
 * Pre-deploy schema push (railway.json → deploy.preDeployCommand).
 *
 * A database that scales to zero (Neon's free tier suspends after ~5 idle
 * minutes) can take longer to wake than Prisma's default 5-second connect
 * timeout, and the push then fails with P1001 "Can't reach database server"
 * although nothing is wrong. So: allow 30 s per connection (unless the URL
 * already sets connect_timeout) and retry a few times while it wakes. A
 * database that stays unreachable still fails the step, which keeps the
 * running version up.
 */
import { spawnSync } from 'node:child_process';

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.log('[db-push] DATABASE_URL not set — nothing to push (the app runs without a database).');
  process.exit(0);
}

let url = raw;
try {
  const u = new URL(raw);
  if (!u.searchParams.has('connect_timeout')) u.searchParams.set('connect_timeout', '30');
  url = u.toString();
} catch {
  // Not parseable as a URL: use it exactly as given.
}

const ATTEMPTS = Math.max(1, Number(process.env.DB_PUSH_ATTEMPTS ?? 5));
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
  const r = spawnSync('npx', ['--no-install', 'prisma', 'db', 'push', '--skip-generate'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
  if (r.status === 0) process.exit(0);
  if (attempt < ATTEMPTS) {
    const waitS = 10 * attempt;
    console.warn(`[db-push] attempt ${attempt}/${ATTEMPTS} failed — the database may be waking up; retrying in ${waitS}s`);
    spawnSync('sleep', [String(waitS)]);
  }
}
console.error(`[db-push] database unreachable after ${ATTEMPTS} attempts — check that it is running and within its plan's limits`);
process.exit(1);
