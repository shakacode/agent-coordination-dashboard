export interface GhRunOptions {
  /** Conservative local reservation; never treated as observed GitHub cost. */
  estimatedGraphQlCost?: number;
}

export interface GhRunner {
  run(args: string[], options?: GhRunOptions): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}
