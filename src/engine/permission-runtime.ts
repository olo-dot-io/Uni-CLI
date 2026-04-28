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

export interface PermissionRuntimeOptions {
  store?: ApprovalStore;
}

export async function evaluateOperationPolicyWithApprovals(
  input: OperationPolicyInput,
  options: PermissionRuntimeOptions = {},
): Promise<OperationPolicy> {
  let policy = evaluateOperationPolicy(input);
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
