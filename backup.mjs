import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { spawn } from 'child_process'
import { createGzip } from 'zlib'
import { PassThrough } from 'stream'
import cron from 'node-cron'

const required = (name) => {
  const val = process.env[name]
  if (!val) throw new Error(`Missing required env var: ${name}`)
  return val
}

const DATABASE_URL = required('DATABASE_URL')
const S3_BUCKET = required('S3_BUCKET')
const S3_REGION = required('S3_REGION')
const S3_ACCESS_KEY_ID = required('S3_ACCESS_KEY_ID')
const S3_SECRET_ACCESS_KEY = required('S3_SECRET_ACCESS_KEY')
const S3_ENDPOINT = process.env.S3_ENDPOINT
const BACKUP_SCHEDULE = process.env.BACKUP_SCHEDULE || '0 2 * * *'
const RETENTION_DAYS = parseInt(process.env.RETENTION_DAYS || '7', 10)
const RUN_ON_START = process.env.RUN_ON_START === 'true'
const S3_PREFIX = process.env.S3_PREFIX || 'db-backups'

const s3 = new S3Client({
  region: S3_REGION,
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
  ...(S3_ENDPOINT ? { endpoint: S3_ENDPOINT, forcePathStyle: true } : {}),
})

function timestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '')
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

async function runBackup() {
  const key = `${S3_PREFIX}/${timestamp()}.sql.gz`
  log(`Starting backup → s3://${S3_BUCKET}/${key}`)

  const pgDump = spawn('pg_dump', ['--no-password', DATABASE_URL], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const stderrChunks = []
  pgDump.stderr.on('data', (chunk) => stderrChunks.push(chunk))

  const gzip = createGzip()
  const passThrough = new PassThrough()
  pgDump.stdout.pipe(gzip).pipe(passThrough)

  const uploadPromise = new Upload({
    client: s3,
    params: {
      Bucket: S3_BUCKET,
      Key: key,
      Body: passThrough,
      ContentType: 'application/gzip',
    },
    queueSize: 4,
    partSize: 10 * 1024 * 1024,
  }).done()

  const exitCode = await new Promise((resolve) => pgDump.on('close', resolve))

  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString()
    throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`)
  }

  await uploadPromise
  log(`Backup complete: ${key}`)

  await cleanOldBackups()
}

async function cleanOldBackups() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  let continuationToken
  const toDelete = []

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: `${S3_PREFIX}/`,
      ContinuationToken: continuationToken,
    }))

    for (const obj of res.Contents ?? []) {
      if (obj.LastModified < cutoff) toDelete.push({ Key: obj.Key })
    }

    continuationToken = res.NextContinuationToken
  } while (continuationToken)

  if (toDelete.length === 0) return

  await s3.send(new DeleteObjectsCommand({
    Bucket: S3_BUCKET,
    Delete: { Objects: toDelete },
  }))

  log(`Deleted ${toDelete.length} backup(s) older than ${RETENTION_DAYS} days`)
}

async function safeRun() {
  try {
    await runBackup()
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Backup failed:`, err.message)
  }
}

if (!cron.validate(BACKUP_SCHEDULE)) {
  throw new Error(`Invalid BACKUP_SCHEDULE: "${BACKUP_SCHEDULE}"`)
}

cron.schedule(BACKUP_SCHEDULE, safeRun)
log(`Backup service started — schedule: "${BACKUP_SCHEDULE}", retention: ${RETENTION_DAYS} days`)

if (RUN_ON_START) {
  log('RUN_ON_START=true — running immediate backup')
  safeRun()
}
