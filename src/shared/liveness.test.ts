import { describe, expect, it } from "vitest";
import { deriveHeartbeatLiveness } from "./liveness";

const now = new Date("2026-06-17T20:00:00Z");

describe("deriveHeartbeatLiveness", () => {
  it("returns live before heartbeat expiry", () => {
    expect(
      deriveHeartbeatLiveness(
        {
          updatedAt: "2026-06-17T19:50:00Z",
          expiresAt: "2026-06-17T20:05:00Z"
        },
        now
      )
    ).toBe("live");
  });

  it("returns stale between expiry and four ttl windows", () => {
    expect(
      deriveHeartbeatLiveness(
        {
          updatedAt: "2026-06-17T19:30:00Z",
          expiresAt: "2026-06-17T19:45:00Z"
        },
        now
      )
    ).toBe("stale");
  });

  it("returns dead after four ttl windows", () => {
    expect(
      deriveHeartbeatLiveness(
        {
          updatedAt: "2026-06-17T18:45:00Z",
          expiresAt: "2026-06-17T19:00:00Z"
        },
        now
      )
    ).toBe("dead");
  });

  it("returns unknown for invalid timestamps", () => {
    expect(
      deriveHeartbeatLiveness(
        {
          updatedAt: "bad",
          expiresAt: "2026-06-17T19:00:00Z"
        },
        now
      )
    ).toBe("unknown");
  });
});

