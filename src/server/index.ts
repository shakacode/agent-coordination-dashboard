import { installLifecycleLogWriter } from "../../bin/lifecycle.js";
import { createDashboardApp } from "./app";
import { readConfig } from "./config";

const lifecycleInstanceIndex = process.argv.indexOf("--lifecycle-instance");
const restoreLifecycleLogWriter = lifecycleInstanceIndex >= 0 &&
  /^[a-f0-9]{32}$/.test(process.argv[lifecycleInstanceIndex + 1] || "")
  ? installLifecycleLogWriter()
  : null;

const config = readConfig();
const app = await createDashboardApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`agent-coordination-dashboard listening on http://${config.host}:${config.port}`);
});
server.once("close", () => {
  restoreLifecycleLogWriter?.();
});
