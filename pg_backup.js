#!/usr/bin/env node
/**
 * Single-run full PostgreSQL backup to DigitalOcean Spaces.
 *
 * Invoked once per run by Coolify's Scheduled Task feature:
 *
 *     node pg_backup.js
 *
 * There is also a manual, local-only mode that dumps and stops:
 *
 *     node pg_backup.js --dump-only
 *
 * It requires only the DB_* variables, uploads nothing, verifies nothing,
 * and keeps the file. Use it for a local copy or to test connectivity --
 * never as your scheduled task, because an un-uploaded dump is not a backup.
 *
 * There is deliberately no scheduling logic, loop, or daemon in this file.
 * Exit code 0 means the dump was uploaded AND independently verified in
 * Spaces. Any non-zero exit means the local dump file (if one was produced)
 * has been left in place on the staging volume for manual recovery.
 *
 * Exit codes:
 *     0  success
 *     1  dump / upload / verification failure
 *     2  configuration error (missing environment variables)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STAGING_DIR = process.env.STAGING_DIR || '/app/staging';
const LOG_FILE = path.join(STAGING_DIR, 'logs', 'backup.log');

const REMOTE_PREFIX = stripSlashes(process.env.SPACES_PREFIX || 'postgres-backups');

// Local safety-net retention. Remote retention is handled by a Spaces
// lifecycle rule (30 days) -- NOT by this script.
const LOCAL_RETENTION_DAYS = Number(process.env.LOCAL_RETENTION_DAYS || '3');

// Hard ceiling on pg_dump wall time so a hung connection cannot pin the
// container forever. Keep this comfortably below the Coolify task timeout.
const DUMP_TIMEOUT_SECONDS = Number(process.env.DUMP_TIMEOUT_SECONDS || '3600');

const DB_REQUIRED_VARS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

const SPACES_REQUIRED_VARS = [
  'SPACES_ACCESS_KEY',
  'SPACES_SECRET_KEY',
  'SPACES_BUCKET',
  'SPACES_REGION',
  'SPACES_ENDPOINT',
];

// The scheduled path needs all of them. `--dump-only` needs only the
// database half, because it never talks to Spaces.
const REQUIRED_VARS = [...DB_REQUIRED_VARS, ...SPACES_REQUIRED_VARS];

// Values of these variables must never reach a log line or an error message,
// including on the failure paths.
const SECRET_VARS = new Set(['DB_PASSWORD', 'SPACES_SECRET_KEY']);

// Custom-format dumps begin with this magic string. A pg_dump that exits 0
// but writes a truncated or empty file is a real failure mode, so we check.
const PGDMP_MAGIC = Buffer.from('PGDMP');

function stripSlashes(value) {
  return value.replace(/^\/+|\/+$/g, '');
}

/**
 * Make a database name safe for use in a filename and an S3 key.
 *
 * PostgreSQL allows characters that are hostile in both contexts (slashes,
 * spaces, quotes). Anything outside the safe set collapses to '_' so the
 * object key stays predictable and shell-safe on the restore side.
 */
function safeNamePart(value) {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '');
  return cleaned || 'database';
}

/**
 * Build the shared basename for one run: `<db>_backup_YYYY-MM-DD_HH-MM-SS.dump`.
 *
 * The local file and the remote object deliberately carry the SAME name, so
 * a file found on the staging volume can be matched to its Spaces object (and
 * vice versa) without consulting the log. The timestamp is UTC, matching
 * every log line. Seconds resolution plus the one-run-per-schedule model
 * makes collisions a non-issue; if one somehow occurs, the existsSync guard
 * in runBackup fails the run rather than overwriting a previous dump.
 */
function buildDumpName(dbName, now = new Date()) {
  const iso = now.toISOString();
  const day = iso.slice(0, 10); // YYYY-MM-DD
  const clock = iso.slice(11, 19).replaceAll(':', '-'); // HH-MM-SS
  return `${safeNamePart(dbName)}_backup_${day}_${clock}.dump`;
}

/**
 * Join the configured folder prefix to a filename.
 *
 * SPACES_PREFIX='' (or '/') means "bucket root": emit a bare key rather than
 * a leading slash, which Spaces would treat as an empty first path segment.
 */
function buildRemoteKey(prefix, fileName) {
  return prefix ? `${prefix}/${fileName}` : fileName;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A failure whose message is safe to log verbatim. */
class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
    this.exitCode = 1;
  }
}

/** Bad or missing configuration -- distinct exit code from a run failure. */
class ConfigError extends BackupError {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Timestamped logger writing to STDOUT first, log file second.
 *
 * STDOUT is the primary destination because that is what Coolify's log
 * viewer captures. The file mirror is best-effort: if the staging volume is
 * unwritable we warn once and keep going rather than abort a backup over a
 * logging problem.
 */
class Logger {
  #fileUsable = false;
  #fileWarningEmitted = false;

  constructor(logFile) {
    this.logFile = logFile;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, '');
      this.#fileUsable = true;
    } catch (err) {
      this.warn(
        `cannot open log file ${logFile} for append (${err.message}); ` +
          'continuing with STDOUT logging only',
      );
    }
  }

  static #stamp() {
    // e.g. 2026-09-02 02:00:01 UTC
    return `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  }

  #emit(level, message) {
    const line = `[${Logger.#stamp()}] [${level}] ${message}`;
    // console.log writes to stdout, which Coolify captures.
    console.log(line);
    if (!this.#fileUsable) return;
    try {
      fs.appendFileSync(this.logFile, `${line}\n`);
    } catch (err) {
      if (!this.#fileWarningEmitted) {
        this.#fileWarningEmitted = true;
        console.log(
          `[${Logger.#stamp()}] [WARN] log file write failed ` +
            `(${err.message}); STDOUT logging continues`,
        );
      }
    }
  }

  info(message) {
    this.#emit('INFO', message);
  }

  warn(message) {
    this.#emit('WARN', message);
  }

  error(message) {
    this.#emit('ERROR', message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanSize(numBytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = numBytes;
  for (const unit of units) {
    if (size < 1024 || unit === 'TiB') {
      return `${size.toFixed(2)} ${unit} (${numBytes} bytes)`;
    }
    size /= 1024;
  }
  return `${numBytes} bytes`;
}

/**
 * Strip any secret value that leaked into a third-party message.
 *
 * Our own messages never interpolate secrets, but pg_dump and the AWS SDK
 * build their own strings, so scrub anything we pass through from them.
 */
function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('***REDACTED***');
    }
  }
  return out;
}

/**
 * Read every required variable from the environment, or fail fast.
 *
 * All missing names are reported at once so a misconfigured Coolify resource
 * does not need one run per missing variable to diagnose.
 */
function loadConfig(log, { dumpOnly = false } = {}) {
  const required = dumpOnly ? DB_REQUIRED_VARS : REQUIRED_VARS;
  const config = {};
  const missing = [];
  for (const name of required) {
    const value = (process.env[name] || '').trim();
    if (value) config[name] = value;
    else missing.push(name);
  }

  if (missing.length > 0) {
    throw new ConfigError(
      `missing required environment variable(s): ${missing.join(', ')}` +
        " -- set these in Coolify's Environment Variables UI for this resource",
    );
  }

  console.log("testing auto deployment flag");
  
  const port = Number(config.DB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(
      `DB_PORT must be an integer between 1 and 65535, got '${config.DB_PORT}'`,
    );
  }

  for (const name of ['LOCAL_RETENTION_DAYS', 'DUMP_TIMEOUT_SECONDS']) {
    const raw = process.env[name];
    if (raw !== undefined && !(Number(raw) >= 0)) {
      throw new ConfigError(`${name} must be a non-negative number, got '${raw}'`);
    }
  }

  // Log only non-secret values, so a run's provenance is auditable.
  const dbPart =
    `DB_HOST=${config.DB_HOST} DB_PORT=${config.DB_PORT} ` +
    `DB_NAME=${config.DB_NAME} DB_USER=${config.DB_USER}`;
  if (dumpOnly) {
    log.info(
      `config loaded: ${dbPart} (DB_PASSWORD present, value not logged; ` +
        'Spaces variables not required in --dump-only mode)',
    );
  } else {
    log.info(
      `config loaded: ${dbPart} ` +
        `SPACES_BUCKET=${config.SPACES_BUCKET} ` +
        `SPACES_REGION=${config.SPACES_REGION} ` +
        `SPACES_ENDPOINT=${config.SPACES_ENDPOINT} ` +
        '(DB_PASSWORD and SPACES_SECRET_KEY present, values not logged)',
    );
  }
  return config;
}

function ensureStaging(log) {
  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  } catch (err) {
    throw new BackupError(
      `staging directory ${STAGING_DIR} is not usable (${err.message}) -- ` +
        'check that a persistent volume is mounted there in Coolify',
    );
  }

  const probe = path.join(STAGING_DIR, '.write-probe');
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (err) {
    throw new BackupError(
      `staging directory ${STAGING_DIR} is not writable by this user ` +
        `(${err.message}) -- the mounted volume must be writable by ` +
        'UID 10001 (appuser)',
    );
  }
  log.info(`staging directory ready: ${STAGING_DIR}`);
}

// ---------------------------------------------------------------------------
// Step 1: dump
// ---------------------------------------------------------------------------

/**
 * Run a full pg_dump in custom format over SSL. Resolves to the file size.
 */
async function runPgDump(config, dumpPath, log) {
  const sslmode = (process.env.DB_SSLMODE || 'require').trim() || 'require';
  if (['disable', 'allow', 'prefer'].includes(sslmode)) {
    throw new BackupError(
      `DB_SSLMODE='${sslmode}' would permit an unencrypted connection; ` +
        "DigitalOcean Managed PostgreSQL requires 'require' or stricter",
    );
  }

  const args = [
    '--host', config.DB_HOST,
    '--port', config.DB_PORT,
    '--username', config.DB_USER,
    '--dbname', config.DB_NAME,
    '--format=custom',
    '--compress=9',
    '--no-password', // never block on an interactive prompt
    '--verbose',
    `--file=${dumpPath}`,
  ];

  // The password goes through the child environment, never argv: argv is
  // readable by any process that can see /proc.
  const childEnv = {
    ...process.env,
    PGPASSWORD: config.DB_PASSWORD,
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '30',
  };

  log.info(
    `starting pg_dump: ${config.DB_USER}@${config.DB_HOST}:` +
      `${config.DB_PORT}/${config.DB_NAME} ` +
      `format=custom compress=9 sslmode=${sslmode} -> ${dumpPath}`,
  );

  const started = process.hrtime.bigint();
  const secrets = [...SECRET_VARS].map((name) => config[name]).filter(Boolean);

  const result = await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('pg_dump', args, { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    const stderrChunks = [];
    let timedOut = false;

    // An explicit timer rather than spawn's `timeout` option, so the timeout
    // can be distinguished from any other kill with certainty.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, DUMP_TIMEOUT_SECONDS * 1000);

    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
    child.stdout.on('data', () => {}); // drain; -Fc output goes to --file

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        timedOut,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  }).catch((err) => {
    if (err.code === 'ENOENT') {
      throw new BackupError(
        'pg_dump binary not found on PATH -- the image must install ' +
          "postgresql-client matching the server's major version",
      );
    }
    throw new BackupError(`could not execute pg_dump (${err.message})`);
  });

  const duration = Number(process.hrtime.bigint() - started) / 1e9;

  if (result.timedOut) {
    throw new BackupError(
      `pg_dump exceeded DUMP_TIMEOUT_SECONDS=${DUMP_TIMEOUT_SECONDS} ` +
        'and was killed; raise the limit or investigate a hung connection',
    );
  }

  if (result.code !== 0) {
    const stderr = redact(result.stderr.trim(), secrets);
    const lines = stderr ? stderr.split(/\r?\n/).slice(-6) : ['<no stderr output>'];
    const how =
      result.code === null
        ? `was killed by signal ${result.signal}`
        : `exited ${result.code}`;
    throw new BackupError(
      `pg_dump ${how} after ${duration.toFixed(1)}s. ` +
        `pg_dump stderr (last lines): ${lines.join(' | ')}`,
    );
  }

  log.info(`dump duration: ${duration.toFixed(1)}s (pg_dump exit 0)`);

  // pg_dump can exit 0 having written nothing useful; verify the artifact.
  if (!fs.existsSync(dumpPath)) {
    throw new BackupError(
      `pg_dump exited 0 but ${dumpPath} does not exist -- ` +
        'no dump file was produced',
    );
  }

  const size = fs.statSync(dumpPath).size;
  if (size === 0) {
    throw new BackupError(
      `pg_dump produced a 0-byte file at ${dumpPath}; treating as failure`,
    );
  }

  const magic = Buffer.alloc(PGDMP_MAGIC.length);
  const fd = fs.openSync(dumpPath, 'r');
  try {
    fs.readSync(fd, magic, 0, magic.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (!magic.equals(PGDMP_MAGIC)) {
    throw new BackupError(
      `${dumpPath} does not start with the PGDMP custom-format header ` +
        `(read ${JSON.stringify(magic.toString('latin1'))}); ` +
        'the dump is truncated or corrupt',
    );
  }

  log.info(`dump file size: ${humanSize(size)} (custom-format header verified)`);
  return size;
}

// ---------------------------------------------------------------------------
// Step 2: upload
// ---------------------------------------------------------------------------

function buildS3Client(config) {
  let endpoint = config.SPACES_ENDPOINT;
  if (!/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
  if (endpoint.startsWith('http://')) {
    throw new BackupError(
      'SPACES_ENDPOINT must use https:// -- refusing to send a database ' +
        'dump and credentials over plaintext HTTP',
    );
  }

  try {
    return new S3Client({
      endpoint,
      region: config.SPACES_REGION,
      credentials: {
        accessKeyId: config.SPACES_ACCESS_KEY,
        secretAccessKey: config.SPACES_SECRET_KEY,
      },
      // DigitalOcean Spaces uses virtual-hosted-style addressing
      // (<bucket>.<region>.digitaloceanspaces.com), which is the default.
      // Set SPACES_FORCE_PATH_STYLE=true for S3-compatible servers that
      // require path-style addressing (MinIO without a configured domain).
      forcePathStyle: (process.env.SPACES_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
      // Recent AWS SDK versions attach CRC32 "flexible checksum" headers to
      // every upload by default. Non-AWS S3 implementations, DigitalOcean
      // Spaces included, have rejected those requests. WHEN_REQUIRED keeps
      // the SDK to checksums the operation genuinely needs.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  } catch (err) {
    throw new BackupError(
      `could not build the Spaces client (${err.name}: ${err.message}) -- ` +
        'check SPACES_ENDPOINT and SPACES_REGION',
    );
  }
}

/** Turn an AWS SDK error into an actionable sentence. */
function describeS3Error(err, bucket, key) {
  const status = err?.$metadata?.httpStatusCode;

  // No HTTP status means the request never got a reply: DNS, TLS, refused
  // connection, timeout. Those need a different fix than an API rejection.
  if (status === undefined) {
    const cause = err?.cause?.message || err?.message || String(err);
    return (
      `could not reach Spaces at all (${err?.name || 'Error'}: ${cause}) -- ` +
      'check SPACES_ENDPOINT, DNS, and outbound network access from the container'
    );
  }

  const code = err.name || 'Unknown';
  const hints = {
    AccessDenied:
      'the Spaces key lacks permission for this operation on ' +
      `bucket '${bucket}' -- it needs PutObject and GetObject`,
    InvalidAccessKeyId: 'SPACES_ACCESS_KEY is not a valid key for this endpoint',
    SignatureDoesNotMatch: 'SPACES_SECRET_KEY does not match SPACES_ACCESS_KEY',
    NoSuchBucket: `bucket '${bucket}' does not exist at this endpoint/region`,
    RequestTimeTooSkewed: 'the container clock is too far from real time',
  };
  const detail =
    `Spaces API error ${code} (HTTP ${status}) for s3://${bucket}/${key}: ` +
    `${err.message}`;
  return hints[code] ? `${detail} -- ${hints[code]}` : detail;
}

async function uploadDump(s3, config, dumpPath, remoteKey, localSize, log) {
  const bucket = config.SPACES_BUCKET;
  log.info(`uploading ${path.basename(dumpPath)} -> s3://${bucket}/${remoteKey}`);
  const started = process.hrtime.bigint();

  let stream;
  try {
    stream = fs.createReadStream(dumpPath);
  } catch (err) {
    throw new BackupError(
      `upload failed: could not read local dump ${dumpPath} (${err.message})`,
    );
  }

  try {
    // lib-storage's Upload switches to multipart automatically, so a dump
    // larger than the 5 GB single-PUT limit still uploads.
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: remoteKey,
        Body: stream,
        ContentType: 'application/octet-stream',
      },
      queueSize: 4,
      partSize: 16 * 1024 * 1024,
    });
    await upload.done();
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EACCES') {
      throw new BackupError(
        `upload failed: could not read local dump ${dumpPath} (${err.message})`,
      );
    }
    throw new BackupError(`upload failed: ${describeS3Error(err, bucket, remoteKey)}`);
  } finally {
    stream.destroy();
  }

  const duration = Number(process.hrtime.bigint() - started) / 1e9;
  const rate = duration > 0 ? localSize / duration / 1024 / 1024 : 0;
  log.info(
    `upload result: call returned successfully in ${duration.toFixed(1)}s ` +
      `(${rate.toFixed(2)} MiB/s) -- not yet trusted, verifying independently`,
  );
}

// ---------------------------------------------------------------------------
// Step 3: independent verification
// ---------------------------------------------------------------------------

/**
 * Confirm the object exists in Spaces with the exact expected size.
 *
 * This is a fresh HEAD request rather than a reading of the upload's return
 * value: the upload reporting success is not evidence that a correctly sized
 * object is now readable.
 */
async function verifyRemoteObject(s3, config, remoteKey, expectedSize, log) {
  const bucket = config.SPACES_BUCKET;
  log.info(`verifying s3://${bucket}/${remoteKey} with a HEAD request`);

  let head;
  try {
    head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: remoteKey }));
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NotFound' || err?.name === 'NoSuchKey') {
      throw new BackupError(
        `verification failed: s3://${bucket}/${remoteKey} does not exist ` +
          'after an upload that reported success',
      );
    }
    throw new BackupError(
      `verification failed: ${describeS3Error(err, bucket, remoteKey)}`,
    );
  }

  const remoteSize = head.ContentLength;
  if (remoteSize !== expectedSize) {
    throw new BackupError(
      `verification failed: size mismatch for s3://${bucket}/${remoteKey} -- ` +
        `local ${expectedSize} bytes, remote ${remoteSize} bytes`,
    );
  }

  const etag = String(head.ETag || '').replaceAll('"', '');
  log.info(
    `verification result: OK -- object exists, ${humanSize(remoteSize)} ` +
      `matches local size, etag=${etag || 'n/a'}`,
  );
}

// ---------------------------------------------------------------------------
// Step 4: local cleanup (safety net only)
// ---------------------------------------------------------------------------

/**
 * Delete local *.dump files older than the retention window.
 *
 * Purely a local disk safety net. Remote retention belongs to a Spaces
 * lifecycle rule; nothing here ever issues a remote delete. Failures are
 * warnings: a stale local file must not turn a verified backup into a
 * reported failure.
 */
function cleanupOldDumps(log, retentionDays = LOCAL_RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * 86400 * 1000;
  const cutoffLabel = `${new Date(cutoff).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  log.info(
    `local cleanup: removing *.dump in ${STAGING_DIR} older than ` +
      `${retentionDays} day(s) (before ${cutoffLabel})`,
  );

  let entries;
  try {
    entries = fs.readdirSync(STAGING_DIR).filter((name) => name.endsWith('.dump')).sort();
  } catch (err) {
    log.warn(`local cleanup skipped: cannot list ${STAGING_DIR} (${err.message})`);
    return;
  }

  let removed = 0;
  let freed = 0;
  for (const name of entries) {
    const target = path.join(STAGING_DIR, name);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`local cleanup: could not inspect ${name} (${err.message})`);
      }
      continue;
    }
    if (stat.mtimeMs >= cutoff) continue;

    try {
      fs.unlinkSync(target);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn(`local cleanup: could not remove ${name} (${err.message})`);
      }
      continue;
    }
    removed += 1;
    freed += stat.size;
    const mtime = `${new Date(stat.mtimeMs).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    log.info(`local cleanup: removed ${name} (mtime ${mtime})`);
  }

  if (removed > 0) {
    log.info(`local cleanup: removed ${removed} file(s), freed ${humanSize(freed)}`);
  } else {
    log.info('local cleanup: nothing older than the retention window');
  }
}

/** Run the retention sweep without letting it change the run's verdict. */
function safeCleanup(log) {
  try {
    cleanupOldDumps(log);
  } catch (err) {
    log.warn(`local cleanup raised ${err.name}: ${err.message}; ignoring`);
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function runBackup(log, state, { dumpOnly = false } = {}) {
  const config = loadConfig(log, { dumpOnly });
  ensureStaging(log);

  const dumpName = buildDumpName(config.DB_NAME);
  const dumpPath = path.join(STAGING_DIR, dumpName);
  const remoteKey = buildRemoteKey(REMOTE_PREFIX, dumpName);

  if (fs.existsSync(dumpPath)) {
    throw new BackupError(
      `${dumpPath} already exists -- refusing to overwrite a previous ` +
        'dump; move or remove it and re-run',
    );
  }

  const size = await runPgDump(config, dumpPath, log);

  if (dumpOnly) {
    // Local dump only: nothing is uploaded, nothing is verified, and the
    // file is deliberately kept. This is NOT a backup -- a dump that exists
    // only on the container's own volume has not survived anything.
    log.info(`dump retained locally: ${dumpPath}`);
    log.info(`size on disk: ${humanSize(size)}`);
    log.info('skipped: upload, remote verification, local deletion (--dump-only)');
    return { dumpOnly: true, dumpPath, size };
  }

  const s3 = buildS3Client(config);
  state.s3 = s3; // so main() can release its sockets on every path
  await uploadDump(s3, config, dumpPath, remoteKey, size, log);
  await verifyRemoteObject(s3, config, remoteKey, size, log);

  // Verification passed, and only now is the local copy expendable.
  try {
    fs.unlinkSync(dumpPath);
    log.info(
      `local dump deleted after successful verification: ${path.basename(dumpPath)}`,
    );
  } catch (err) {
    log.warn(
      `backup is safely in Spaces but the local file ${dumpPath} could not ` +
        `be deleted (${err.message}); it will be pruned by the retention sweep`,
    );
  }

  log.info(`remote object: s3://${config.SPACES_BUCKET}/${remoteKey}`);
  return { dumpOnly: false, dumpPath, size, remoteKey };
}

const USAGE = `Usage: node pg_backup.js [--dump-only]

  (no flags)    dump -> upload to Spaces -> verify -> delete local copy.
                Requires all DB_* and SPACES_* variables. This is what
                Coolify's Scheduled Task runs.

  --dump-only   dump to STAGING_DIR and stop. Requires only DB_* variables.
                Nothing is uploaded, nothing is verified, and the local file
                is kept. Not a backup -- for a local copy or a smoke test.

  -h, --help    show this help.
`;

/** Parse argv. Unknown flags are rejected rather than ignored: silently
 *  treating a typo'd `--dumponly` as a full run would try to upload. */
function parseCliArgs(argv) {
  const options = { dumpOnly: false, help: false };
  for (const arg of argv) {
    if (arg === '--dump-only') options.dumpOnly = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else {
      throw new ConfigError(
        `unknown argument '${arg}'

${USAGE}`,
      );
    }
  }
  return options;
}

async function main(argv = []) {
  const log = new Logger(LOG_FILE);

  let options;
  try {
    options = parseCliArgs(argv);
  } catch (err) {
    log.error(`BACKUP FAILED: ${err.message}`);
    return err.exitCode;
  }

  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const { dumpOnly } = options;
  log.info('='.repeat(72));
  log.info(
    dumpOnly
      ? 'DUMP START (--dump-only: local dump, no upload, no verification)'
      : 'BACKUP START (single run, no in-script scheduling)',
  );

  const started = process.hrtime.bigint();
  const state = { s3: null };
  let exitCode = 0;

  try {
    await runBackup(log, state, { dumpOnly });
  } catch (err) {
    const verdict = dumpOnly ? 'DUMP FAILED' : 'BACKUP FAILED';
    if (err instanceof BackupError) {
      log.error(`${verdict}: ${err.message}`);
      log.error('local dump file, if any, has been preserved for recovery');
      exitCode = err.exitCode;
    } else {
      // Last-resort net: never let a raw stack trace be the only output.
      log.error(
        `${verdict}: unexpected ${err?.name || 'Error'}: ${err?.message || err} ` +
          '(this is a bug in pg_backup.js; the local dump, if any, was kept)',
      );
      exitCode = 1;
    }
  } finally {
    // Release the SDK's keep-alive sockets so the event loop can drain and
    // the process exits on its own.
    state.s3?.destroy();
  }

  if (dumpOnly) {
    // Deliberately no retention sweep here: the point of --dump-only is to
    // accumulate local dumps, so pruning them would be a nasty surprise.
    log.info('local retention sweep skipped in --dump-only mode');
  } else {
    safeCleanup(log);
  }

  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
  log.info(`total elapsed: ${elapsed.toFixed(1)}s`);
  if (exitCode === 0) {
    // A distinct verdict on purpose: 'BACKUP SUCCESS' must only ever mean
    // "uploaded and independently verified", so log greps stay trustworthy.
    log.info(dumpOnly ? 'DUMP SUCCESS (local only -- not uploaded, not verified)' : 'BACKUP SUCCESS');
  }
  return exitCode;
}

// Run only when invoked as the command, so the module can also be imported
// (by tests, or by other code) without kicking off a backup.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  // Set process.exitCode rather than calling process.exit(): stdout is
  // asynchronous when piped (which is how Coolify captures it), and exiting
  // outright can truncate the final log line.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.log(
        `[${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC] [ERROR] ` +
          `BACKUP FAILED: fatal error before logging was ready: ${err?.message || err}`,
      );
      process.exitCode = 1;
    },
  );
}

export {
  BackupError,
  ConfigError,
  Logger,
  buildS3Client,
  cleanupOldDumps,
  describeS3Error,
  humanSize,
  loadConfig,
  main,
  parseCliArgs,
  redact,
  runPgDump,
  uploadDump,
  verifyRemoteObject,
};
