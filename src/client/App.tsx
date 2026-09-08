import { useState, type ReactNode } from "react";
import { AttentionView } from "./attention/AttentionView";
import { SystemStatus } from "./attention/SystemStatus";
import { useAttention } from "./attention/useAttention";

/**
 * The dashboard is one page at `/`: the read-only Human Attention view.
 *
 * System Status is a second view rather than a route. The app has no router, so
 * the entry that already renders the attention list holds which of the two is
 * showing, and both directions are one control: System Status from the
 * attention header and from its empty-state line, and back from the System
 * Status header.
 */
type DashboardView = "attention" | "system-status";

export function App(): ReactNode {
  const { payload, lastSuccessAt, failure, refresh } = useAttention();
  const [view, setView] = useState<DashboardView>("attention");

  if (view === "system-status") {
    return (
      <SystemStatus
        payload={payload}
        lastSuccessAt={lastSuccessAt}
        failure={failure}
        onBack={() => setView("attention")}
      />
    );
  }

  return (
    <AttentionView
      payload={payload}
      lastSuccessAt={lastSuccessAt}
      failure={failure}
      onRefresh={refresh}
      onOpenSystemStatus={() => setView("system-status")}
      now={Date.now}
    />
  );
}
