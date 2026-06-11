/**
 * Shared locked read-modify-write for slack-queue.json.
 *
 * Guarantees:
 *   1. Only one process mutates the queue at a time (advisory file lock).
 *   2. Writes are atomic (temp file + rename on same filesystem).
 *   3. Corrupt/missing queue file degrades gracefully to [].
 *
 * Usage:
 *   import { mutateQueue } from "../../lib/queue-writer.mjs";
 *   await mutateQueue((queue) => { queue.push(entry); return queue; });
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
} from "node:fs";
import { join, dirname } from "node:path";

const DEFAULT_QUEUE_PATH = "/Users/atlasai/.openclaw/data/slack-queue.json";
const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5_000;

function lockPathFor(queuePath) {
  return queuePath + ".lock";
}

function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;

      // Lock exists — check staleness
      try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // Atomic steal: rename first, so exactly one contender wins. An
          // in-place unlink is NOT safe — two contenders can both see the
          // stale lock, and the slower unlink would delete the faster
          // contender's FRESH lock, letting both writers in at once.
          const stealPath = `${lockPath}.steal.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
          try {
            renameSync(lockPath, stealPath);
            try { unlinkSync(stealPath); } catch {}
          } catch {
            // Lost the steal race — another contender owns the cleanup.
          }
          continue;
        }
      } catch {
        // Lock vanished between EEXIST and stat — retry immediately
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(`queue-writer: lock acquisition timed out after ${LOCK_MAX_WAIT_MS}ms`);
      }

      // Busy-wait with small sleep (sync — acceptable for short-lived queue ops)
      const waitUntil = Date.now() + LOCK_RETRY_MS;
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

function releaseLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

function readQueue(queuePath) {
  try {
    if (!existsSync(queuePath)) return [];
    const raw = JSON.parse(readFileSync(queuePath, "utf-8"));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function atomicWrite(filePath, data) {
  const tmp = join(dirname(filePath), `.slack-queue.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data);
  renameSync(tmp, filePath);
}

/**
 * Acquire lock, read queue, apply mutator, write atomically, release lock.
 *
 * @param {function} mutator - Receives current queue array, must return the new array.
 * @param {object} [options]
 * @param {string} [options.queuePath] - Override queue file path (for testing).
 * @returns {Promise<any[]>} The queue array after mutation.
 */
export async function mutateQueue(mutator, options = {}) {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  const lockPath = lockPathFor(queuePath);

  acquireLock(lockPath);
  try {
    const queue = readQueue(queuePath);
    const result = await mutator(queue);
    const finalQueue = Array.isArray(result) ? result : queue;
    atomicWrite(queuePath, JSON.stringify(finalQueue, null, 2));
    return finalQueue;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Synchronous twin of mutateQueue for callers that must stay sync (the
 * slack-dm-jobs mutators are consumed without await in the listener).
 * Same lock file, same atomic write — every writer to a given path
 * serialises on queuePath + ".lock" regardless of which variant it uses.
 *
 * Contract difference from mutateQueue: if the mutator returns a non-array,
 * NOTHING is written (read-only outcome, e.g. upsert found an existing row).
 * A mutator throw also writes nothing; the lock is always released.
 */
export function mutateQueueSync(mutator, options = {}) {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  const lockPath = lockPathFor(queuePath);

  acquireLock(lockPath);
  try {
    const queue = readQueue(queuePath);
    const result = mutator(queue);
    if (Array.isArray(result)) {
      atomicWrite(queuePath, JSON.stringify(result, null, 2));
      return result;
    }
    return queue;
  } finally {
    releaseLock(lockPath);
  }
}

/**
 * Read-only access (no lock needed for readers on atomic-write files).
 */
export function peekQueue(options = {}) {
  const queuePath = options.queuePath || DEFAULT_QUEUE_PATH;
  return readQueue(queuePath);
}
