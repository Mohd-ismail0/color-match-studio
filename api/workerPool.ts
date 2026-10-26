import { Worker } from 'node:worker_threads';
import type { ColorMatrix } from '../src/types/colorCorrector';
import { SERVER_LIMITS } from '../src/lib/calibrationLimits';

export interface ProcessedImageInfo {
  width: number;
  height: number;
  pixels: number;
  bitDepth: 8 | 16;
  sourceFormat: string;
}

export interface PoolResult {
  png: Buffer;
  info: ProcessedImageInfo;
}

export type PoolErrorCode =
  | 'QUEUE_FULL'
  | 'JOB_TIMEOUT'
  | 'QUEUE_TIMEOUT'
  | 'WORKER_FAILED'
  | 'SERVER_CLOSED';

export class PoolError extends Error {
  readonly code: PoolErrorCode;
  /** Error code reported by the isolated worker (e.g. IMAGE_TYPE_UNSUPPORTED). */
  readonly remoteCode?: string;

  constructor(code: PoolErrorCode, message: string, remoteCode?: string) {
    super(message);
    this.name = 'PoolError';
    this.code = code;
    this.remoteCode = remoteCode;
  }
}

interface Task {
  buffer: Buffer;
  matrix: ColorMatrix;
  resolve: (result: PoolResult) => void;
  reject: (error: Error) => void;
  queueTimer?: NodeJS.Timeout;
}

export interface WorkerPoolOptions {
  size?: number;
  queueLimit?: number;
  jobTimeoutMs?: number;
  queueTimeoutMs?: number;
  /** Test seam; defaults to the bundled image worker. */
  workerScript?: URL;
}

/**
 * Tiny worker pool. Each job runs in a fresh worker thread, so a pathological
 * image can be terminated at its deadline without touching the HTTP event loop.
 * The main thread never runs per-pixel code, keeping /health responsive.
 */
export class WorkerPool {
  private readonly size: number;
  private readonly queueLimit: number;
  private readonly jobTimeoutMs: number;
  private readonly queueTimeoutMs: number;
  private readonly workerScript: URL;
  private active = 0;
  private queued: Task[] = [];
  private workers = new Set<Worker>();
  private closed = false;
  private completed = 0;
  private failed = 0;
  private rejected = 0;

  constructor(options: WorkerPoolOptions = {}) {
    this.size = Math.max(1, options.size ?? SERVER_LIMITS.workerCount);
    this.queueLimit = Math.max(0, options.queueLimit ?? SERVER_LIMITS.maxQueueDepth);
    this.jobTimeoutMs = Math.max(1000, options.jobTimeoutMs ?? SERVER_LIMITS.jobTimeoutMs);
    this.queueTimeoutMs = Math.max(1000, options.queueTimeoutMs ?? SERVER_LIMITS.queueTimeoutMs);
    this.workerScript = options.workerScript ?? new URL('./imageWorker.ts', import.meta.url);
  }

  stats(): { active: number; queued: number; completed: number; failed: number; rejected: number } {
    return {
      active: this.active,
      queued: this.queued.length,
      completed: this.completed,
      failed: this.failed,
      rejected: this.rejected,
    };
  }

  run(buffer: Buffer, matrix: ColorMatrix): Promise<PoolResult> {
    if (this.closed) {
      return Promise.reject(new PoolError('SERVER_CLOSED', 'Server is shutting down'));
    }
    if (this.active >= this.size && this.queued.length >= this.queueLimit) {
      this.rejected += 1;
      return Promise.reject(new PoolError('QUEUE_FULL', 'Correction queue is full'));
    }
    return new Promise<PoolResult>((resolve, reject) => {
      const task: Task = { buffer, matrix, resolve, reject };
      task.queueTimer = setTimeout(() => {
        const index = this.queued.indexOf(task);
        if (index >= 0) {
          this.queued.splice(index, 1);
          this.rejected += 1;
          reject(new PoolError('QUEUE_TIMEOUT', 'Request waited too long in the correction queue'));
        }
      }, this.queueTimeoutMs);
      this.queued.push(task);
      this.drain();
    });
  }

  private drain(): void {
    while (!this.closed && this.active < this.size && this.queued.length > 0) {
      const task = this.queued.shift() as Task;
      if (task.queueTimer) clearTimeout(task.queueTimer);
      this.active += 1;
      this.spawn(task);
    }
  }

  private spawn(task: Task): void {
    const workerUrl = this.workerScript;
    const arrayBuffer = task.buffer.buffer.slice(
      task.buffer.byteOffset,
      task.buffer.byteOffset + task.buffer.byteLength
    );
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        workerData: { buffer: arrayBuffer, matrix: task.matrix },
        transferList: [arrayBuffer as ArrayBuffer],
        execArgv: workerUrl.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [],
      });
    } catch (error) {
      this.active = Math.max(0, this.active - 1);
      this.failed += 1;
      task.reject(
        new PoolError(
          'WORKER_FAILED',
          error instanceof Error ? error.message : 'Could not start image worker'
        )
      );
      this.drain();
      return;
    }
    this.workers.add(worker);
    let settled = false;

    const finish = (error: Error | null, result?: PoolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.workers.delete(worker);
      this.active = Math.max(0, this.active - 1);
      if (error) {
        this.failed += 1;
        task.reject(error);
      } else {
        this.completed += 1;
        task.resolve(result as PoolResult);
      }
      this.drain();
    };

    const timer = setTimeout(() => {
      void worker.terminate();
      finish(new PoolError('JOB_TIMEOUT', 'Image correction exceeded its time limit'));
    }, this.jobTimeoutMs);

    worker.once('message', (message: {
      ok: boolean;
      png?: ArrayBuffer;
      info?: ProcessedImageInfo;
      code?: string;
      message?: string;
    }) => {
      if (message?.ok && message.png && message.info) {
        finish(null, { png: Buffer.from(message.png), info: message.info });
      } else {
        finish(new PoolError('WORKER_FAILED', message?.message ?? 'Worker failed', message?.code));
      }
    });
    worker.once('error', (error) => {
      finish(new PoolError('WORKER_FAILED', error.message));
    });
    worker.once('exit', (code) => {
      if (!settled) finish(new PoolError('WORKER_FAILED', `Worker exited with code ${code}`));
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.queued.splice(0)) {
      if (task.queueTimer) clearTimeout(task.queueTimer);
      task.reject(new PoolError('SERVER_CLOSED', 'Server is shutting down'));
    }
    await Promise.all([...this.workers].map((worker) => worker.terminate()));
    this.workers.clear();
    this.active = 0;
  }
}
