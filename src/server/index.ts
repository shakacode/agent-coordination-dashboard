import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { readConfig } from "./config";
import { loadOpenGitHubItems } from "./github/githubClient";
import { buildDashboardModel } from "./state/buildDashboardModel";
import { readCoordinationState } from "./state/readCoordinationState";

const app = express();
const config = readConfig();
const dirname = fileURLToPath(new URL(".", import.meta.url));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/dashboard", async (_req, res) => {
  const now = new Date();
  const state = await readCoordinationState(config.stateRoot, now);
  const githubResults = await Promise.all(
    config.targetRepos.map(async (repo) => {
      try {
        return await loadOpenGitHubItems(repo);
      } catch {
        return [];
      }
    })
  );

  res.json(
    buildDashboardModel({
      stateRoot: config.stateRoot,
      targetRepos: config.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      githubItems: githubResults.flat(),
      warnings: state.warnings,
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
    server: { middlewareMode: true }
  });
  app.use(vite.middlewares);
}

await configureFrontend();

app.listen(config.port, () => {
  console.log(`agents-coordination-dashboard listening on http://localhost:${config.port}`);
});
