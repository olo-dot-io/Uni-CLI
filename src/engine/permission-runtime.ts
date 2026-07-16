import {
  createApprovalStore,
  findStoredApproval,
  type ApprovalStore,
} from "./approval-store.js";
import {
  evaluateOperationPolicy,
  type OperationPolicy,
  type OperationPolicyInput,
} from "./operation-policy.js";
import {
  applyDenyRuleToPolicy,
  findDenyRuleForPolicySync,
} from "./permission-rules.js";

export interface PermissionRuntimeOptions {
  store?: ApprovalStore;
  rules?: {
    path?: string;
    homeDir?: string;
  };
}

export async function evaluateOperationPolicyWithApprovals(
  input: OperationPolicyInput,
  options: PermissionRuntimeOptions = {},
): Promise<OperationPolicy> {
  let policy = evaluateOperationPolicy(input);
  const denyRule = findDenyRuleForPolicySync(policy, {
    ...options.rules,
    argumentValues: input.argumentValues,
  });
  if (denyRule) return applyDenyRuleToPolicy(policy, denyRule);

  const store = options.store ?? createApprovalStore();

  if (policy.enforcement === "needs_approval") {
    const stored = await findStoredApproval(store, policy.approval_memory.key);
    if (stored) {
      policy = evaluateOperationPolicy({
        ...input,
        approvalSource: "memory",
      });
    }
  }

  return policy;
}
/**
 * @owner       src::engine::permission-runtime
 * @does        Compose operation classification, deny-first policy rules, and durable approval memory.
 * @needs       operation policy, permission rules, approval store
 * @feeds       invocation kernel, session events, CLI and direct computer-use authorization
 * @breaks      Reordering deny checks behind approval memory would let remembered approval bypass policy.
 * @invariants  Permission rules evaluate first with actual arguments; approval memory can satisfy only profile approval.
 * @side-effects Reads permission policy and approval files.
 * @perf        One policy evaluation and at most one approval-store scan per operation.
 * @concurrency Approval append semantics and permission-file stable reads define cross-process behavior.
 * @test        tests/unit/approval-store.test.ts, tests/unit/permission-rules.test.ts
 * @stability   stable
 * @since       2026-07-15
 */
