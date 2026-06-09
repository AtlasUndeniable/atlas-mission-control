/**
 * Locked read-modify-write for slack-queue.json.
 * Mirror of workspace lib/queue-writer.mjs for use inside Next.js API routes.
 */

import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
  existsSync,
} from "fs";
import { join, dirname } from "path";

const DEFAULT_QUEUE_PATH = "/Users/atlasai/.openclaw/data/slack-queue.json";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

function lockPathFor(queuePath: string): string {
  return queuePath + ".lock";
}

function acquireLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try { unlinkSync(lockPath); } catch { /* lock vanished */ }
          continue;
        }
      } catch {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`queue-writer: lock acquisition timed out after ${LOCK_MAX_WAIT_MS}ms`);
      }

      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function readQueue(queuePath: string): unknown[] {
  try {
    if (!existsSync(queuePath)) return [];
    const raw = JSON.parse(readFileSync(queuePath, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function atomicWrite(filePath: string, data: string): void {
  const tmp = join(dirname(filePath), `.slack-queue.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

export async function mutateQueue<T = unknown>(
  mutator: (queue: T[]) => T[] | Promise<T[]>,
  options: { queuePath?: string } = {},
): Promise<T[]> {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  const lockPath = lockPathFor(queuePath);

  acquireLock(lockPath);
  try {
    const queue = readQueue(queuePath) as T[];
    const result = await mutator(queue);
    const finalQueue = Array.isArray(result) ? result : queue;
    atomicWrite(queuePath, JSON.stringify(finalQueue, null, 2));
    return finalQueue;
  } finally {
    releaseLock(lockPath);
  }
}

export function peekQueue<T = unknown>(options: { queuePath?: string } = {}): T[] {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  return readQueue(queuePath) as T[];
}
