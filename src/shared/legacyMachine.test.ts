import { describe, expect, it } from "vitest";
import { inferLegacyMachineId } from "./legacyMachine";

describe("inferLegacyMachineId", () => {
  it("extracts one strict m-number token from a legacy agent id", () => {
    expect(inferLegacyMachineId("feature-worker-m5-max")).toBe("m5");
    expect(inferLegacyMachineId("m12-worker")).toBe("m12");
  });

  it("does not infer ambiguous or loosely matching tokens", () => {
    expect(inferLegacyMachineId("worker-m5-m6-max")).toBeUndefined();
    expect(inferLegacyMachineId("worker-team5-max")).toBeUndefined();
    expect(inferLegacyMachineId("acd-c-i46")).toBeUndefined();
  });
});
