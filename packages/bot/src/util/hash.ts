/**
 * code_hash computation: stable sha256 over the files that represent
 * the bot's decision logic. Used to enforce the spec §8.11.3 and
 * §8.12.4 rule that deployed code must match validated code.
 *
 * Policy: hash every `.ts` file under `packages/bot/src/core` and
 * `packages/bot/src/backtest` — the two directories that directly
 * control trade decisions and simulated fills. Changes elsewhere
 * (logging, health, API) do NOT invalidate the artifact.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

const DEFAULT_PATHS = ["packages/bot/src/core", "packages/bot/src/backtest"];

export interface HashInput {
  readonly roots: readonly string[];
  readonly repoRoot: string;
}

async function walk(dir: string, acc: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, acc);
    } else if (e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

export async function computeCodeHash(input: HashInput): Promise<string> {
  const allFiles: string[] = [];
  for (const rel of input.roots) {
    const abs = join(input.repoRoot, rel);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        const files = await walk(abs);
        allFiles.push(...files);
      } else if (s.isFile()) {
        allFiles.push(abs);
      }
    } catch {
      // Missing directory is a legitimate state during early
      // bootstrap — skip silently. The caller decides if it matters.
    }
  }
  allFiles.sort();
  const h = createHash("sha256");
  for (const f of allFiles) {
    const rel = f.replace(input.repoRoot + sep, "").replace(/\\/g, "/");
    h.update(rel);
    h.update("\0");
    const buf = await readFile(f);
    h.update(buf);
    h.update("\0");
  }
  return `sha256:${h.digest("hex")}`;
}

export function defaultHashPaths(): readonly string[] {
  return DEFAULT_PATHS;
}
