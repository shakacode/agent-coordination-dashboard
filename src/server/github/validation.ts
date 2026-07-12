export function isValidGitHubRepository(repo: string): boolean {
  const segments = repo.split("/");
  return segments.length === 2
    && segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment) && !/^\.+$/.test(segment));
}
