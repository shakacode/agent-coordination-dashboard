export interface GhRunner {
  run(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

