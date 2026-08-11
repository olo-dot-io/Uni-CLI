import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { userAdapterRoot } from "../user-home.js";
import { EvolutionError } from "./error.js";
import {
  evolutionSessionPaths,
  readEvolutionSession,
  readPrivateJson,
  sha256Text,
  withEvolutionSessionLock,
  writeEvolutionSession,
  writePrivateJson,
  writePrivateText,
  type EvolutionStore,
} from "./store.js";
import type {
  EvolutionPromotionRecord,
  EvolutionSession,
  EvolutionVerificationAttempt,
  EvolutionVerificationReport,
} from "./types.js";

export async function promoteEvolutionSession(input: {
  store: EvolutionStore;
  sessionId: string;
  promotedAt?: string;
}): Promise<{
  session: EvolutionSession;
  promotion: EvolutionPromotionRecord;
  report: EvolutionVerificationReport;
}> {
  return withEvolutionSessionLock(input.store, input.sessionId, async () => {
    const session = await readEvolutionSession(input.store, input.sessionId);
    const attempt = latestAttempt(session);
    if (session.state !== "verified" || !attempt?.eligible) {
      throw new EvolutionError(
        "not_eligible",
        `evolution session is not eligible for promotion: ${session.state}`,
      );
    }
    const paths = evolutionSessionPaths(
      input.store,
      session.session_id,
      session.component.site,
      session.component.command,
    );
    const report = await readPrivateJson<EvolutionVerificationReport>(
      attempt.report.path,
    );
    if (
      report.schema_version !== "unicli.evolution-verification.v1" ||
      report.session_id !== session.session_id ||
      report.component_id !== session.component.id ||
      report.baseline_sha256 !== session.baseline.sha256 ||
      report.attempt !== attempt.ordinal ||
      report.candidate_path !== attempt.candidate.path ||
      report.patch_path !== attempt.patch.path ||
      !report.decision?.eligible
    ) {
      throw new EvolutionError(
        "not_eligible",
        "the stored verification report did not pass the promotion gate",
        attempt.report.path,
      );
    }
    const candidate = await readFile(paths.candidate_file, "utf-8");
    const verifiedCandidate = await readFile(attempt.candidate.path, "utf-8");
    const candidateSha256 = sha256Text(candidate);
    if (
      candidateSha256 !== attempt.candidate.sha256 ||
      candidateSha256 !== report.candidate_sha256 ||
      candidateSha256 !== sha256Text(verifiedCandidate)
    ) {
      throw new EvolutionError(
        "candidate_changed",
        "candidate changed after verification; run `unicli evolve verify` again",
        paths.candidate_file,
      );
    }

    const destination =
      session.component.source_tier === "user"
        ? session.component.source_path
        : join(
            userAdapterRoot(),
            session.component.site,
            `${session.component.command}.yaml`,
          );
    const prepared = await readPreparedPromotion(
      paths,
      session,
      attempt,
      destination,
    );
    let promotion: EvolutionPromotionRecord;
    let promotionSha256: string;
    if (prepared) {
      promotion = prepared.record;
      promotionSha256 = prepared.sha256;
    } else {
      const previous = existsSync(destination)
        ? await readFile(destination, "utf-8")
        : undefined;
      await assertDestinationUnchanged(session, destination, previous);
      if (previous !== undefined) {
        await writePrivateText(paths.rollback, previous);
      }
      promotion = {
        schema_version: "unicli.evolution-promotion.v1",
        session_id: session.session_id,
        component_id: session.component.id,
        promoted_at: input.promotedAt ?? new Date().toISOString(),
        destination,
        candidate_sha256: candidateSha256,
        verification_path: attempt.report.path,
        previous_overlay:
          previous === undefined
            ? null
            : { path: destination, sha256: sha256Text(previous) },
        rollback_path: previous === undefined ? null : paths.rollback,
      };
      promotionSha256 = await writePrivateJson(paths.promotion, promotion);
    }
    await installPreparedCandidate(session, promotion, candidate);

    const promotedAt = promotion.promoted_at;
    const updated: EvolutionSession = {
      ...session,
      state: "promoted",
      updated_at: promotedAt,
      promotion: {
        path: paths.promotion,
        sha256: promotionSha256,
        promoted_at: promotedAt,
        destination,
      },
    };
    await writeEvolutionSession(input.store, updated);
    return { session: updated, promotion, report };
  });
}

export async function rollbackEvolutionSession(input: {
  store: EvolutionStore;
  sessionId: string;
  rolledBackAt?: string;
}): Promise<{
  session: EvolutionSession;
  destination: string;
  restored: "previous_overlay" | "packaged_baseline";
}> {
  return withEvolutionSessionLock(input.store, input.sessionId, async () => {
    const session = await readEvolutionSession(input.store, input.sessionId);
    if (session.state !== "promoted" || !session.promotion?.path) {
      throw new EvolutionError(
        "not_promoted",
        `evolution session is not promoted: ${session.state}`,
      );
    }
    const paths = evolutionSessionPaths(
      input.store,
      session.session_id,
      session.component.site,
      session.component.command,
    );
    const promotion = await readPrivateJson<EvolutionPromotionRecord>(
      paths.promotion,
    );
    const attempt = latestAttempt(session);
    if (
      promotion.schema_version !== "unicli.evolution-promotion.v1" ||
      promotion.session_id !== session.session_id ||
      promotion.component_id !== session.component.id ||
      promotion.destination !== session.promotion.destination ||
      promotion.candidate_sha256 !== attempt?.candidate.sha256
    ) {
      throw new EvolutionError(
        "destination_changed",
        "the stored promotion record does not match the evolution session",
        paths.promotion,
      );
    }
    let restored: "previous_overlay" | "packaged_baseline";
    let previous: string | undefined;
    if (promotion.rollback_path) {
      previous = await readFile(promotion.rollback_path, "utf-8");
      if (
        !promotion.previous_overlay ||
        sha256Text(previous) !== promotion.previous_overlay.sha256
      ) {
        throw new EvolutionError(
          "destination_changed",
          "evolution integrity check failed for rollback artifact",
          promotion.rollback_path,
        );
      }
      restored = "previous_overlay";
    } else {
      restored = "packaged_baseline";
    }
    const current = existsSync(promotion.destination)
      ? await readFile(promotion.destination, "utf-8")
      : undefined;
    if (
      current !== undefined &&
      sha256Text(current) === promotion.candidate_sha256
    ) {
      if (previous !== undefined) {
        await writePrivateText(promotion.destination, previous);
      } else {
        await rm(promotion.destination);
      }
    } else if (
      previous !== undefined
        ? current === undefined ||
          sha256Text(current) !== promotion.previous_overlay?.sha256
        : current !== undefined
    ) {
      throw new EvolutionError(
        "destination_changed",
        "promoted adapter changed after promotion; rollback stopped to preserve later user changes",
        promotion.destination,
      );
    }
    const rolledBackAt = input.rolledBackAt ?? new Date().toISOString();
    const updated: EvolutionSession = {
      ...session,
      state: "rolled_back",
      updated_at: rolledBackAt,
    };
    await writeEvolutionSession(input.store, updated);
    return { session: updated, destination: promotion.destination, restored };
  });
}

function latestAttempt(
  session: EvolutionSession,
): EvolutionVerificationAttempt | undefined {
  return session.attempts.at(-1);
}

async function readPreparedPromotion(
  paths: ReturnType<typeof evolutionSessionPaths>,
  session: EvolutionSession,
  attempt: EvolutionVerificationAttempt,
  destination: string,
): Promise<{ record: EvolutionPromotionRecord; sha256: string } | undefined> {
  if (!existsSync(paths.promotion)) return undefined;
  const text = await readFile(paths.promotion, "utf-8");
  const record = await readPrivateJson<EvolutionPromotionRecord>(
    paths.promotion,
  );
  if (
    record.schema_version !== "unicli.evolution-promotion.v1" ||
    record.session_id !== session.session_id ||
    record.component_id !== session.component.id ||
    record.destination !== destination ||
    record.candidate_sha256 !== attempt.candidate.sha256 ||
    record.verification_path !== attempt.report.path
  ) {
    throw new EvolutionError(
      "destination_changed",
      "the prepared promotion record does not match the evolution session",
      paths.promotion,
    );
  }
  if (record.rollback_path) {
    if (
      record.rollback_path !== paths.rollback ||
      record.previous_overlay?.path !== destination
    ) {
      throw new EvolutionError(
        "destination_changed",
        "the prepared promotion rollback record is invalid",
        paths.promotion,
      );
    }
    const rollback = await readFile(record.rollback_path, "utf-8");
    if (sha256Text(rollback) !== record.previous_overlay.sha256) {
      throw new EvolutionError(
        "destination_changed",
        "evolution integrity check failed for rollback artifact",
        record.rollback_path,
      );
    }
  } else if (record.previous_overlay !== null) {
    throw new EvolutionError(
      "destination_changed",
      "the prepared promotion record has no rollback artifact",
      paths.promotion,
    );
  }
  return { record, sha256: sha256Text(text) };
}

async function installPreparedCandidate(
  session: EvolutionSession,
  promotion: EvolutionPromotionRecord,
  candidate: string,
): Promise<void> {
  const current = existsSync(promotion.destination)
    ? await readFile(promotion.destination, "utf-8")
    : undefined;
  await assertComponentSourceUnchanged(session);
  if (
    current !== undefined &&
    sha256Text(current) === promotion.candidate_sha256
  ) {
    return;
  }
  assertOverlayDestinationUnchanged(session, promotion.destination, current);
  await writePrivateText(promotion.destination, candidate);
}

async function assertDestinationUnchanged(
  session: EvolutionSession,
  destination: string,
  current: string | undefined,
): Promise<void> {
  await assertComponentSourceUnchanged(session);
  assertOverlayDestinationUnchanged(session, destination, current);
}

function assertOverlayDestinationUnchanged(
  session: EvolutionSession,
  destination: string,
  current: string | undefined,
): void {
  if (session.component.source_tier === "user") {
    if (
      current === undefined ||
      sha256Text(current) !== session.baseline.sha256
    ) {
      throw new EvolutionError(
        "destination_changed",
        "user adapter changed after the evolution session was created; create a new session from the current baseline",
        destination,
      );
    }
    return;
  }
  if (current !== undefined) {
    throw new EvolutionError(
      "destination_changed",
      "a user adapter overlay appeared after the evolution session was created; create a new session from that overlay",
      destination,
    );
  }
}

async function assertComponentSourceUnchanged(
  session: EvolutionSession,
): Promise<void> {
  if (session.component.source_tier === "user") return;
  let source: string;
  try {
    source = await readFile(session.component.source_path, "utf-8");
  } catch {
    throw new EvolutionError(
      "destination_changed",
      "adapter source became unavailable after the evolution session was created; create a new session from the current source",
      session.component.source_path,
    );
  }
  if (sha256Text(source) !== session.baseline.sha256) {
    throw new EvolutionError(
      "destination_changed",
      "adapter source changed after the evolution session was created; create a new session from the current baseline",
      session.component.source_path,
    );
  }
}
