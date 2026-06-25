import { createDashboardApp } from "./app";
import { readConfig } from "./config";

const config = readConfig();
const app = await createDashboardApp(config);

app.listen(config.port, config.host, () => {
  console.log(`agents-coordination-dashboard listening on http://${config.host}:${config.port}`);
});
