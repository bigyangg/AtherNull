import { fromNodeHeaders } from "better-auth/node";
import Fastify from "fastify";
import { auth } from "./auth.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ status: "ok" }));

// Better Auth owns everything under /api/auth/* (ADR-0004). Fastify hands the
// raw Node request/response straight to auth.handler via the Fetch API
// adapter — per Better Auth's own Fastify integration guide, not a custom
// scheme, so upgrades to the library don't require re-deriving this.
app.route({
  method: ["GET", "POST"],
  url: "/api/auth/*",
  async handler(request, reply) {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const headers = fromNodeHeaders(request.headers);

    const req = new Request(url.toString(), {
      method: request.method,
      headers,
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });

    const response = await auth.handler(req);

    reply.status(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(response.body ? await response.text() : null);
  },
});

const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
