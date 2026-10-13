/**
 * Checkout success landing page (served at GET /api/billing/success).
 *
 * This is the page Polar's hosted checkout redirects to right after payment.
 * By the time it renders, the route has already confirmed the checkout with
 * Polar and written the subscription (see `billing.ts`), so this page has two
 * jobs: confirm the payment beautifully, and SEND THE USER BACK. It navigates
 * to the app's deep link (`<scheme>://billing/upgraded?org=…`) as soon as it
 * loads and offers the same link as a button, because a browser may refuse
 * the automatic hop to a custom scheme, and a person left on a "success" page
 * with no way onward assumes the app never noticed.
 *
 * Hard constraints (keep them intact):
 *  - Fully self-contained: no network requests, no CDN fonts, no remote images.
 *    System font stack only; the logo is inlined as base64 data URIs.
 *  - Works in both light and dark via prefers-color-scheme (checkout may open
 *    in either), and honours prefers-reduced-motion.
 *
 * Branding mirrors the desktop's Logo.tsx: the 2ndBrain
 * wordmark, ink variant on light backgrounds and silver on dark, swapped by a
 * prefers-color-scheme media query over two <img> elements.
 */

// 2ndBrain wordmark — 360px-wide PNGs (2x for a 180px display), inlined so the
// page makes zero network requests. Ink shows on light, silver on dark.
const WORDMARK_INK_URI = "data:image/png;base64,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";
const WORDMARK_SILVER_URI = "data:image/png;base64,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";

/** JS-string-literal escape for a value that is dropped inside `<script>`. */
const jsString = (v: string): string => JSON.stringify(v).replace(/</g, "\\u003c");
/** HTML attribute escape. */
const attr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML text escape for a value interpolated into element content. */
const text = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The plan-specific copy. `vault` is the per-vault Pro page, unchanged. `team`
 * is the account-wide Team plan; `seats` comes from the confirmed subscription
 * and is null when the provider could not be read (or the checkout had not
 * produced a subscription yet), which falls back to a line without a count.
 */
export type SuccessPlan = { kind: "vault" } | { kind: "team"; seats: number | null };

function planCopy(plan: SuccessPlan): { title: string; heading: string; sub: string; foot: string } {
  if (plan.kind === "team") {
    const seats = plan.seats;
    const sub =
      seats !== null && Number.isInteger(seats) && seats > 0
        ? `Your team has ${text(String(seats))} ${seats === 1 ? "seat" : "seats"}. Every vault on your account now syncs without limits.`
        : "Your vaults now sync without limits.";
    return {
      title: "You're on Team — 2ndBrain",
      heading: "You&rsquo;re on Team",
      sub,
      foot: "your Team plan is already active",
    };
  }
  return {
    title: "You're on Pro — 2ndBrain",
    heading: "You&rsquo;re on Pro",
    sub: "Your vault is now unlimited.",
    foot: "your subscription is already there",
  };
}

/**
 * `deepLink` null means "do not hand back": a local `tauri dev` build
 * (`secondbrain-dev://`) cannot receive a deep link on macOS, so the page neither
 * redirects nor offers the button there, and just says to switch back.
 */
export function successPageHtml({
  deepLink,
  plan = { kind: "vault" },
}: {
  deepLink: string | null;
  plan?: SuccessPlan;
}): string {
  const copy = planCopy(plan);
  const handBack =
    deepLink === null
      ? `<p class="sub reveal d5">${copy.sub}</p>
    <div class="foot reveal d6">
      Switch back to 2ndBrain &mdash; your plan is already active. You can close this tab.
    </div>
  </main>`
      : `<p class="sub reveal d5">${copy.sub} Taking you back to 2ndBrain&hellip;</p>
    <a class="cta reveal d5" href="${attr(deepLink)}">Open 2ndBrain</a>
    <div class="foot reveal d6">
      Didn&rsquo;t open? Use the button above, or switch to 2ndBrain &mdash; ${copy.foot}.
      You can safely close this tab.
    </div>
  </main>
  <script>
    // Same hand-off as the account pages: hop into the app on load. The button
    // stays for browsers that only follow a custom scheme from a click.
    setTimeout(function () { location.href = ${jsString(deepLink)}; }, 600);
  </script>`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${copy.title}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg-0: #f2f1f6;
    --bg-1: #e9e7f1;
    --glow: rgba(127, 115, 255, 0.26);
    --ink: #17171c;
    --muted: #63636f;
    --faint: #9a9aa5;
    --accent: #6a5cf5;
    --accent-2: #7f73ff;
    --hairline: rgba(20, 20, 40, 0.10);
    --badge-ring: rgba(255, 255, 255, 0.9);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-0: #0a0b0f;
      --bg-1: #101218;
      --glow: rgba(127, 115, 255, 0.30);
      --ink: #f0f1f4;
      --muted: #9aa0ac;
      --faint: #6b6f7a;
      --accent: #8f84ff;
      --accent-2: #a49bff;
      --hairline: rgba(255, 255, 255, 0.10);
      --badge-ring: rgba(12, 13, 17, 0.85);
    }
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    color: var(--ink);
    background:
      radial-gradient(120% 80% at 50% -10%, var(--glow) 0%, transparent 55%),
      radial-gradient(100% 100% at 50% 120%, rgba(127,115,255,0.06) 0%, transparent 60%),
      linear-gradient(180deg, var(--bg-0) 0%, var(--bg-1) 100%);
    background-attachment: fixed;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100dvh;
    padding: 6vh 24px;
  }

  .stage {
    width: 100%;
    max-width: 30rem;
    text-align: center;
  }

  /* Standalone success badge — the confirmation moment, above the wordmark */
  .badge {
    position: relative;
    width: 56px;
    height: 56px;
    margin: 0 auto 28px;
    border-radius: 50%;
    background: linear-gradient(150deg, var(--accent-2) 0%, var(--accent) 100%);
    box-shadow: 0 14px 34px -8px var(--glow), 0 0 0 4px var(--badge-ring);
    display: grid;
    place-items: center;
  }
  .badge::before {
    content: "";
    position: absolute;
    inset: -55%;
    border-radius: 50%;
    background: radial-gradient(circle, var(--glow) 0%, transparent 65%);
    filter: blur(6px);
    z-index: -1;
    animation: halo 5.5s ease-in-out infinite;
  }
  .badge svg { width: 26px; height: 26px; }
  .badge path {
    fill: none;
    stroke: #fff;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 22;
    stroke-dashoffset: 22;
    animation: draw .5s cubic-bezier(.65,0,.35,1) .55s forwards;
  }

  /* 2ndBrain wordmark — ink on light, silver on dark (mirrors Logo.tsx) */
  .wordmark { display: block; margin: 0 auto 30px; line-height: 0; }
  .wordmark img { width: 180px; height: auto; display: inline-block; }
  .wordmark img.wm-silver { display: none; }
  @media (prefers-color-scheme: dark) {
    .wordmark img.wm-ink { display: none; }
    .wordmark img.wm-silver { display: inline-block; }
  }

  .eyebrow {
    font-size: 0.72rem;
    font-weight: 650;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 14px;
  }
  h1 {
    font-size: clamp(1.9rem, 6vw, 2.5rem);
    font-weight: 640;
    letter-spacing: -0.028em;
    line-height: 1.05;
    margin: 0 0 16px;
  }
  .sub {
    font-size: 1.02rem;
    line-height: 1.6;
    color: var(--muted);
    margin: 0 auto;
    max-width: 21rem;
    text-align: center;
    text-wrap: balance;
  }

  .cta {
    display: inline-block;
    margin-top: 26px;
    padding: 12px 22px;
    border-radius: 999px;
    background: linear-gradient(150deg, var(--accent-2) 0%, var(--accent) 100%);
    color: #fff;
    font-weight: 600;
    font-size: 0.95rem;
    text-decoration: none;
    box-shadow: 0 10px 26px -10px var(--glow);
    transition: transform .15s ease, box-shadow .15s ease;
  }
  .cta:hover { transform: translateY(-1px); box-shadow: 0 14px 30px -10px var(--glow); }
  .cta:active { transform: none; }

  .foot {
    margin-top: 34px;
    padding-top: 22px;
    border-top: 1px solid var(--hairline);
    font-size: 0.86rem;
    color: var(--faint);
  }
  .foot a {
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: color .15s ease, border-color .15s ease;
  }
  .foot a:hover { color: var(--accent); border-color: var(--accent); }

  /* Staggered entrance */
  .reveal { opacity: 0; transform: translateY(14px); animation: rise .7s cubic-bezier(.22,1,.36,1) forwards; }
  .d1 { animation-delay: .05s; }
  .d2 { animation-delay: .16s; }
  .d3 { animation-delay: .26s; }
  .d4 { animation-delay: .36s; }
  .d5 { animation-delay: .46s; }
  .d6 { animation-delay: .6s; }

  @keyframes rise { to { opacity: 1; transform: none; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes halo {
    0%, 100% { opacity: 0.7; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.06); }
  }

  @media (prefers-reduced-motion: reduce) {
    .reveal { opacity: 1; transform: none; animation: none; }
    .badge::before { animation: none; }
    .badge path { animation: none; stroke-dashoffset: 0; }
  }
</style>
</head>
<body>
  <main class="stage">
    <div class="badge reveal d1" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7"/></svg>
    </div>
    <span class="wordmark reveal d2" role="img" aria-label="2ndBrain">
      <img class="wm-ink" src="${WORDMARK_INK_URI}" alt="" width="180" height="32">
      <img class="wm-silver" src="${WORDMARK_SILVER_URI}" alt="" width="180" height="32">
    </span>
    <p class="eyebrow reveal d3">Payment confirmed</p>
    <h1 class="reveal d4">${copy.heading}</h1>
    ${handBack}
</body></html>`;
}
