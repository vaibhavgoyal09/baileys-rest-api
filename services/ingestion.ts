import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";
import { logger, errorLogger } from "../utils/logger.js";
import Store from "./prismaStore.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type MessageInfo = {
  id: string;
  from: string;
  fromMe: boolean;
  timestamp: number; // seconds epoch
  type: string;
  pushName: string | null;
  content: any;
  isGroup: boolean;
};

type IngestRecord = {
  idempotencyKey: string;
  correlationId: string;
  receivedAt: number; // ms epoch
  payload: MessageInfo;
};

type RetryPolicy = {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  maxHorizonMs: number;
};

type IngestionConfig = {
  logPath: string;
  checkpointPath: string;
  dlqPath: string;
  queueCapacity: number;
  batchSize: number;
  batchMaxWaitMs: number;
  workers: number;
  retry: RetryPolicy;
};

function nowMs() {
  return Date.now();
}
function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
function jitteredBackoff(attempt: number, base: number, max: number) {
  const exp = Math.min(max, base * Math.pow(2, attempt));
  const jitter = Math.floor(Math.random() * (exp * 0.2));
  return exp + jitter;
}

function ensureDirSync(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function computeIdempotencyKey(msg: MessageInfo): string {
  // Deterministic, stable per WhatsApp message id
  return `wa:${msg.id}`;
}

function computeCorrelationId(msg: MessageInfo): string {
  // Use id if available, else timestamp+from
  return msg?.id ? `cid:${msg.id}` : `cid:${msg.from}:${msg.timestamp}`;
}

class Metrics {
  received = 0;
  enqueued = 0;
  persisted = 0;
  retried = 0;
  deadLettered = 0;
  queueDepth = 0;
  workerUtilizationSamples: number[] = [];
  persistenceLatencies: number[] = [];
  errors: Record<string, number> = {};

  sampleWorkerUtilization(val: number) {
    this.workerUtilizationSamples.push(val);
    if (this.workerUtilizationSamples.length > 1000)
      this.workerUtilizationSamples.shift();
  }
  observeLatency(ms: number) {
    this.persistenceLatencies.push(ms);
    if (this.persistenceLatencies.length > 5000)
      this.persistenceLatencies.shift();
  }
  incError(code: string) {
    this.errors[code] = (this.errors[code] || 0) + 1;
  }
}

class AppendOnlyLog {
  private fd: fs.promises.FileHandle | null = null;
  private path: string;

  constructor(filePath: string) {
    this.path = filePath;
    ensureDirSync(path.dirname(this.path));
  }

  async open() {
    await fsp.mkdir(path.dirname(this.path), { recursive: true });
    this.fd = await fsp.open(this.path, "a+"); // read/append
  }

  async append(record: IngestRecord): Promise<void> {
    if (!this.fd) await this.open();
    const line = JSON.stringify(record) + "\n";
    await this.fd!.appendFile(line, "utf8");
    // fsync to ensure durability before ack
    await this.fd!.sync();
  }

  async sizeBytes(): Promise<number> {
    try {
      const st = await fsp.stat(this.path);
      return st.size;
    } catch {
      return 0;
    }
  }

  createReadStream(start = 0) {
    return fs.createReadStream(this.path, { start, encoding: "utf8" });
  }
}

class Checkpointer {
  private path: string;
  private currentOffset: number = 0;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<number> {
    try {
      const txt = await fsp.readFile(this.path, "utf8");
      const off = Number(txt.trim());
      if (!Number.isFinite(off)) return 0;
      this.currentOffset = off;
      return off;
    } catch {
      return 0;
    }
  }

  async save(offset: number): Promise<void> {
    this.currentOffset = offset;
    await fsp.mkdir(path.dirname(this.path), { recursive: true });
    await fsp.writeFile(this.path, String(offset), "utf8");
  }

  get offset() {
    return this.currentOffset;
  }
}

class AsyncBoundedQueue<T> {
  private buf: T[] = [];
  private capacity: number;
  private waiters: ((val: IteratorResult<T>) => void)[] = [];
  private ended = false;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  size() {
    return this.buf.length;
  }

  tryEnqueue(item: T): boolean {
    if (this.ended) return false;
    if (this.buf.length >= this.capacity) return false;
    this.buf.push(item);
    const waiter = this.waiters.shift();
    if (waiter) {
      const val = this.buf.shift()!;
      waiter({ value: val, done: false });
    }
    return true;
  }

  end() {
    this.ended = true;
    for (const w of this.waiters) w({ value: undefined as any, done: true });
    this.waiters = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buf.length > 0) {
        yield this.buf.shift()!;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<T>>((res) =>
        this.waiters.push(res),
      );
      if (next.done) return;
      else yield next.value!;
    }
  }
}

class IngestionService {
  private config: IngestionConfig;
  private log: AppendOnlyLog;
  private checkpointer: Checkpointer;
  private dlqPath: string;
  private queue: AsyncBoundedQueue<IngestRecord>;
  private metrics = new Metrics();
  private replaying = false;
  private workersRunning = false;

  constructor() {
    const dataDir = path.join(__dirname, "..", "data");
    const cfg: IngestionConfig = {
      logPath:
        process.env.INGEST_LOG_PATH || path.join(dataDir, "ingestion.log"),
      checkpointPath:
        process.env.INGEST_CHECKPOINT_PATH ||
        path.join(dataDir, "ingestion.offset"),
      dlqPath: process.env.INGEST_DLQ_PATH || path.join(dataDir, "dlq.log"),
      queueCapacity: Number(process.env.INGEST_QUEUE_CAPACITY || 5000),
      batchSize: Number(process.env.INGEST_BATCH_SIZE || 100),
      batchMaxWaitMs: Number(process.env.INGEST_BATCH_MAX_WAIT_MS || 250),
      workers: Number(process.env.INGEST_WORKERS || 2),
      retry: {
        baseMs: Number(process.env.INGEST_RETRY_BASE_MS || 100),
        maxMs: Number(process.env.INGEST_RETRY_MAX_MS || 5000),
        maxAttempts: Number(process.env.INGEST_RETRY_MAX_ATTEMPTS || 10),
        maxHorizonMs: Number(
          process.env.INGEST_RETRY_MAX_HORIZON_MS || 10 * 60 * 1000,
        ),
      },
    };

    this.config = cfg;
    this.log = new AppendOnlyLog(cfg.logPath);
    this.checkpointer = new Checkpointer(cfg.checkpointPath);
    this.dlqPath = cfg.dlqPath;
    this.queue = new AsyncBoundedQueue<IngestRecord>(cfg.queueCapacity);
  }

  getMetricsSnapshot() {
    const utilAvg = this.metrics.workerUtilizationSamples.length
      ? this.metrics.workerUtilizationSamples.reduce((a, b) => a + b, 0) /
        this.metrics.workerUtilizationSamples.length
      : 0;
    const latencies = this.metrics.persistenceLatencies
      .slice()
      .sort((a, b) => a - b);
    const p50 = latencies.length
      ? latencies[Math.floor(0.5 * (latencies.length - 1))]
      : 0;
    const p95 = latencies.length
      ? latencies[Math.floor(0.95 * (latencies.length - 1))]
      : 0;
    return {
      counters: {
        received: this.metrics.received,
        enqueued: this.metrics.enqueued,
        persisted: this.metrics.persisted,
        retried: this.metrics.retried,
        deadLettered: this.metrics.deadLettered,
        errors: this.metrics.errors,
      },
      queueDepth: this.queue.size(),
      workerUtilizationAvg: utilAvg,
      latencyMs: { p50, p95 },
      checkpointOffset: this.checkpointer.offset,
    };
  }

  async start() {
    await this.log.open();
    const startOffset = await this.checkpointer.load();
    logger.info({
      msg: "Ingestion service starting",
      logPath: this.config.logPath,
      checkpointPath: this.config.checkpointPath,
      startOffset,
      workers: this.config.workers,
      batchSize: this.config.batchSize,
      queueCapacity: this.config.queueCapacity,
    });
    this.startWorkers().catch((e) => {
      errorLogger.error({
        msg: "Worker startup failure",
        error: e?.message || e,
      });
    });
    this.startReplayLoop().catch((e) => {
      errorLogger.error({ msg: "Replay loop failure", error: e?.message || e });
    });
    this.installShutdownHooks();
  }

  async enqueueMessage(
    msg: MessageInfo,
  ): Promise<{
    accepted: boolean;
    reason?: string;
    idempotencyKey: string;
    correlationId: string;
  }> {
    // validate
    if (!msg || !msg.id || !msg.from) {
      return {
        accepted: false,
        reason: "invalid_message",
        idempotencyKey: "",
        correlationId: "",
      };
    }

    const record: IngestRecord = {
      idempotencyKey: computeIdempotencyKey(msg),
      correlationId: computeCorrelationId(msg),
      receivedAt: nowMs(),
      payload: msg,
    };

    try {
      // Append to durable log and fsync before ack
      await this.log.append(record);
      this.metrics.received += 1;
    } catch (e: any) {
      this.metrics.incError("log_append_failed");
      errorLogger.error({
        msg: "Failed to append ingest record to log",
        error: e?.message || e,
        idempotencyKey: record.idempotencyKey,
      });
      // retriable
      return {
        accepted: false,
        reason: "log_append_failed",
        idempotencyKey: record.idempotencyKey,
        correlationId: record.correlationId,
      };
    }

    // Best-effort enqueue into memory queue. If full, replay loop will still deliver from log.
    const enqOk = this.queue.tryEnqueue(record);
    if (enqOk) {
      this.metrics.enqueued += 1;
    } else {
      // backpressure: queue is full; caller already acked due to durable log; return accepted with overflow info
      logger.warn({
        msg: "In-memory queue full; relying on log replay",
        queueSize: this.queue.size(),
        idempotencyKey: record.idempotencyKey,
      });
    }

    return {
      accepted: true,
      idempotencyKey: record.idempotencyKey,
      correlationId: record.correlationId,
    };
  }

  async enqueueMessages(
    msgs: MessageInfo[],
  ): Promise<{ accepted: boolean; countAccepted: number }> {
    let ok = 0;
    for (const m of msgs) {
      const res = await this.enqueueMessage(m);
      if (res.accepted) ok += 1;
    }
    return { accepted: ok === msgs.length, countAccepted: ok };
  }

  private installShutdownHooks() {
    if ((global as any).__ingestionShutdownInstalled) return;
    (global as any).__ingestionShutdownInstalled = true;
    const shutdown = async (signal: string) => {
      try {
        logger.info({ msg: "Shutting down ingestion service", signal });
        // Stop accepting new work
        this.queue.end();
        // Allow some time for workers to flush
        await sleep(300);
      } finally {
        process.exit(0);
      }
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }

  private async startWorkers() {
    if (this.workersRunning) return;
    this.workersRunning = true;
    for (let i = 0; i < this.config.workers; i += 1) {
      this.workerLoop(i).catch((e) => {
        errorLogger.error({
          msg: "Worker loop crashed",
          worker: i,
          error: e?.message || e,
        });
      });
    }
  }

  private async workerLoop(workerId: number) {
    const batch: IngestRecord[] = [];
    let lastFlush = nowMs();
    for await (const item of this.queue) {
      batch.push(item);
      const age = nowMs() - lastFlush;
      if (
        batch.length >= this.config.batchSize ||
        age >= this.config.batchMaxWaitMs
      ) {
        await this.persistBatchWithRetry(
          workerId,
          batch.splice(0, batch.length),
        );
        lastFlush = nowMs();
      }
      // utilization sampling: simplistic
      this.metrics.sampleWorkerUtilization(1);
    }
    // flush leftovers
    if (batch.length) {
      await this.persistBatchWithRetry(workerId, batch.splice(0, batch.length));
    }
  }

  private async persistBatchWithRetry(
    workerId: number,
    records: IngestRecord[],
  ) {
    const started = nowMs();
    console.log("Starting batch persistence - worker:", workerId, "batchSize:", records.length, "sampleMessageId:", records[0]?.payload?.id);
    try {
      await this.persistBatchSplitOnFailure(records, 0);
      const took = nowMs() - started;
      this.metrics.observeLatency(took);
      this.metrics.persisted += records.length;
      console.log("Successfully persisted batch - worker:", workerId, "size:", records.length, "tookMs:", took, "sampleMessageId:", records[0]?.payload?.id);
    } catch (e: any) {
      // Should not reach here; failures are handled with DLQ inside persistBatchSplitOnFailure
      console.log("Unhandled persistBatchWithRetry error:", e?.message || e);
    }
  }

  private isTransientError(err: any): boolean {
    const msg = (err?.message || String(err)).toLowerCase();
    return (
      msg.includes("busy") ||
      msg.includes("locked") ||
      msg.includes("timeout") ||
      msg.includes("ioerr") ||
      msg.includes("database is locked")
    );
  }

  private async persistBatchSplitOnFailure(
    records: IngestRecord[],
    depth: number,
  ): Promise<void> {
    if (records.length === 0) return;

    try {
      await this.persistOnce(records);
      return;
    } catch (e: any) {
      // If not transient, or we are down to single record, handle retries/DLQ per-record
      if (!this.isTransientError(e) || records.length === 1 || depth >= 20) {
        await this.persistEachWithRetryOrDlq(records);
        return;
      }
      // Split batch and try recursively (binary search to isolate bad record)
      const mid = Math.floor(records.length / 2);
      const left = records.slice(0, mid);
      const right = records.slice(mid);
      await this.persistBatchSplitOnFailure(left, depth + 1);
      await this.persistBatchSplitOnFailure(right, depth + 1);
    }
  }

  private async persistOnce(records: IngestRecord[]) {
    // Idempotent batch insert using upsert/ignore semantics in store
    const msgs = records.map((r) => ({
      ...r.payload,
      idempotencyKey: r.idempotencyKey,
    }));
    await Store.saveMessagesBatch(msgs as any);
  }

  private async persistEachWithRetryOrDlq(records: IngestRecord[]) {
    for (const rec of records) {
      let attempt = 0;
      const firstAt = rec.receivedAt;
      while (true) {
        try {
          await this.persistOnce([rec]);
          break; // success
        } catch (e: any) {
          this.metrics.retried += 1;
          const age = nowMs() - firstAt;
          if (
            !this.isTransientError(e) ||
            attempt >= this.config.retry.maxAttempts ||
            age >= this.config.retry.maxHorizonMs
          ) {
            await this.writeToDlq(rec, e);
            break;
          }
          const wait = jitteredBackoff(
            attempt,
            this.config.retry.baseMs,
            this.config.retry.maxMs,
          );
          attempt += 1;
          logger.warn({
            msg: "Transient error persisting single record, will retry",
            idempotencyKey: rec.idempotencyKey,
            attempt,
            waitMs: wait,
            error: e?.message || e,
          });
          await sleep(wait);
        }
      }
    }
  }

  private async writeToDlq(rec: IngestRecord, error: any) {
    try {
      await fsp.appendFile(
        this.dlqPath,
        JSON.stringify({
          ...rec,
          error: String(error?.message || error),
          deadLetteredAt: nowMs(),
        }) + "\n",
        "utf8",
      );
      this.metrics.deadLettered += 1;
      errorLogger.error({
        msg: "Record moved to DLQ",
        idempotencyKey: rec.idempotencyKey,
        error: error?.message || error,
      });
    } catch (writeErr: any) {
      this.metrics.incError("dlq_write_failed");
      errorLogger.error({
        msg: "Failed to write DLQ record",
        error: writeErr?.message || writeErr,
      });
    }
  }

  private async startReplayLoop() {
    if (this.replaying) return;
    this.replaying = true;

    // Load starting offset
    let offset = await this.checkpointer.load();

    // Initialize size to know when to tail
    let fileSize = await this.log.sizeBytes();
    if (offset > fileSize) {
      // file rotated/truncated, reset
      offset = 0;
      await this.checkpointer.save(0);
      fileSize = await this.log.sizeBytes();
    }

    // Continuous loop
    // Strategy: stream from current offset to EOF; enqueue into memory queue with backoff if full; update checkpoint as we advance byte offsets.
    // After reaching EOF, sleep briefly and check for file growth.
    while (true) {
      try {
        const stream = this.log.createReadStream(offset);
        const rl = readline.createInterface({
          input: stream,
          crlfDelay: Infinity,
        });

        let consumedBytes = 0;
        for await (const line of rl) {
          const lineBytes = Buffer.byteLength(line + "\n", "utf8");
          consumedBytes += lineBytes;

          if (!line.trim()) {
            offset += lineBytes;
            continue;
          }

          try {
            const rec: IngestRecord = JSON.parse(line);
            // Attempt to enqueue; if full, wait until space frees
            while (!this.queue.tryEnqueue(rec)) {
              await sleep(50);
            }
            this.metrics.enqueued += 1;
            offset += lineBytes;

            // checkpoint periodically
            if (this.metrics.enqueued % 1000 === 0) {
              await this.checkpointer.save(offset);
            }
          } catch (e: any) {
            this.metrics.incError("replay_parse_error");
            errorLogger.error({
              msg: "Failed to parse replay line",
              error: e?.message || e,
              atOffset: offset,
            });
            // Skip bad line but update offset to avoid infinite loop
            offset += Buffer.byteLength(line + "\n", "utf8");
            await this.checkpointer.save(offset);
          }
        }

        // End-of-file reached; persist final offset
        await this.checkpointer.save(offset);

        // Tail: wait and check if file grew
        await sleep(200);
        const newSize = await this.log.sizeBytes();
        if (newSize > offset) {
          // Continue loop to read new data
          continue;
        } else {
          // idle wait
          await sleep(300);
        }
      } catch (e: any) {
        this.metrics.incError("replay_loop_error");
        errorLogger.error({ msg: "Replay loop error", error: e?.message || e });
        await sleep(500);
      }
    }
  }
}

const ingestion = new IngestionService();
export default ingestion;
