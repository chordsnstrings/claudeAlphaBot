/**
 * Validated artifact loader + verifier — spec §8.11.3.
 *
 * Four hard rejection rules; any one of them blocks startup in
 * paper or live mode:
 *   1. File missing
 *   2. deployment_allowed === false
 *   3. created_at older than 30 days
 *   4. code_hash doesn't match the currently-deployed code
 */
import { readFile } from "node:fs/promises";

import type { ValidatedConfig } from "@hydra/shared";

export const STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface VerifyOptions {
  readonly currentCodeHash: string;
  readonly nowMs?: number;
  readonly skipCodeHashCheck?: boolean;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly artifact: ValidatedConfig | null;
  readonly errors: readonly string[];
}

export class ArtifactVerificationError extends Error {
  public readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super(`Artifact verification failed:\n${errors.map((e) => "  • " + e).join("\n")}`);
    this.name = "ArtifactVerificationError";
    this.errors = errors;
  }
}

export async function loadArtifactFromDisk(path: string): Promise<ValidatedConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ArtifactVerificationError([
      `Artifact file not found at path: ${path}. Run validation pipeline first. (${String(err)})`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ArtifactVerificationError([`Artifact at ${path} is not valid JSON: ${String(err)}`]);
  }
  return parsed as ValidatedConfig;
}

export function verifyArtifact(
  artifact: ValidatedConfig | null,
  options: VerifyOptions,
): VerifyResult {
  const errors: string[] = [];
  if (artifact === null || typeof artifact !== "object") {
    errors.push("Artifact is null or not an object");
    return { ok: false, artifact: null, errors };
  }
  if (artifact.deploymentAllowed !== true) {
    errors.push(
      `deploymentAllowed must be true; got ${JSON.stringify(artifact.deploymentAllowed)}. Validation pipeline reported failure.`,
    );
  }
  const now = options.nowMs ?? Date.now();
  let createdMs = NaN;
  if (typeof artifact.createdAt === "string") {
    createdMs = Date.parse(artifact.createdAt);
  }
  if (!Number.isFinite(createdMs)) {
    errors.push(`createdAt is missing or not a parseable ISO timestamp: ${String(artifact.createdAt)}`);
  } else {
    const ageDays = (now - createdMs) / MS_PER_DAY;
    if (ageDays > STALE_DAYS) {
      errors.push(
        `Artifact is stale: ${ageDays.toFixed(1)} days old (max ${STALE_DAYS}). Re-run validation pipeline.`,
      );
    }
  }
  if (!options.skipCodeHashCheck) {
    if (typeof artifact.codeHash !== "string" || artifact.codeHash.length === 0) {
      errors.push("codeHash missing on artifact");
    } else if (artifact.codeHash !== options.currentCodeHash) {
      errors.push(
        `code_hash mismatch — artifact ${artifact.codeHash.slice(0, 18)}…, current ${options.currentCodeHash.slice(0, 18)}…. Re-run validation against current code.`,
      );
    }
  }
  return { ok: errors.length === 0, artifact, errors };
}

export async function verifyArtifactAtPath(
  path: string,
  options: VerifyOptions,
): Promise<VerifyResult> {
  let artifact: ValidatedConfig;
  try {
    artifact = await loadArtifactFromDisk(path);
  } catch (err) {
    if (err instanceof ArtifactVerificationError) {
      return { ok: false, artifact: null, errors: err.errors };
    }
    return { ok: false, artifact: null, errors: [String(err)] };
  }
  return verifyArtifact(artifact, options);
}
