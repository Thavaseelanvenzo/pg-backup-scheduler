# pg-backup-scheduler

Automated full PostgreSQL backups to DigitalOcean Spaces, every 12 hours,
scheduled by **Coolify's Scheduled Tasks** feature.

`pg_backup.js` is a **single-run command**. It dumps, uploads, verifies,
deletes the local copy, and exits. There is no loop, no daemon, and no
scheduler inside the script — Coolify owns the schedule. No systemd, no
host crontab.

Node.js 22, with `pg_dump`/`pg_restore` from the PostgreSQL client packages
and `@aws-sdk/client-s3` for Spaces.

```
pg_dump -Fc  →  /app/staging/<DB_NAME>_backup_YYYY-MM-DD_HH-MM-SS.dump
             →  s3://<bucket>/<SPACES_PREFIX>/<same filename>
             →  independent HEAD verification (existence + exact size)
             →  local file deleted only after verification passes
```

Any failure leaves the local dump on the staging volume, logs the exact
reason, and exits non-zero so the run shows up as failed in Coolify.

---

## Contents

| File | Purpose |
| --- | --- |
| [pg_backup.js](pg_backup.js) | The backup command. One run, then exit. This is what Coolify schedules. |
| [restore_test.js](restore_test.js) | Manual restore verification into a **test** database. Never scheduled. |
| [Dockerfile](Dockerfile) | `node:22-bookworm-slim` + pinned `postgresql-client`, runs as non-root `appuser` (UID 10001). |
| [package.json](package.json) | `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`. Nothing else. |
| [package-lock.json](package-lock.json) | Committed so `npm ci` builds are reproducible. |
| [.env.example](.env.example) | Variable reference. Documentation only — no real values, ever. |
| [.gitignore](.gitignore) | Excludes `*.dump`, `.env`, `/staging/`, `node_modules/`. |

---

## 1. Prerequisites

**Spaces bucket** — already exists. Create a Spaces access key scoped to
that one bucket with **PutObject** and **GetObject**. `GetObject` is what
makes the verification HEAD request work. **Do not grant delete**; remote
retention is a lifecycle rule's job (§8).

Two optional additions:

- **`ListBucket`** — only if you want `restore_test.js --list` to work.
- **`AbortMultipartUpload`** — dumps larger than 16 MiB upload in parts. If
  such an upload fails midway, the SDK tries to abort it and reclaim the
  parts; without this permission the abort is refused and the orphaned
  parts linger (billable, and invisible in a normal listing) until the
  lifecycle rule in §8 clears them. Granting it is *not* the same as
  granting delete — it cannot touch a completed object.

**Database role** — create a read-only role rather than using `doadmin`.
Use the built-in `pg_read_all_data` role (PostgreSQL 14+), which is the
only clean way to give `pg_dump` everything it needs without admin rights:

```sql
CREATE ROLE backup_readonly LOGIN PASSWORD 'generate-a-strong-one';
GRANT CONNECT ON DATABASE defaultdb TO backup_readonly;
GRANT pg_read_all_data TO backup_readonly;
```

**Do not hand-roll this with `GRANT SELECT ON ALL TABLES`.** That grant
does not cover **sequences**, and `pg_dump` reads every sequence's current
value (`SELECT last_value, is_called FROM …`), so the dump fails with:

```
pg_dump: error: query failed: ERROR:  permission denied for sequence customers_id_seq
```

This project was tested against exactly that failure. If you are on
PostgreSQL 13 or older and cannot use `pg_read_all_data`, you need the
sequence grants too, and they must be repeated for every schema:

```sql
GRANT USAGE ON SCHEMA public TO backup_readonly;
GRANT SELECT ON ALL TABLES    IN SCHEMA public TO backup_readonly;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_readonly;  -- easy to miss
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES    TO backup_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO backup_readonly;
-- repeat all four for every non-public schema you back up
```

Read-only is a real trade-off, not a free win: `pg_dump` cannot read an
object it has no rights on, and it will **fail loudly** rather than write
a partial dump — which is the behaviour you want. With the hand-rolled
grants, a schema added later is silently outside the backup's scope until
you grant on it; `pg_read_all_data` does not have that failure mode.
Either way, verify coverage after any schema change by comparing the
restored table count from `restore_test.js` against production.

**PostgreSQL major version — match it exactly.** Check the server:

```sql
SELECT version();
```

The image defaults to `PG_MAJOR=15`, matching the target cluster. Set the
Coolify **Build Variable** `PG_MAJOR` (§3) to your server's major version if
it differs.

"A newer client is fine" is a trap, and this project was tested against it.
A newer `pg_dump` *can* read an older server, but it writes an archive the
older server cannot restore. Dumping this PG 15 cluster with `pg_dump` 17
produced a file that failed two ways:

```
pg_restore: error: unsupported version (1.16) in file header
pg_restore: error: could not execute query: ERROR:  unrecognized configuration parameter "transaction_timeout"
    Command was: SET transaction_timeout = 0;
```

The first is the archive format bump; the second is a PG 17-only GUC that
`pg_dump` 17 writes into every dump. Both make the backup unrestorable on
the server it came from — a backup that only *looks* fine until you need it.
Dumping the same cluster with the PG 15 client restored cleanly, all 70
tables and 7,045 rows matching the source exactly.

---

## 2. Create the Coolify resource

1. **Projects → your project → + New → Resource**.
2. Choose **Docker Image / Dockerfile** based on a Git repository, point it
   at this repo, and set the branch.
3. **Build Pack: Dockerfile**. Base directory `/`, Dockerfile location
   `/Dockerfile`.
4. Leave **Ports Exposes** empty — this app serves no HTTP traffic. Disable
   any health check that expects an HTTP endpoint; the container's job is
   simply to stay running so scheduled tasks can exec into it.
5. Deploy. The container starts `tail -f /dev/null` and idles. **That is
   correct** — an idle container is the host for the scheduled runs.

> If Coolify shows the resource as "unhealthy" because no port responds,
> turn the health check off in **Configuration → Health Checks**.

---

## 3. Environment variables (Coolify UI)

**Configuration → Environment Variables** on the resource. Add each one as
a runtime variable. Mark the two secrets so Coolify masks them in the UI.

### Required

| Variable | Example | Notes |
| --- | --- | --- |
| `DB_HOST` | `db-do-user-0-0.b.db.ondigitalocean.com` | From the DO cluster's connection details |
| `DB_PORT` | `25060` | DO managed PG default |
| `DB_NAME` | `defaultdb` | Database to dump |
| `DB_USER` | `backup_readonly` | Read-only role from §1 |
| `DB_PASSWORD` | *(secret)* | Never logged, even on failure |
| `SPACES_ACCESS_KEY` | `DO00XXXXXXXXXXXXXXXX` | |
| `SPACES_SECRET_KEY` | *(secret)* | Never logged, even on failure |
| `SPACES_BUCKET` | `my-existing-bucket` | Bucket name only, no URL |
| `SPACES_REGION` | `blr1` | `nyc3`, `sfo3`, `fra1`, `sgp1`, `blr1`, `syd1`, `ams3`, `tor1` |
| `SPACES_ENDPOINT` | `https://blr1.digitaloceanspaces.com` | **Region** endpoint, not the bucket URL. Must be `https://`. |

The script fails fast with exit code **2** and lists *every* missing
variable at once if any are absent.

### Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `SPACES_PREFIX` | `prod-dump` | Folder (key prefix) inside the bucket |
| `DB_SSLMODE` | `require` | `disable`/`allow`/`prefer` are rejected |
| `STAGING_DIR` | `/app/staging` | Must match the volume mount |
| `LOCAL_RETENTION_DAYS` | `3` | Local prune window only |
| `DUMP_TIMEOUT_SECONDS` | `3600` | Keep below the task timeout |
| `PGCONNECT_TIMEOUT` | `30` | libpq connect timeout |
| `SPACES_FORCE_PATH_STYLE` | `false` | Leave unset for Spaces (virtual-hosted style). `true` only for S3-compatible servers needing path-style, e.g. a local MinIO. |

### Build variable (only if not PG 16)

**Configuration → Build → Build Variables**: `PG_MAJOR` = your server's
major version. Redeploy after changing it.

---

## 4. Persistent volume at `/app/staging`

Dumps are written here before upload, and this is where a failed run's
dump survives for recovery. Logs persist here across restarts too.

**Configuration → Storages → + Add** on the resource:

- **Name:** `pg-backup-staging`
- **Mount Path:** `/app/staging`
- Leave the host/source path empty to let Coolify manage a Docker named
  volume (recommended).

Redeploy after adding the volume.

**Size it for at least two dumps plus headroom** — a run in progress plus
whatever a previous failure left behind. Compressed custom-format dumps are
typically 10–25 % of the live database size, but that ratio varies a lot
with your data; measure your first dump rather than trusting the estimate.

### Volume permissions

The container runs as UID **10001**. A fresh named volume inherits the
image's ownership and just works. An **existing, non-empty** volume may be
root-owned, and the run will fail with a clear "not writable by this user"
message. Fix it from the host:

```bash
docker run --rm -v pg-backup-staging:/v alpine chown -R 10001:10001 /v
```

(Substitute the actual volume name from `docker volume ls`.)

---

## 5. Add the Scheduled Task

**Configuration → Scheduled Tasks → + Add** on the resource:

| Field | Value |
| --- | --- |
| **Name** | `postgres-full-backup` |
| **Command** | `node pg_backup.js` |
| **Frequency** | `0 2,14 * * *` |
| **Container** | the resource's container (select it if prompted) |

`0 2,14 * * *` fires at 02:00 and 14:00 — every 12 hours.

**Timeout.** Set it comfortably above your slowest observed run and above
`DUMP_TIMEOUT_SECONDS`. Starting point: **5400 seconds (90 min)** against
`DUMP_TIMEOUT_SECONDS=3600`. The ordering matters — the script's own
timeout must trip *first* so it can log `BACKUP FAILED: pg_dump exceeded…`
and preserve the dump. If Coolify kills the container first, you get a
truncated log and no explanation. Tighten both once you know how long a
real dump takes.

**Timezone.** Coolify's cron evaluates in the server's timezone, while the
script timestamps and names objects in **UTC**. If those differ, the object
key's date won't match the local wall clock of the run. Either accept it
(UTC keys sort cleanly) or set the instance timezone in Coolify's settings.

### Why the schedule lives in Coolify

The script has no scheduling logic at all — no loop, no `sleep`, no
in-process cron. It runs once per invocation and exits. That means each
run's exit code lands in Coolify's task history, and a run that hangs is
bounded by the task timeout rather than wedging a long-lived process.

### Idempotence

Every run derives its own filename and object key from the current UTC
timestamp, so runs never collide and nothing is ever overwritten — the
02:00 and 14:00 dumps coexist under the same date folder:

```
prod-dump/defaultdb_backup_2026-09-02_02-00-00.dump
prod-dump/defaultdb_backup_2026-09-03_02-00-00.dump
```

Re-running by hand is always safe; it just adds another object.

---

## 6. Checking logs

### Coolify Logs tab (primary)

STDOUT is the primary log destination. **Resource → Logs** shows every
line from every run:

```
[2026-09-02 02:00:01 UTC] [INFO] BACKUP START (single run, no in-script scheduling)
[2026-09-02 02:00:01 UTC] [INFO] config loaded: DB_HOST=… (DB_PASSWORD and SPACES_SECRET_KEY present, values not logged)
[2026-09-02 02:00:01 UTC] [INFO] staging directory ready: /app/staging
[2026-09-02 02:00:01 UTC] [INFO] starting pg_dump: backup_readonly@…/defaultdb format=custom compress=9 sslmode=require -> /app/staging/defaultdb_backup_2026-09-02_02-00-01.dump
[2026-09-02 02:01:44 UTC] [INFO] dump duration: 103.2s (pg_dump exit 0)
[2026-09-02 02:01:44 UTC] [INFO] dump file size: 412.87 MiB (432918016 bytes) (custom-format header verified)
[2026-09-02 02:01:44 UTC] [INFO] uploading defaultdb_backup_2026-09-02_02-00-01.dump -> s3://erp-bucket-prod/prod-dump/defaultdb_backup_2026-09-02_02-00-01.dump
[2026-09-02 02:02:31 UTC] [INFO] upload result: call returned successfully in 47.3s (8.73 MiB/s) -- not yet trusted, verifying independently
[2026-09-02 02:02:31 UTC] [INFO] verifying s3://erp-bucket-prod/prod-dump/defaultdb_backup_2026-09-02_02-00-01.dump with a HEAD request
[2026-09-02 02:02:32 UTC] [INFO] verification result: OK -- object exists, 412.87 MiB (432918016 bytes) matches local size, etag=…
[2026-09-02 02:02:32 UTC] [INFO] local dump deleted after successful verification: defaultdb_backup_2026-09-02_02-00-01.dump
[2026-09-02 02:02:32 UTC] [INFO] local cleanup: nothing older than the retention window
[2026-09-02 02:02:32 UTC] [INFO] BACKUP SUCCESS
```

Search for `BACKUP SUCCESS` or `BACKUP FAILED` to audit runs at a glance.
**Scheduled Tasks → the task** also shows per-execution history with exit
status.

### Persistent log file

The same lines are appended to `/app/staging/logs/backup.log`, which
survives container restarts and redeploys (it's on the volume):

```bash
# via Coolify's Execute Command / Terminal
tail -n 100 /app/staging/logs/backup.log
grep -E 'BACKUP (SUCCESS|FAILED)' /app/staging/logs/backup.log
```

This file is never rotated by the script. It grows slowly (a few hundred
bytes per run — roughly 100 KB/year), so it needs no attention, but it is
also not a substitute for real log retention.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Dump uploaded **and** independently verified |
| `1` | Dump, upload, or verification failed — local dump preserved |
| `2` | Configuration error (missing/invalid environment variables) |

---

## 6b. Local dump without Spaces (`--dump-only`)

For a local copy, or to smoke-test database connectivity before Spaces is
configured:

```bash
node pg_backup.js --dump-only
```

It requires only the `DB_*` variables, uploads nothing, verifies nothing,
skips the retention sweep, and **keeps** the file in `STAGING_DIR`. It logs
`DUMP SUCCESS (local only -- not uploaded, not verified)` — deliberately not
`BACKUP SUCCESS`, so grepping logs for real backups stays trustworthy.

**Do not use this as the scheduled task.** A dump sitting on the same
volume the container writes to has not survived anything; it is a dump, not
a backup. Unknown flags are rejected rather than ignored, so a typo like
`--dumponly` fails loudly instead of silently attempting a full upload.

Run it locally (outside Coolify) with an explicit staging directory:

```bash
STAGING_DIR=./staging DB_HOST=... DB_PORT=25060 DB_NAME=defaultdb DB_USER=backup_readonly DB_PASSWORD=... node pg_backup.js --dump-only
```

---

## 7. Manual test run

**Resource → Execute Command** (or the Terminal tab), then:

```bash
node pg_backup.js
```

You'll see the log stream inline and can check `$?` for the exit code.
This is the fastest way to validate credentials, SSL, volume permissions,
and bucket access without waiting for 02:00.

Useful one-off checks in the same shell:

```bash
pg_dump --version                                  # confirm the client major version
psql "host=$DB_HOST port=$DB_PORT dbname=$DB_NAME user=$DB_USER sslmode=require" -c 'select 1'
ls -la /app/staging /app/staging/logs              # volume writable by UID 10001?
id                                                 # should be uid=10001(appuser)
```

### Verifying the backup landed in Spaces

**Control panel:** Spaces → `erp-bucket-prod` → `prod-dump/`.
Confirm `<db>_backup_<timestamp>.dump` exists and its size matches
the `dump file size` line in the log.

**From inside the container** (needs `ListBucket` on the key):

```bash
node restore_test.js --list
node restore_test.js --list --list-prefix prod-dump/
```

**With `s3cmd` / `aws` CLI from your workstation:**

```bash
aws s3 ls "s3://$SPACES_BUCKET/$SPACES_PREFIX/" \
  --endpoint-url "$SPACES_ENDPOINT"
```

Note that the script has *already* verified existence and exact byte size
via a fresh HEAD request before it deleted the local file — a `BACKUP
SUCCESS` line is itself evidence the object is there. These checks are for
your own confidence and for auditing.

---

## 8. Remote retention (Spaces lifecycle rule)

The script never deletes remote objects, and the access key should not even
be able to. Set 30-day retention as a bucket lifecycle rule instead:

```bash
cat > lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-postgres-backups-30d",
      "Status": "Enabled",
      "Filter": { "Prefix": "prod-dump/" },
      "Expiration": { "Days": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 2 }
    }
  ]
}
JSON

aws s3api put-bucket-lifecycle-configuration \
  --bucket "$SPACES_BUCKET" \
  --endpoint-url "$SPACES_ENDPOINT" \
  --lifecycle-configuration file://lifecycle.json
```

Use a **separate, delete-capable admin key** for that one-time command —
not the key in `SPACES_ACCESS_KEY`. Confirm it applied:

```bash
aws s3api get-bucket-lifecycle-configuration \
  --bucket "$SPACES_BUCKET" --endpoint-url "$SPACES_ENDPOINT"
```

The `AbortIncompleteMultipartUpload` rule matters: a failed large upload
can leave billable multipart fragments that no listing shows.

Local retention is separate — `LOCAL_RETENTION_DAYS` (default 3) prunes
`*.dump` files left in `/app/staging` by failed runs. Cleanup failures are
logged as warnings and never turn a verified backup into a reported
failure.

---

## 9. Restore test

**An unrestored backup is a hypothesis.** Run this monthly, and after any
schema migration.

`restore_test.js` refuses to restore into `DB_NAME` on the same
`host:port`, so it cannot overwrite production by accident. Create a
throwaway target first:

```sql
CREATE DATABASE restore_test;
```

Set `TEST_DB_NAME=restore_test` (and `TEST_DB_USER` / `TEST_DB_PASSWORD` if
the read-only role can't write — it can't, so you will need a role with
CREATE on the test database).

```bash
# 1. see what's in Spaces
node restore_test.js --list

# 2. download a specific backup and restore it
node restore_test.js --key prod-dump/defaultdb_backup_2026-09-02_02-00-00.dump

# 3. or restore a local file that a failed run left behind
node restore_test.js --file /app/staging/defaultdb_backup_2026-09-02_02-00-00.dump

# 4. re-running into a dirty test database: drop objects first
node restore_test.js --key prod-dump/defaultdb_backup_2026-09-02_02-00-00.dump \
  --clean --i-know-this-is-not-production
```

`--clean` is gated behind that explicit confirmation flag because it drops
objects in the target. The script validates the `PGDMP` header before
starting, reports `pg_restore` warnings without failing on them (missing
roles and pre-existing extensions are normal with `--no-owner
--no-privileges`), and prints a post-restore user-table count so you can
compare against production.

Options: `--jobs N` for parallel restore (default 2), `--keep-download` to
retain the downloaded file.

---

## Security notes

- **No credentials in the repo.** Nothing is hardcoded and no `.env` is
  read at runtime — the scripts read `os.environ` only. `.env.example`
  documents variable *names* and carries no real values. `.gitignore`
  excludes `.env`, `*.dump`, and `/staging/`.
- **Secrets never reach the logs.** `DB_PASSWORD` and `SPACES_SECRET_KEY`
  are never interpolated into any log line or exception message, including
  on failure paths. `pg_dump` stderr is passed through a redaction filter
  before logging, because third-party output isn't ours to trust.
- **The password is never in argv.** It's passed to `pg_dump` via
  `PGPASSWORD` in the child environment. Anything on the command line is
  readable through `/proc` by other processes.
- **SSL is enforced.** `sslmode=require` minimum; the script rejects
  `disable`, `allow`, and `prefer`. `https://` is required for
  `SPACES_ENDPOINT`. For certificate verification, mount the DO CA cert and
  set `DB_SSLMODE=verify-full` plus `PGSSLROOTCERT`.
- **Least privilege on both ends.** `DB_USER` should be a read-only role
  (§1), never `doadmin`. The Spaces key should be scoped to one bucket with
  `PutObject` + `GetObject` (optionally `ListBucket` and
  `AbortMultipartUpload`, see §1) and **no delete** — so a compromise of
  this container cannot destroy your backup history, and deletion authority
  lives only in the lifecycle rule. This was verified against a key that
  genuinely refuses `DeleteObject`: backup, verification and restore all
  work without it.
- **Non-root container.** Runs as `appuser` (UID/GID 10001), not root.
- **Verification is independent of the upload.** Deletion of the local file
  is gated on a *fresh* `head_object` call whose `ContentLength` matches the
  local file exactly. A successful-looking upload return value is not
  treated as proof.
- **Dumps are unencrypted at rest in Spaces** beyond whatever server-side
  encryption the bucket has enabled, and a `.dump` is a complete copy of
  your data. Keep the bucket private, and consider client-side encryption
  (e.g. `age` or GPG before upload) if the data is sensitive enough to
  warrant it. That is not implemented here.

---

## Implementation notes

Four decisions that are easy to get wrong when modifying this code:

- **Uploads go through `@aws-sdk/lib-storage`'s `Upload`, not
  `PutObjectCommand`.** It switches to multipart automatically, so a dump
  above the 5 GB single-PUT ceiling still uploads. Verified with a 45 MiB
  dump that uploaded as 3 parts.
- **Verification compares `ContentLength`, never the ETag.** A multipart
  object's ETag is not the MD5 of its content (it looks like
  `<hash>-<partcount>`), so an ETag comparison would be meaningless exactly
  when the dump is large.
- **`requestChecksumCalculation: 'WHEN_REQUIRED'`.** Recent AWS SDK v3
  releases attach CRC32 flexible-checksum headers to every upload by
  default, which several non-AWS S3 implementations reject. This is the
  documented compatibility setting. Note that MinIO accepts either mode, so
  the local test suite does not discriminate between them — the setting is
  there on the strength of the provider-compatibility guidance, not a local
  reproduction.
- **The scripts set `process.exitCode`; they never call `process.exit()`.**
  `stdout` is asynchronous when piped, which is exactly how Coolify captures
  logs, so `process.exit()` can truncate the final `BACKUP SUCCESS` line.
  The S3 client is explicitly `destroy()`ed instead so its keep-alive
  sockets stop holding the event loop open and the process ends on its own.

---

## Troubleshooting

| Log line | Cause and fix |
| --- | --- |
| `missing required environment variable(s): …` | Add the listed names in Coolify's Environment Variables UI, then redeploy. |
| `pg_dump binary not found on PATH` | Image built without `postgresql-client`. Check the Dockerfile build logs. |
| `server version mismatch` in `pg_dump` stderr | Server is newer than the client. Set Build Variable `PG_MAJOR` to the server's major version and redeploy. |
| `staging directory … is not writable by this user` | Volume is root-owned. `chown -R 10001:10001` it (§4). |
| `Spaces API error SignatureDoesNotMatch` | `SPACES_SECRET_KEY` doesn't match `SPACES_ACCESS_KEY`. Re-copy both. |
| `Spaces API error AccessDenied` | Key lacks `PutObject`/`GetObject` on the bucket, or is scoped to a different bucket. |
| `unsupported version (1.16) in file header` | The dump was written by a newer `pg_dump` than the `pg_restore` reading it. Match `PG_MAJOR` to the server (§1). |
| `unrecognized configuration parameter "transaction_timeout"` | Dump was made by `pg_dump` 17 but restored into PG ≤16. Same fix: match `PG_MAJOR` to the server (§1). |
| `Spaces API error NoSuchBucket` | `SPACES_BUCKET` name wrong, or `SPACES_ENDPOINT` points at the wrong region. |
| `verification failed: … does not exist after an upload that reported success` | Key lacks `GetObject`, or the endpoint/region combination is inconsistent. Local dump was preserved. |
| `verification failed: size mismatch` | Truncated upload. Local dump preserved; re-run. |
| `pg_dump exceeded DUMP_TIMEOUT_SECONDS` | Dump is slower than the limit. Raise `DUMP_TIMEOUT_SECONDS` **and** the Coolify task timeout above it. |
| `permission denied for sequence …` in `pg_dump` stderr | The classic incomplete read-only grant: `GRANT SELECT ON ALL TABLES` doesn't cover sequences. `GRANT pg_read_all_data TO backup_readonly;` (§1). |
| `permission denied for table …` in `pg_dump` stderr | The read-only role is missing rights on a table or schema. Re-run the grants from §1 — do not "fix" it by switching to an admin role. |
| Container shows unhealthy | Expected — no HTTP port. Disable the health check (§2). |
| `Cannot find module '@aws-sdk/client-s3'` | Image built without dependencies. `npm ci` needs `package-lock.json` committed — check it is in the repo and the build logs show "added N packages". |
| Upload fails only for large dumps | Multipart-specific. Check the key allows `AbortMultipartUpload` (§1) and that the lifecycle rule clears incomplete uploads (§8). |
