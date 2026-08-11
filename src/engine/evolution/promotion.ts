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
      attempt.report_path,
    );
    if (
      report.schema_version !== "unicli.evolution-verification.v1" ||
      report.session_id !== session.session_id ||
      report.component_id !== session.component.id ||
      report.baseline_sha256 !== session.baseline.sha256 ||
      report.attempt !== attempt.ordinal ||
      report.candidate_path !== attempt.candidate_path ||
      report.patch_path !== attempt.patch_path ||
      !report.decision?.eligible
    ) {
      throw new EvolutionError(
        "not_eligible",
        "the stored verification report did not pass the promotion gate",
        attempt.report_path,
      );
    }
    const candidate = await readFile(paths.candidate_file, "utf-8");
    const verifiedCandidate = await readFile(attempt.candidate_path, "utf-8");
    const candidateSha256 = sha256Text(candidate);
    if (
      candidateSha256 !== attempt.candidate_sha256 ||
      candidateSha256 !== report.candidate_sha256 ||
      candidateSha256 !== sha256Text(verifiedCandidate)
    ) {
      throw new EvolutionError(
        "candidate_changed",
        "candidate changed after verification; run `unicli evolve verify` again",
        paths.candidate_file,
      );
    }

    const destination = join(
      userAdapterRoot(),
      session.component.site,
      `${session.component.command}.yaml`,
    );
    const previous = existsSync(destination)
      ? await readFile(destination, "utf-8")
      : undefined;
    assertDestinationUnchanged(session, destination, previous);
    if (previous !== undefined)
      await writePrivateText(paths.rollback, previous);
    await writePrivateText(destination, candidate);

    const promotedAt = input.promotedAt ?? new Date().toISOString();
    const promotion: EvolutionPromotionRecord = {
      schema_version: "unicli.evolution-promotion.v1",
      session_id: session.session_id,
      component_id: session.component.id,
      promoted_at: promotedAt,
      destination,
      candidate_sha256: candidateSha256,
      verification_path: attempt.report_path,
      previous_overlay:
        previous === undefined
          ? null
          : { path: destination, sha256: sha256Text(previous) },
      rollback_path: previous === undefined ? null : paths.rollback,
    };
    await writePrivateJson(paths.promotion, promotion);
    const updated: EvolutionSession = {
      ...session,
      state: "promoted",
      updated_at: promotedAt,
      promotion: {
        path: paths.promotion,
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
      promotion.candidate_sha256 !== attempt?.candidate_sha256
    ) {
      throw new EvolutionError(
        "destination_changed",
        "the stored promotion record does not match the evolution session",
        paths.promotion,
      );
    }
    if (!existsSync(promotion.destination)) {
      throw new EvolutionError(
        "destination_changed",
        "promoted adapter is missing; rollback stopped to preserve later user changes",
        promotion.destination,
      );
    }
    const current = await readFile(promotion.destination, "utf-8");
    if (sha256Text(current) !== promotion.candidate_sha256) {
      throw new EvolutionError(
        "destination_changed",
        "promoted adapter changed after promotion; rollback stopped to preserve later user changes",
        promotion.destination,
      );
    }

    let restored: "previous_overlay" | "packaged_baseline";
    if (promotion.rollback_path) {
      const previous = await readFile(promotion.rollback_path, "utf-8");
      await writePrivateText(promotion.destination, previous);
      restored = "previous_overlay";
    } else {
      await rm(promotion.destination);
      restored = "packaged_baseline";
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

function assertDestinationUnchanged(
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
