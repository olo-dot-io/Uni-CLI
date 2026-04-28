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
  const denyRule = findDenyRuleForPolicySync(policy, options.rules);
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
