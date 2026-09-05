import express from "express";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "./config";
import { readDoctorReport } from "./doctor";
import { createHostGuard } from "./security/hostGuard";
import { isLoopbackAddress } from "./security/loopback";
import { isMachineLocalAddress, type MachineInterfaceMap } from "./security/machineLocal";
import { normalizeTargetRepos, readDashboardSettings, settingsPath, writeDashboardSettings } from "./settings";

interface CreateDashboardAppOptions {
  serveFrontend?: boolean;
  machineInterfaces?: MachineInterfaceMap;
}

export async function createDashboardApp(config: ServerConfig, options: CreateDashboardAppOptions = {}) {
  const app = express();
  const persistedSettingsPath = settingsPath(config.settingsPath);

  app.use(createHostGuard(config.allowedHosts));
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/doctor", async (req, res) => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      res.status(403).json({
        error: "Coordination diagnostics can only be read from the machine running the dashboard."
      });
      return;
    }

    res.json(await readDoctorReport({
      stateRoot: config.stateRoot,
      apiUrl: config.coordApiUrl,
      token: config.coordApiToken,
      tokenEnvVar: config.coordApiTokenEnvVar
    }));
  });

  app.get("/api/settings", async (_req, res) => {
    res.json(await readDashboardSettings(persistedSettingsPath, { targetRepos: config.targetRepos }));
  });

  app.put("/api/settings", async (req, res) => {
    if (!isMachineLocalAddress(req.socket.remoteAddress, options.machineInterfaces)) {
      res.status(403).json({
        error: "Settings can only be changed from the machine running the dashboard. Remote viewers have read-only access."
      });
      return;
    }

    const targetRepos = normalizeTargetRepos(req.body?.targetRepos);
    if (targetRepos.length === 0) {
      res.status(400).json({ error: "At least one owner/repo target is required." });
      return;
    }

    res.json(await writeDashboardSettings(persistedSettingsPath, { targetRepos }));
  });

  if (options.serveFrontend !== false) {
    if (config.nodeEnv === "production") {
      const dirname = fileURLToPath(new URL(".", import.meta.url));
      const dist = join(dirname, "../../dist");
      app.use(express.static(dist));
      app.get(/.*/, (_req, res) => {
        res.sendFile(join(dist, "index.html"));
      });
    } else {
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        appType: "spa",
        server: { allowedHosts: config.allowedHosts, middlewareMode: true }
      });
      app.use(vite.middlewares);
    }
  }

  return app;
}
