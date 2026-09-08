import type { ReactNode } from "react";
import { AttentionView } from "./attention/AttentionView";
import { useAttention } from "./attention/useAttention";

/**
 * The dashboard is one page: the read-only Human Attention view at `/`.
 * There is no router and no other page in 1a.
 */
export function App(): ReactNode {
  const { payload, lastSuccessAt, failure, refresh } = useAttention();

  return (
    <AttentionView
      payload={payload}
      lastSuccessAt={lastSuccessAt}
      failure={failure}
      onRefresh={refresh}
      now={Date.now}
    />
  );
}
