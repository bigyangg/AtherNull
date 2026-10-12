import { buildApp } from "./app.js";

const app = await buildApp();

const port = Number(process.env.PORT ?? 3001);

// HOST=127.0.0.1 on a shared server: only the local ingress reaches the API.
app.listen({ port, host: process.env.HOST ?? "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
