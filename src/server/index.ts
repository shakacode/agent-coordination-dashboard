import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { readConfig } from "./config";
import { loadOpenGitHubItems } from "./github/githubClient";
import { createHostGuard } from "./security/hostGuard";
import { isLoopbackAddress } from "./security/loopback";
import { normalizeTargetRepos, readDashboardSettings, settingsPath, writeDashboardSettings } from "./settings";
import { buildDashboardModel } from "./state/buildDashboardModel";
import { readCoordinationState } from "./state/readCoordinationState";

const app = express();
const config = readConfig();
const persistedSettingsPath = settingsPath(config.settingsPath);
const dirname = fileURLToPath(new URL(".", import.meta.url));

app.use(createHostGuard(config.allowedHosts));
app.use(express.json({ limit: "32kb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

async function currentSettings() {
  return readDashboardSettings(persistedSettingsPath, { targetRepos: config.targetRepos });
}

app.get("/api/settings", async (_req, res) => {
  res.json(await currentSettings());
});

app.put("/api/settings", async (req, res) => {
  if (!isLoopbackAddress(req.socket.remoteAddress)) {
    res.status(403).json({ error: "Settings updates are only allowed from loopback clients." });
    return;
  }

  const targetRepos = normalizeTargetRepos(req.body?.targetRepos);
  if (targetRepos.length === 0) {
    res.status(400).json({ error: "At least one owner/repo target is required." });
    return;
  }

  res.json(await writeDashboardSettings(persistedSettingsPath, { targetRepos }));
});

app.get("/api/dashboard", async (_req, res) => {
  const now = new Date();
  const settings = await currentSettings();
  const state = await readCoordinationState(config.stateRoot, now);
  const githubResults = await Promise.all(
    settings.targetRepos.map((repo) => loadOpenGitHubItems(repo))
  );
  const githubItems = githubResults.flatMap((result) => result.items);
  const githubWarnings = githubResults.flatMap((result) => result.warnings);

  res.json(
    buildDashboardModel({
      stateRoot: config.stateRoot,
      targetRepos: settings.targetRepos,
      claims: state.claims,
      heartbeats: state.heartbeats,
      batches: state.batches,
      events: state.events,
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
