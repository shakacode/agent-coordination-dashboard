import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { readConfig } from "./config";
import { loadOpenGitHubItems } from "./github/githubClient";
import { createHostGuard } from "./security/hostGuard";
import { buildDashboardModel } from "./state/buildDashboardModel";
import { readCoordinationState } from "./state/readCoordinationState";

const app = express();
const config = readConfig();
const dirname = fileURLToPath(new URL(".", import.meta.url));

app.use(createHostGuard(config.allowedHosts));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/dashboard", async (_req, res) => {
  const now = new Date();
  const state = await readCoordinationState(config.stateRoot, now);
  const githubResults = await Promise.all(
    config.targetRepos.map((repo) => loadOpenGitHubItems(repo))
  );
  const githubItems = githubResults.flatMap((result) => result.items);
  const githubWarnings = githubResults.flatMap((result) => result.warnings);

  res.json(
    buildDashboardModel({
      stateRoot: config.stateRoot,
      targetRepos: config.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      githubItems,
      warnings: [...state.warnings, ...githubWarnings],
      now
    })
  );
});

async function configureFrontend() {
  if (config.nodeEnv === "production") {
    const dist = join(dirname, "../../dist");
    app.use(express.static(dist));
    app.get(/.*/, (_req, res) => {
      res.sendFile(join(dist, "index.html"));
    });
    return;
  }

  const vite = await createViteServer({
    appType: "spa",
    server: { allowedHosts: config.allowedHosts, middlewareMode: true }
  });
  app.use(vite.middlewares);
}

await configureFrontend();

app.listen(config.port, config.host, () => {
  console.log(`agents-coordination-dashboard listening on http://${config.host}:${config.port}`);
});
