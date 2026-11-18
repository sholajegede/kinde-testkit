import type { RequestEntry, TokenEntry } from "./activity.js";
import type { CoverageReport } from "./coverage.js";
import type { ActiveFailure } from "./failures.js";
import { escapeHtml } from "./login-page.js";
import { effectivePermissions, type ResolvedSeed } from "./seed.js";
import type { WebhookDelivery, WebhookEndpoint } from "./webhooks.js";

export interface DashboardData {
  issuer: string;
  seed: ResolvedSeed;
  suspended: (userId: string) => boolean;
  signIns: (userId: string) => number;
  tokens: TokenEntry[];
  requests: RequestEntry[];
  deliveries: WebhookDelivery[];
  endpoints: WebhookEndpoint[];
  failures: ActiveFailure[];
  coverage: CoverageReport;
  webhookTypes: readonly string[];
  live: boolean;
  notice: string | null;
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e4e4e0;--accent:#16161a;--accent-ink:#fff;--ok:#1d7a46;--bad:#b42318;--soft:#f0f0ec}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1a1a1d;--ink:#ececf0;--muted:#9b9ba6;--line:#2c2c31;--accent:#ececf0;--accent-ink:#111113;--ok:#5cc78a;--bad:#f0817a;--soft:#232327}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between;padding:14px 28px;background:var(--card);border-bottom:1px solid var(--line)}
header .brand{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
header .issuer{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
nav{display:flex;flex-wrap:wrap;gap:14px;font-size:13px}
nav a{color:var(--muted);text-decoration:none}nav a:hover{color:var(--ink)}
main{max-width:1180px;margin:0 auto;padding:24px 28px 60px;display:grid;gap:22px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;overflow:hidden}
h2{margin:0 0 4px;font-size:16px;font-weight:600}
.sub{margin:0 0 14px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;font-weight:500;color:var(--muted);border-bottom:1px solid var(--line);padding:6px 10px 6px 0;white-space:nowrap}
td{border-bottom:1px solid var(--line);padding:7px 10px 7px 0;vertical-align:top}
tr:last-child td{border-bottom:0}
code,.mono{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.chips{display:flex;flex-wrap:wrap;gap:4px}
.chip{font:11px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border-radius:5px;padding:0 6px}
.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--muted)}
.empty{color:var(--muted);font-size:13px;margin:0}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:end}
label{display:grid;gap:3px;font-size:12px;color:var(--muted)}
input,select{height:32px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink);font:13px ui-sans-serif,system-ui,sans-serif}
input[type=checkbox]{height:auto}
button{height:32px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink);font:500 13px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
button:hover{border-color:var(--muted)}
details summary{cursor:pointer;color:var(--muted)}
pre{margin:8px 0 0;padding:10px;background:var(--soft);border-radius:6px;overflow:auto;max-height:320px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px 26px}
.group{display:flex;justify-content:space-between;font-weight:500;margin-bottom:4px}
.group+ul{list-style:none;margin:0 0 10px;padding:0;font-size:13px}
.notice{padding:10px 14px;border-radius:8px;background:var(--soft);font-size:13px}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:22px}
`;

export function renderDashboard(data: DashboardData): string {
  const e = escapeHtml;
  const { seed } = data;
  const orgName = (code: string) => seed.organizations.find((o) => o.code === code)?.name ?? code;
  const userLabel = (id: string) => seed.users.find((u) => u.id === id)?.email ?? id;

  const users = seed.users.length
    ? table(
        ["User", "ID", "Organizations", "Sign-ins", "Status"],
        seed.users.map((user) => [
          e([user.givenName, user.familyName].filter(Boolean).join(" ") || user.email || user.id) +
            (user.email ? `<div class="muted">${e(user.email)}</div>` : ""),
          `<code>${e(user.id)}</code>`,
          chips(seed.memberships.filter((m) => m.userId === user.id).map((m) => m.organizationCode)),
          String(data.signIns(user.id)),
          data.suspended(user.id) ? `<span class="bad">Suspended</span>` : `<span class="ok">Active</span>`,
        ]),
      )
    : empty("No users yet. Seed some, or sign in with any email.");

  const organizations = seed.organizations.length
    ? table(
        ["Organization", "Code", "Members"],
        seed.organizations.map((org) => [
          e(org.name),
          `<code>${e(org.code)}</code>`,
          String(seed.memberships.filter((m) => m.organizationCode === org.code).length),
        ]),
      )
    : empty("No organizations.");

  const memberships = seed.memberships.length
    ? table(
        ["User", "Organization", "Roles", "Permissions in the token"],
        seed.memberships.map((m) => [
          e(userLabel(m.userId)),
          e(orgName(m.organizationCode)),
          chips(m.roles),
          chips(effectivePermissions(seed, m)),
        ]),
      )
    : empty("No memberships.");

  const applications = seed.applications.length
    ? table(
        ["Client ID", "Organization", "Scopes"],
        seed.applications.map((a) => [`<code>${e(a.clientId)}</code>`, e(a.organizationCode ?? "none"), chips(a.scopes ?? [])]),
      )
    : "";

  const tokens = data.tokens.length
    ? table(
        ["Issued", "Kind", "Subject", "Organization", "Permissions", ""],
        [...data.tokens].reverse().slice(0, 50).map((t) => [
          time(t.at),
          t.invalid ? `${e(t.kind)} <span class="bad">${e(t.invalid)}</span>` : e(t.kind),
          `<code>${e(t.subject ?? "none")}</code>`,
          e(t.organization ?? "none"),
          chips(t.permissions),
          `<details><summary>Claims</summary><pre>${e(JSON.stringify(t.claims, null, 2))}</pre><pre>${e(t.token)}</pre></details>`,
        ]),
      )
    : empty("No tokens issued yet.");

  const requests = data.requests.length
    ? table(
        ["Time", "Request", "Status", "Time taken"],
        [...data.requests].reverse().slice(0, 100).map((r) => [
          time(r.at),
          `<code>${e(r.method)} ${e(r.path)}</code>`,
          `<span class="${r.status >= 400 ? "bad" : "ok"}">${r.status}</span>${r.injected ? ` <span class="muted">injected</span>` : ""}`,
          `${r.durationMs} ms`,
        ]),
      )
    : empty("No requests yet.");

  const deliveries = data.deliveries.length
    ? table(
        ["Event", "Endpoint", "Copy", "Result"],
        [...data.deliveries].reverse().slice(0, 50).map((d) => [
          `<code>${e(d.type)}</code>`,
          `<code>${e(d.url)}</code>`,
          String(d.copy),
          d.delivered
            ? `<span class="ok">Delivered</span>`
            : `<span class="bad">${e(d.attempts.map((a) => (a.status === null ? (a.error ?? "error") : String(a.status))).join(", ") || "Not sent")}</span>`,
        ]),
      )
    : empty("No webhooks sent yet.");

  const endpoints = data.endpoints.length
    ? `<p class="sub">Endpoints: ${data.endpoints.map((x) => `<code>${e(x.url)}</code>`).join(", ")}</p>`
    : `<p class="sub">No webhook endpoints. Add one in the seed, with <code>start --webhook</code> or <code>addEndpoint()</code>.</p>`;

  const webhookForm = data.endpoints.length
    ? form(
        "/dashboard/webhooks",
        `<label>Event<select name="type">${data.webhookTypes.map((t) => `<option>${e(t)}</option>`).join("")}</select></label>
         <label>User<select name="user"><option value="">First seeded user</option>${seed.users.map((u) => `<option value="${e(u.id)}">${e(u.email ?? u.id)}</option>`).join("")}</select></label>
         <label>Variant<select name="invalid"><option value="">Valid</option><option>bad-signature</option><option>unknown-key</option><option>unsigned</option><option>stale</option></select></label>
         <label>Copies<input name="duplicate" type="number" min="1" max="10" value="1" style="width:70px"></label>
         <button class="primary">Send</button>`,
      )
    : "";

  const failures = data.failures.length
    ? table(
        ["Path", "Method", "Effect", "Remaining", "Hits", ""],
        data.failures.map((f) => [
          `<code>${e(f.path)}</code>`,
          e(f.method ?? "any"),
          e(f.hang ? "Hang" : [f.status !== null ? `Status ${f.status}` : "", f.delayMs ? `Delay ${f.delayMs} ms` : ""].filter(Boolean).join(", ")),
          f.remaining === null ? "Until removed" : String(f.remaining),
          String(f.hits),
          form(`/dashboard/failures/${encodeURIComponent(f.id)}/remove`, `<button>Remove</button>`),
        ]),
      )
    : empty("No failure rules.");

  const coverage = `<div class="grid">${data.coverage.groups
    .map(
      (g) =>
        `<div><div class="group"><span>${e(g.name)}</span><span class="${g.covered === g.total ? "ok" : "muted"}">${g.covered}/${g.total}</span></div><ul>${g.items
          .map((i) => `<li title="${e(i.hint)}"><span class="${i.covered ? "ok" : "muted"}">${i.covered ? "✓" : "○"}</span> ${e(i.label)}</li>`)
          .join("")}</ul></div>`,
    )
    .join("")}</div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${data.live ? `<meta http-equiv="refresh" content="3">` : ""}
<title>kinde-testkit dashboard</title><style>${STYLE}</style></head><body>
<header>
  <div><div class="brand">kinde-testkit</div><div class="issuer">${e(data.issuer)}</div></div>
  <nav><a href="#users">Users</a><a href="#tokens">Tokens</a><a href="#requests">Requests</a><a href="#webhooks">Webhooks</a><a href="#failures">Failures</a><a href="#coverage">Coverage</a></nav>
  <div class="row">
    <a href="${data.live ? "/dashboard" : "/dashboard?live=1"}"><button type="button">${data.live ? "Stop live updates" : "Live updates"}</button></a>
    ${form("/dashboard/reset", `<button>Reset state</button>`)}
  </div>
</header>
<main>
${data.notice ? `<div class="notice">${e(data.notice)}</div>` : ""}
<section id="users"><h2>Users</h2><p class="sub">Seeded users, users created through the Management API, and emails that signed in.</p>${users}</section>
<div class="split">
<section><h2>Organizations</h2><p class="sub">Codes your app sees in <code>org_code</code>.</p>${organizations}</section>
<section><h2>Memberships</h2><p class="sub">Role permissions are added to the member's own.</p>${memberships}</section>
</div>
${applications ? `<section><h2>Machine-to-machine applications</h2><p class="sub">Clients that call the client_credentials grant.</p>${applications}</section>` : ""}
<section id="tokens"><h2>Issued tokens</h2><p class="sub">The latest 50 access, ID and machine-to-machine tokens.</p>${tokens}</section>
<section id="requests"><h2>Requests</h2><p class="sub">The latest 100 requests your app and tests made. Codes, secrets and refresh tokens are hidden.</p>${requests}</section>
<section id="webhooks"><h2>Webhook deliveries</h2>${endpoints}${webhookForm}<div style="margin-top:14px">${deliveries}</div></section>
<section id="failures"><h2>Failures</h2><p class="sub">Make an endpoint fail, slow down or hang. Applies to Kinde endpoints, not <code>/testkit</code> or this page.</p>
${form(
  "/dashboard/failures",
  `<label>Path<input name="path" value="/oauth2/token" required style="width:200px"></label>
   <label>Method<select name="method"><option value="">Any</option><option>GET</option><option>POST</option><option>PATCH</option><option>DELETE</option></select></label>
   <label>Status<input name="status" type="number" min="100" max="599" placeholder="503" style="width:80px"></label>
   <label>Delay ms<input name="delayMs" type="number" min="0" max="60000" style="width:90px"></label>
   <label>Times<input name="times" type="number" min="1" placeholder="all" style="width:70px"></label>
   <label><span>Hang</span><input name="hang" type="checkbox" value="1"></label>
   <button class="primary">Add rule</button>`,
)}
<div style="margin-top:14px">${failures}</div>
${data.failures.length ? `<div style="margin-top:10px">${form("/dashboard/failures/clear", `<button>Remove all</button>`)}</div>` : ""}
</section>
<section id="coverage"><h2>Coverage: ${data.coverage.covered}/${data.coverage.total}</h2><p class="sub">Authentication scenarios the testkit produced since it started or was reset. Hover an item to see how to cover it.</p>${coverage}
<div style="margin-top:6px">${form("/dashboard/coverage/reset", `<button>Clear coverage</button>`)}</div></section>
</main></body></html>`;
}

function table(headers: string[], rows: string[][]): string {
  return `<table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function chips(values: string[]): string {
  if (values.length === 0) return `<span class="muted">none</span>`;
  return `<div class="chips">${values.map((v) => `<span class="chip">${escapeHtml(v)}</span>`).join("")}</div>`;
}

function empty(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

function time(iso: string): string {
  return `<span class="mono">${escapeHtml(iso.slice(11, 19))}</span>`;
}

function form(action: string, body: string): string {
  return `<form method="post" action="${escapeHtml(action)}" class="row">${body}</form>`;
}
