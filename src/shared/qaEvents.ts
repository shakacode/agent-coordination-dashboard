export function isQaEventType(type: string): boolean {
  const normalized = type.toLowerCase();
  return (
    normalized === "qa" ||
    normalized === "validation" ||
    normalized.startsWith("qa.") ||
    normalized.startsWith("qa_") ||
    normalized.startsWith("qa-") ||
    normalized.startsWith("validation.") ||
    normalized.startsWith("validation_") ||
    normalized.startsWith("validation-")
  );
}
