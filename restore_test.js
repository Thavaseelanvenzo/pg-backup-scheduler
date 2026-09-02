#!/usr/bin/env node
/**
 * Manual restore verification. NOT scheduled -- run this by hand.
 *
 * A backup you have never restored is a hypothesis, not a backup. This
 * script takes a custom-format dump (local, or downloaded from Spaces) and
 * restores it into a *separate test database* with pg_restore.
 *
 * Usage:
 *     # restore a local dump file
 *     node restore_test.js --file /app/staging/database_2026-09-02_020000.dump
 *
 *     # download a dump from Spaces first, then restore it
 *     node restore_test.js --key postgres-backups/2026-09-02/database_020000.dump
 *
 *     # list what is available in Spaces
 *     node restore_test.js --list
 *     node restore_test.js --list --list-prefix postgres-backups/2026-09-02/
 *
 * Required environment (in addition to the backup script's variables):
 *     TEST_DB_NAME      target database for the restore -- must NOT equal DB_NAME
 *     TEST_DB_HOST      defaults to DB_HOST
 *     TEST_DB_PORT      defaults to DB_PORT
 *     TEST_DB_USER      defaults to DB_USER (needs write access to TEST_DB_NAME)
 *     TEST_DB_PASSWORD  defaults to DB_PASSWORD
 *
 * Guard rails:
 *   * The script refuses to run if the resolved target database name matches
 *     DB_NAME on the same host:port -- production is never a restore target.
 *   * The restore is additive by default. Pass --clean to have pg_restore
 *     drop objects first; that flag is only honoured after an explicit
 *     --i-know-this-is-not-production confirmation.
 *
 * Exit codes:
 *     0  restore completed (warnings from pg_restore are reported but tolerated)
 *     1  restore failed
 *     2  configuration or argument error
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';

import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const STAGING_DIR = process.env.STAGING_DIR || '/app/staging';
const RESTORE_TIMEOUT_SECONDS = Number(process.env.RESTORE_TIMEOUT_SECONDS || '7200');
const PGDMP_MAGIC = Buffer.from('PGDMP');

function log(message) {
  const stamp = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  console.log(`[${stamp}] ${message}`);
}

/** A failure whose message is safe to print verbatim (no secrets). */
class RestoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RestoreError';
    this.exitCode = 1;
  }
}

/** Bad configuration or arguments -- distinct exit code from a real failure. */
class UsageError extends RestoreError {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.exitCode = 2;
  }
}

function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret && out.includes(secret)) {
      out = out.split(secret).join('***REDACTED***');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function require_(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    throw new UsageError(
      `missing required environment variable ${name} -- ` +
        "set it in Coolify's Environment Variables UI",
    );
  }
  return value;
}

/** Resolve the restore target and refuse anything that looks like prod. */
function loadTarget() {
  const sourceHost = (process.env.DB_HOST || '').trim();
  const sourcePort = (process.env.DB_PORT || '').trim();
  const sourceName = (process.env.DB_NAME || '').trim();

  const target = {
    host: (process.env.TEST_DB_HOST || '').trim() || sourceHost,
    port: (process.env.TEST_DB_PORT || '').trim() || sourcePort,
    user: (process.env.TEST_DB_USER || '').trim() || (process.env.DB_USER || '').trim(),
    password:
      (process.env.TEST_DB_PASSWORD || '').trim() ||
      (process.env.DB_PASSWORD || '').trim(),
    name: require_('TEST_DB_NAME'),
  };

  for (const key of ['host', 'port', 'user', 'password']) {
    if (!target[key]) {
      throw new UsageError(
        `cannot resolve the restore target's ${key}: set ` +
          `TEST_DB_${key.toUpperCase()} (or the corresponding ` +
          `DB_${key.toUpperCase()} fallback)`,
      );
    }
  }

  const sameServer = target.host === sourceHost && target.port === sourcePort;
  if (sameServer && sourceName && target.name === sourceName) {
    throw new UsageError(
      `refusing to restore into ${target.name} on ` +
        `${target.host}:${target.port} -- that is the source database named ` +
        'by DB_NAME. Point TEST_DB_NAME at a separate test database.',
    );
  }

  log(
    `restore target: ${target.user}@${target.host}:${target.port}/${target.name} ` +
      `(source DB_NAME=${sourceName || 'unset'})`,
  );
  return target;
}

function buildS3Client() {
  let endpoint = require_('SPACES_ENDPOINT');
  if (!/^https?:\/\//.test(endpoint)) endpoint = `https://${endpoint}`;
  const bucket = require_('SPACES_BUCKET');
  const region = require_('SPACES_REGION');
  const accessKeyId = require_('SPACES_ACCESS_KEY');
  const secretAccessKey = require_('SPACES_SECRET_KEY');

  try {
    const client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle:
        (process.env.SPACES_FORCE_PATH_STYLE || '').toLowerCase() === 'true',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
    return { client, bucket };
  } catch (err) {
    throw new RestoreError(
      `could not build the Spaces client (${err.name}: ${err.message})`,
    );
  }
}

function describeS3Error(err, bucket) {
  const status = err?.$metadata?.httpStatusCode;
  if (status === undefined) {
    const cause = err?.cause?.message || err?.message || String(err);
    return (
      `could not reach Spaces (${err?.name || 'Error'}: ${cause}) -- ` +
      'check SPACES_ENDPOINT, DNS, and outbound network access'
    );
  }
  return `Spaces error ${err.name || 'Unknown'} (HTTP ${status}) on bucket '${bucket}': ${err.message}`;
}

// ---------------------------------------------------------------------------
// Spaces operations
// ---------------------------------------------------------------------------

async function listBackups(prefix) {
  const { client, bucket } = buildS3Client();
  log(`listing s3://${bucket}/${prefix}`);
  try {
    let token;
    let found = 0;
    do {
      const page = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const obj of page.Contents || []) {
        const when = new Date(obj.LastModified).toISOString().slice(0, 19).replace('T', ' ');
        const sizeMib = (obj.Size / 1024 / 1024).toFixed(2);
        console.log(`  ${when}  ${sizeMib.padStart(10)} MiB  ${obj.Key}`);
        found += 1;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);

    if (found === 0) log(`no objects found under prefix '${prefix}'`);
    else log(`${found} object(s) listed`);
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    const extra =
      status === 403
        ? ' -- the key needs ListBucket permission for this operation'
        : '';
    throw new RestoreError(`could not list backups: ${describeS3Error(err, bucket)}${extra}`);
  } finally {
    client.destroy();
  }
}

async function downloadDump(key) {
  const { client, bucket } = buildS3Client();
  const destination = path.join(STAGING_DIR, `restore_${path.basename(key)}`);

  try {
    fs.mkdirSync(STAGING_DIR, { recursive: true });
  } catch (err) {
    throw new RestoreError(`cannot create ${STAGING_DIR} (${err.message})`);
  }

  log(`downloading s3://${bucket}/${key} -> ${destination}`);
  const started = process.hrtime.bigint();
  try {
    const response = await client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    await pipeline(response.Body, fs.createWriteStream(destination));
  } catch (err) {
    const status = err?.$metadata?.httpStatusCode;
    if (status === 404 || err?.name === 'NoSuchKey' || err?.name === 'NotFound') {
      throw new RestoreError(
        `s3://${bucket}/${key} does not exist -- ` +
          'run with --list to see available keys',
      );
    }
    if (err?.code === 'EACCES' || err?.code === 'ENOSPC') {
      throw new RestoreError(
        `could not write ${destination} (${err.code}): ${err.message}`,
      );
    }
    throw new RestoreError(`download failed: ${describeS3Error(err, bucket)}`);
  } finally {
    client.destroy();
  }

  const size = fs.statSync(destination).size;
  const duration = Number(process.hrtime.bigint() - started) / 1e9;
  log(`downloaded ${(size / 1024 / 1024).toFixed(2)} MiB in ${duration.toFixed(1)}s`);
  return destination;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

function validateDump(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new RestoreError(`${target} does not exist or is not readable`);
  }
  if (!stat.isFile()) {
    throw new RestoreError(`${target} is not a regular file`);
  }
  if (stat.size === 0) {
    throw new RestoreError(`${target} is empty`);
  }

  const magic = Buffer.alloc(PGDMP_MAGIC.length);
  let fd;
  try {
    fd = fs.openSync(target, 'r');
    fs.readSync(fd, magic, 0, magic.length, 0);
  } catch (err) {
    throw new RestoreError(`cannot read ${target} (${err.message})`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  if (!magic.equals(PGDMP_MAGIC)) {
    throw new RestoreError(
      `${target} is not a pg_dump custom-format file ` +
        `(header ${JSON.stringify(magic.toString('latin1'))}); this script ` +
        'only restores dumps produced with pg_dump -Fc',
    );
  }
  log(`dump file validated: ${target} (${stat.size} bytes, PGDMP header)`);
}

/** Run a child process to completion, capturing stderr. */
function runChild(command, args, childEnv, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
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
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

async function runPgRestore(target, dumpPath, jobs, clean) {
  const sslmode = (process.env.DB_SSLMODE || 'require').trim() || 'require';

  const args = [
    '--host', target.host,
    '--port', target.port,
    '--username', target.user,
    '--dbname', target.name,
    '--no-password',
    '--verbose',
    '--no-owner',
    '--no-privileges',
    `--jobs=${jobs}`,
  ];
  if (clean) args.push('--clean', '--if-exists');
  args.push(dumpPath);

  const childEnv = {
    ...process.env,
    PGPASSWORD: target.password,
    PGSSLMODE: sslmode,
    PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT || '30',
  };

  log(
    `starting pg_restore into ${target.name} ` +
      `(jobs=${jobs}, clean=${clean}, sslmode=${sslmode})`,
  );
  const started = process.hrtime.bigint();

  let result;
  try {
    result = await runChild('pg_restore', args, childEnv, RESTORE_TIMEOUT_SECONDS);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new RestoreError(
        'pg_restore binary not found on PATH -- the image must install ' +
          'postgresql-client',
      );
    }
    throw new RestoreError(`could not execute pg_restore (${err.message})`);
  }

  const duration = Number(process.hrtime.bigint() - started) / 1e9;

  if (result.timedOut) {
    throw new RestoreError(
      `pg_restore exceeded RESTORE_TIMEOUT_SECONDS=${RESTORE_TIMEOUT_SECONDS} ` +
        'and was killed',
    );
  }

  const secrets = [target.password, process.env.SPACES_SECRET_KEY || ''];
  const stderr = redact(result.stderr.trim(), secrets);

  if (result.code !== 0) {
    const lines = stderr ? stderr.split(/\r?\n/).slice(-15) : ['<no stderr output>'];
    const how =
      result.code === null
        ? `was killed by signal ${result.signal}`
        : `exited ${result.code}`;
    throw new RestoreError(
      `pg_restore ${how} after ${duration.toFixed(1)}s. ` +
        `stderr (last lines):\n  ${lines.join('\n  ')}`,
    );
  }

  // pg_restore reports non-fatal problems on stderr while still exiting 0
  // (missing roles, existing extensions). Surface them; do not fail on them.
  const warnings = stderr
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes('warning'));
  log(`pg_restore completed in ${duration.toFixed(1)}s (exit 0)`);
  if (warnings.length > 0) {
    log(`pg_restore emitted ${warnings.length} warning line(s):`);
    for (const line of warnings.slice(0, 15)) console.log(`  ${line}`);
  }
}

/** Sanity-check the restore by counting relations in the test database. */
async function reportTableCounts(target) {
  const query =
    'SELECT count(*) FROM information_schema.tables ' +
    "WHERE table_schema NOT IN ('pg_catalog','information_schema')";
  const args = [
    '--host', target.host,
    '--port', target.port,
    '--username', target.user,
    '--dbname', target.name,
    '--no-password',
    '--tuples-only',
    '--no-align',
    '--command', query,
  ];
  const childEnv = {
    ...process.env,
    PGPASSWORD: target.password,
    PGSSLMODE: (process.env.DB_SSLMODE || 'require').trim() || 'require',
  };

  let result;
  try {
    result = await runChild('psql', args, childEnv, 120);
  } catch (err) {
    log(`post-restore table count unavailable (${err.name}: ${err.message})`);
    return;
  }

  if (result.timedOut || result.code !== 0) {
    const lines = result.stderr.trim().split(/\r?\n/);
    log(`post-restore table count query failed: ${lines.at(-1) || '?'}`);
    return;
  }

  log(
    `post-restore check: ${result.stdout.trim()} user table(s) present in ${target.name}`,
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const USAGE = `Restore a pg_dump custom-format backup into a TEST database.

Usage:
  node restore_test.js --file <path>          restore a local .dump file
  node restore_test.js --key <object-key>     download from Spaces, then restore
  node restore_test.js --list                 list available backups and exit

Options:
  --file <path>                        path to a local .dump file
  --key <key>                          Spaces object key to download and restore
  --list                               list available backups in Spaces and exit
  --list-prefix <prefix>               prefix to list with --list
                                       (default: postgres-backups/)
  --jobs <n>                           pg_restore parallel jobs (default: 2)
  --clean                              pass --clean --if-exists to pg_restore
                                       (drops existing objects first)
  --i-know-this-is-not-production      required confirmation when using --clean
  --keep-download                      keep the file downloaded by --key
  -h, --help                           show this help and exit

Exactly one of --file, --key, or --list is required.
`;

function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        file: { type: 'string' },
        key: { type: 'string' },
        list: { type: 'boolean', default: false },
        'list-prefix': { type: 'string' },
        jobs: { type: 'string', default: '2' },
        clean: { type: 'boolean', default: false },
        'i-know-this-is-not-production': { type: 'boolean', default: false },
        'keep-download': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
      strict: true,
    });
  } catch (err) {
    throw new UsageError(`${err.message}\n\n${USAGE}`);
  }

  const args = parsed.values;
  if (args.help) return { help: true };

  const sources = ['file', 'key', 'list'].filter((name) => args[name]);
  if (sources.length === 0) {
    throw new UsageError(
      `one of --file, --key, or --list is required\n\n${USAGE}`,
    );
  }
  if (sources.length > 1) {
    throw new UsageError(
      `--${sources.join(' and --')} are mutually exclusive; pass exactly one\n\n${USAGE}`,
    );
  }

  const jobs = Number(args.jobs);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new UsageError(`--jobs must be an integer of at least 1, got '${args.jobs}'`);
  }

  const defaultPrefix = `${(process.env.SPACES_PREFIX || 'postgres-backups').replace(/^\/+|\/+$/g, '')}/`;

  return {
    help: false,
    file: args.file,
    key: args.key,
    list: args.list,
    listPrefix: args['list-prefix'] || defaultPrefix,
    jobs,
    clean: args.clean,
    confirmed: args['i-know-this-is-not-production'],
    keepDownload: args['keep-download'],
  };
}

async function main(argv) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    log(`RESTORE FAILED: ${err.message}`);
    return err.exitCode ?? 2;
  }

  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  try {
    if (args.list) {
      await listBackups(args.listPrefix);
      return 0;
    }

    if (args.clean && !args.confirmed) {
      throw new UsageError(
        '--clean drops existing objects in the target database. Re-run with ' +
          '--i-know-this-is-not-production to confirm the target is a ' +
          'throwaway test database.',
      );
    }

    const target = loadTarget();

    let downloaded = null;
    let dumpPath;
    if (args.key) {
      downloaded = await downloadDump(args.key);
      dumpPath = downloaded;
    } else {
      dumpPath = args.file;
    }

    validateDump(dumpPath);
    await runPgRestore(target, dumpPath, args.jobs, args.clean);
    await reportTableCounts(target);

    if (downloaded && !args.keepDownload) {
      try {
        fs.unlinkSync(downloaded);
        log(`removed downloaded copy ${path.basename(downloaded)}`);
      } catch (err) {
        log(`could not remove ${downloaded} (${err.message}); harmless`);
      }
    }
  } catch (err) {
    if (err instanceof RestoreError) {
      log(`RESTORE FAILED: ${err.message}`);
      return err.exitCode;
    }
    // Never let a raw stack trace be the only output.
    log(`RESTORE FAILED: unexpected ${err?.name || 'Error'}: ${err?.message || err}`);
    return 1;
  }

  log('RESTORE SUCCESS');
  return 0;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      log(`RESTORE FAILED: fatal error: ${err?.message || err}`);
      process.exitCode = 1;
    },
  );
}

export { RestoreError, UsageError, main, parseCliArgs, redact, validateDump };
