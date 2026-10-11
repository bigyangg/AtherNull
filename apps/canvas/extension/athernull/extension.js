// AtherNull Builds — Agent Canvas extension (ADR-0015).
//
// Embeds AtherNull's own build flow (plan -> budget -> devnet funding ->
// review -> on-chain settlement), served from the same origin, so the
// session cookie and every server-side check apply unchanged. The canvas
// stays the place to watch and steer the agent; this page is where the
// money and the decisions live.
//
//   /extensions/athernull/builds            -> AtherNull dashboard
//   /extensions/athernull/builds/<app path> -> that AtherNull page
//   ?prompt=...                             -> carried over from the canvas
//                                              home composer

export function activate(host) {
  return host.registerPage("builds", ({ container, path }) => {
    const appPath = path ? `/${String(path).replace(/^\/+/, "")}` : "/dashboard";
    const src = new URL(appPath, window.location.origin);
    const prompt = new URLSearchParams(window.location.search).get("prompt");
    if (prompt) src.searchParams.set("prompt", prompt);
    src.searchParams.set("embed", "canvas");

    const frame = document.createElement("iframe");
    frame.src = src.pathname + src.search;
    frame.title = "AtherNull Builds";
    frame.style.cssText = "display:block;width:100%;height:100%;min-height:100vh;border:0;background:var(--oh-color-base,#141414);";
    container.append(frame);
    return () => frame.remove();
  });
}
