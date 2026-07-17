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

const server = app.listen(config.port, config.host);
server.once("listening", () => {
  console.log(`agent-coordination-dashboard listening on http://${config.host}:${config.port}`);
});
server.once("error", (error: NodeJS.ErrnoException) => {
  const reason = error.code || error.message || "unknown error";
  process.stderr.write(
    `agent-coordination-dashboard could not listen on http://${config.host}:${config.port}: ${reason}\n`,
    () => {
      restoreLifecycleLogWriter?.();
      process.exit(1);
    }
  );
});
server.once("close", () => {
  restoreLifecycleLogWriter?.();
});
