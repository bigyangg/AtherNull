"use client";

// Last resort: the root layout itself failed, so nothing else (styles,
// header, providers) can be relied on. Plain HTML with inline styles only.
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          color: "#131319",
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          padding: 24,
        }}
      >
        <main style={{ maxWidth: 520 }}>
          <p style={{ margin: 0, color: "#5143c8", fontSize: 12, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase" }}>
            AtherNull
          </p>
          <h1 style={{ margin: "14px 0 0", fontSize: 40, letterSpacing: "-.04em", lineHeight: 1.05 }}>Something went wrong.</h1>
          <p style={{ margin: "16px 0 0", color: "#555560", lineHeight: 1.6 }}>
            AtherNull hit an unexpected problem. Please try again. If it keeps happening, email support@athernull.io
            {error.digest ? " and include the reference below" : ""}.
          </p>
          <div style={{ display: "flex", gap: 10, marginTop: 28 }}>
            <button
              type="button"
              onClick={reset}
              style={{ background: "#131319", color: "#fff", border: 0, borderRadius: 999, padding: "10px 18px", fontWeight: 600, cursor: "pointer" }}
            >
              Try again
            </button>
            <a href="/" style={{ color: "#131319", border: "1px solid #e7e7eb", borderRadius: 999, padding: "10px 18px", fontWeight: 600, textDecoration: "none" }}>
              Go home
            </a>
          </div>
          {error.digest && <p style={{ marginTop: 24, color: "#9a9aa3", fontFamily: "ui-monospace, monospace", fontSize: 12 }}>Reference: {error.digest}</p>}
        </main>
      </body>
    </html>
  );
}
