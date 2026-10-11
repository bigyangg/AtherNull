import http from "node:http";

// In-memory notes API. No dependencies on purpose: it builds and tests
// anywhere Node runs, including an offline sandbox.
export function createApp() {
  const notes = new Map();
  let nextId = 1;

  function send(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      return null;
    }
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, { status: "ok" });
    }

    if (req.method === "GET" && url.pathname === "/notes") {
      return send(res, 200, [...notes.values()]);
    }

    if (req.method === "POST" && url.pathname === "/notes") {
      const body = await readJson(req);
      if (!body || typeof body.text !== "string") {
        return send(res, 400, { error: "text is required" });
      }
      const note = { id: nextId++, text: body.text, createdAt: new Date().toISOString() };
      notes.set(note.id, note);
      return send(res, 201, note);
    }

    const match = /^\/notes\/(\d+)$/.exec(url.pathname);
    if (req.method === "GET" && match) {
      const note = notes.get(Number(match[1]));
      return note ? send(res, 200, note) : send(res, 404, { error: "not found" });
    }

    return send(res, 404, { error: "not found" });
  });
}
