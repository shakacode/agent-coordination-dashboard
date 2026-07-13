export function inferLegacyMachineId(agentId: string | undefined): string | undefined {
  const normalized = agentId?.trim().toLowerCase();
  if (!normalized) return undefined;
  const candidates = normalized.split("-").filter((part) => /^m\d+$/.test(part));
  return new Set(candidates).size === 1 ? candidates[0] : undefined;
}
