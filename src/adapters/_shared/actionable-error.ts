/** Throw a provider-reported failure without converting it into a data row. */
export function throwProviderReportedFailure(
  message: string | undefined,
  suggestion: string,
): never {
  throw Object.assign(
    new Error(
      message?.trim() || "The provider reported that the action failed.",
    ),
    {
      code: "provider_reported_failure",
      suggestion,
      retryable: false,
      alternatives: [] as string[],
    },
  );
}
