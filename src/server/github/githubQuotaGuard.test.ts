import { describe, expect, it, vi } from "vitest";
import { createGitHubRequestGovernor } from "./githubQuotaGuard";

function rateLimitResponse(remaining: number, resetEpochSeconds: number) {
  return {
    stdout: [
      "HTTP/2.0 200 OK",
      "x-ratelimit-limit: 5000",
      `x-ratelimit-remaining: ${remaining}`,
      `x-ratelimit-reset: ${resetEpochSeconds}`,
      "x-ratelimit-used: 12",
      "",
      "{}"
    ].join("\n"),
    stderr: "",
    exitCode: 0
  };
}

describe("GitHub request governor", () => {
  it("caches quota exhaustion until reset and never executes the blocked request", async () => {
    let nowMs = Date.parse("2026-08-11T03:00:00Z");
    const resetMs = nowMs + 60_000;
    const run = vi.fn()
      .mockResolvedValueOnce(rateLimitResponse(0, resetMs / 1000))
      .mockResolvedValueOnce(rateLimitResponse(5_000, (resetMs + 3_600_000) / 1000))
      .mockResolvedValueOnce({ stdout: "{}", stderr: "", exitCode: 0 });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 100,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => nowMs
    });

    const first = governor.beginRefresh("dashboard");
    await expect(first.runner.run(["api", "repos/repo/app/issues/1"])).resolves.toMatchObject({ exitCode: 75 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(first.status()).toMatchObject({
      state: "paused",
      reason: "rate_limit_exhausted",
      caller: "dashboard",
      requestsExecuted: 1,
      requestsBlocked: 1,
      rateLimitRemaining: 0,
      rateLimitResetAt: new Date(resetMs).toISOString()
    });

    const stillPaused = governor.beginRefresh("dashboard");
    await stillPaused.runner.run(["api", "repos/repo/app/issues/2"]);
    expect(run).toHaveBeenCalledTimes(1);

    nowMs = resetMs + 1;
    const recovered = governor.beginRefresh("dashboard");
    await expect(recovered.runner.run(["api", "repos/repo/app/issues/3"])).resolves.toMatchObject({ exitCode: 0 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(recovered.status()).toMatchObject({ state: "available", requestsExecuted: 2, requestsBlocked: 0 });
  });

  it("bounds a 500-target refresh and reports the exact caller-level request totals", async () => {
    const run = vi.fn(async (args: string[]) => args.includes("user")
      ? rateLimitResponse(5_000, Date.parse("2026-08-11T04:00:00Z") / 1000)
      : { stdout: "{}", stderr: "", exitCode: 0 });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 1_000,
      perRefreshRequestLimit: 25,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => Date.parse("2026-08-11T03:00:00Z")
    });
    const refresh = governor.beginRefresh("dashboard");

    await Promise.all(Array.from({ length: 500 }, (_, index) =>
      refresh.runner.run(["api", `repos/repo/app/issues/${index + 1}`])
    ));

    expect(run).toHaveBeenCalledTimes(25);
    expect(refresh.status({ targetCount: 500 })).toMatchObject({
      state: "degraded",
      reason: "per_refresh_limit",
      caller: "dashboard",
      targetCount: 500,
      requestsAttempted: 501,
      requestsExecuted: 25,
      requestsBlocked: 476
    });
  });

  it("shares one representative quota probe across concurrent refreshes", async () => {
    let releaseProbe: () => void = () => undefined;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const run = vi.fn(async (args: string[]) => {
      if (args.includes("user")) {
        await probeGate;
        return rateLimitResponse(5_000, Date.parse("2026-08-11T04:00:00Z") / 1000);
      }
      return { stdout: "{}", stderr: "", exitCode: 0 };
    });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 100,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => Date.parse("2026-08-11T03:00:00Z")
    });
    const first = governor.beginRefresh("dashboard");
    const second = governor.beginRefresh("dashboard");
    const loads = [
      first.runner.run(["api", "repos/repo/app/issues/1"]),
      second.runner.run(["api", "repos/repo/app/issues/1"])
    ];
    releaseProbe();
    await Promise.all(loads);

    expect(run.mock.calls.filter(([args]) => args.includes("user"))).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("fails closed when the representative response omits quota headers", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ stdout: "HTTP/2.0 200 OK\n\n{}", stderr: "", exitCode: 0 })
      .mockResolvedValueOnce({ stdout: "{}", stderr: "", exitCode: 0 });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 100,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => Date.parse("2026-08-11T03:00:00Z")
    });
    const refresh = governor.beginRefresh("dashboard");

    await expect(refresh.runner.run(["api", "repos/repo/app/issues/1"])).resolves.toMatchObject({ exitCode: 75 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresh.status()).toMatchObject({ state: "paused", reason: "probe_failed", requestsBlocked: 1 });
  });

  it("pauses at the safety threshold before spending another request", async () => {
    const run = vi.fn(async () => rateLimitResponse(100, Date.parse("2026-08-11T04:00:00Z") / 1000));
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 100,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => Date.parse("2026-08-11T03:00:00Z")
    });
    const refresh = governor.beginRefresh("dashboard");

    await refresh.runner.run(["api", "repos/repo/app/issues/1"]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(refresh.status()).toMatchObject({ state: "paused", reason: "rate_limit_low", rateLimitRemaining: 100 });
  });

  it("enforces the process-wide hourly budget across refresh contexts", async () => {
    const run = vi.fn(async (args: string[]) => args.includes("user")
      ? rateLimitResponse(5_000, Date.parse("2026-08-11T04:00:00Z") / 1000)
      : { stdout: "{}", stderr: "", exitCode: 0 });
    const governor = createGitHubRequestGovernor({ run }, {
      hourlyRequestBudget: 3,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000,
      now: () => Date.parse("2026-08-11T03:00:00Z")
    });
    const first = governor.beginRefresh("dashboard");
    await first.runner.run(["api", "repos/repo/app/issues/1"]);
    await first.runner.run(["api", "repos/repo/app/issues/2"]);
    const second = governor.beginRefresh("dashboard");
    await second.runner.run(["api", "repos/repo/app/issues/3"]);

    expect(run).toHaveBeenCalledTimes(3);
    expect(second.status()).toMatchObject({ state: "paused", reason: "hourly_budget", hourlyRequestsRemaining: 0 });
  });

  it("supports explicitly disabling GitHub enrichment", async () => {
    const run = vi.fn(async () => ({ stdout: "{}", stderr: "", exitCode: 0 }));
    const governor = createGitHubRequestGovernor({ run }, {
      enabled: false,
      hourlyRequestBudget: 100,
      perRefreshRequestLimit: 10,
      safetyThreshold: 100,
      probeIntervalMs: 60_000,
      fallbackCooldownMs: 30_000
    });
    const refresh = governor.beginRefresh("dashboard");

    await refresh.runner.run(["api", "repos/repo/app/issues/1"]);
    expect(run).not.toHaveBeenCalled();
    expect(refresh.status()).toMatchObject({ state: "paused", reason: "disabled", requestsBlocked: 1 });
  });
});
