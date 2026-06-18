import express from "express";

const app = express();
const port = Number(process.env.PORT || 4317);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`agents-coordination-dashboard listening on http://localhost:${port}`);
});

