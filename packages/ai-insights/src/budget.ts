import "server-only";

import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

import { InsightError } from "./core";

const MINUTE = 60_000;
const DAY = 86_400_000;
const MAX_PER_MINUTE = 2;
const MAX_PER_DAY = 10;

function unavailable(): InsightError { return new InsightError("insights_unavailable", 503); }
function limited(seconds: number): InsightError { return new InsightError("local_limit_reached", 429, Math.max(1, seconds)); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

async function checkedDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory) || directory.length > 4096 || typeof process.getuid !== "function") throw unavailable();
  const resolved = path.resolve(directory);
  const stats = await lstat(resolved);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.uid !== process.getuid() || (stats.mode & 0o077) !== 0 || await realpath(resolved) !== resolved) throw unavailable();
  return resolved;
}

async function loadAttempts(directory: string, now: number): Promise<number[]> {
  const file = path.join(directory, "attempts.json");
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return [];
    throw unavailable();
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0 || stats.size > 4096) throw unavailable();
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unavailable();
    const record = parsed as { version?: unknown; attempts?: unknown };
    if (Object.keys(record).sort().join(",") !== "attempts,version" || record.version !== 1 || !Array.isArray(record.attempts) || record.attempts.length > MAX_PER_DAY ||
        !record.attempts.every((value, i, all) => Number.isSafeInteger(value) && value > 0 && value <= now && (i === 0 || value >= all[i - 1]))) throw unavailable();
    return record.attempts.filter((value: number) => value > now - DAY);
  } catch (error) {
    if (error instanceof InsightError) throw error;
    throw unavailable();
  } finally { await handle.close(); }
}

async function saveAttempts(directory: string, attempts: number[]): Promise<void> {
  const temporary = path.join(directory, `.attempts-${randomBytes(12).toString("hex")}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ version: 1, attempts })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path.join(directory, "attempts.json"));
  } finally { await unlink(temporary).catch(() => {}); }
}

/** One filesystem lock and ledger share attempts across the two local Node processes. */
export async function withLocalBudget<T>(directory: string, work: () => Promise<T>, now = Date.now()): Promise<T> {
  let checked: string;
  try { checked = await checkedDirectory(directory); } catch { throw unavailable(); }
  const lock = path.join(checked, "in-flight.lock");
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === "EEXIST") throw limited(1); throw unavailable(); }
  try {
    if (!Number.isSafeInteger(now) || now <= 0) throw unavailable();
    const attempts = await loadAttempts(checked, now);
    const recent = attempts.filter((value) => value > now - MINUTE);
    if (recent.length >= MAX_PER_MINUTE) throw limited(Math.ceil((recent[0] + MINUTE - now) / 1000));
    if (attempts.length >= MAX_PER_DAY) throw limited(Math.ceil((attempts[0] + DAY - now) / 1000));
    await saveAttempts(checked, [...attempts, now]);
    return await work();
  } catch (error) {
    if (error instanceof InsightError) throw error;
    throw unavailable();
  } finally {
    // A failed release or process crash leaves a lock and fails closed.
    await rmdir(lock).catch(() => {});
  }
}
