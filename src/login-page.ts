import type { KindeOrganization, KindeUser } from "./types.js";

export interface LoginPageUser {
  user: KindeUser;
  organizations: KindeOrganization[];
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--ink:#16161a;--muted:#6b6b76;--line:#e4e4e0;--accent:#16161a;--accent-ink:#fff;--warn:#8a5a00;--warn-bg:#fff6e0}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--card:#1a1a1d;--ink:#ececf0;--muted:#9b9ba6;--line:#2c2c31;--accent:#ececf0;--accent-ink:#111113;--warn:#f0c46a;--warn-bg:#2a2210}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
main{width:100%;max-width:420px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px}
.brand{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;color:var(--muted);text-transform:uppercase}
h1{font-size:22px;line-height:1.25;margin:10px 0 6px;font-weight:600}
p{margin:0;color:var(--muted)}
.note{margin-top:16px;padding:10px 12px;border-radius:8px;background:var(--warn-bg);color:var(--warn);font-size:13px}
form{margin:0}
label{display:block;font-size:13px;font-weight:500;margin:20px 0 6px}
input[type=email]{width:100%;height:42px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit}
input[type=email]:focus{outline:2px solid var(--accent);outline-offset:1px}
.primary{margin-top:12px;width:100%;height:42px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-family:inherit;font-size:15px;font-weight:600;cursor:pointer}
h2{font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);margin:26px 0 8px}
.list{display:grid;gap:8px}
.option{display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;text-align:left;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--ink);font:inherit;cursor:pointer}
.option:hover{border-color:var(--muted)}
.option strong{display:block;font-weight:500}
.option small{color:var(--muted);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.tag{flex:none;font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.error{margin-top:16px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);font-size:14px}
`;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><div class="brand">kinde-testkit</div>${body}</main></body></html>`;
}

function displayName(user: KindeUser): string {
  return [user.givenName, user.familyName].filter(Boolean).join(" ") || user.email || user.id;
}

const SOCIAL_CONNECTIONS = ["google", "github", "microsoft", "apple", "facebook", "gitlab", "linkedin", "slack", "x"];

function select(id: string, label: string, options: Array<[string, string]>): string {
  return `<label for="${id}">${label}</label><select id="${id}" name="${id}" style="width:100%;height:38px;padding:0 10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit">${options
    .map(([value, text]) => `<option value="${value}">${escapeHtml(text)}</option>`)
    .join("")}</select>`;
}

/** Choices for testing other sign-in methods and their failures. */
function testOptions(): string {
  return `<h2>Test options</h2>${select("connection", "Sign in with", [
    ["email", "Email"],
    ...SOCIAL_CONNECTIONS.map((c): [string, string] => [c, c === "x" ? "X" : c[0]!.toUpperCase() + c.slice(1)]),
  ])}${select("provider_result", "Provider result", [
    ["success", "Signed in"],
    ["cancelled", "User cancelled"],
    ["error", "Provider error"],
  ])}${select("mfa", "Multi-factor authentication", [
    ["none", "Not required"],
    ["passed", "Passed"],
    ["failed", "Wrong code"],
    ["cancelled", "Cancelled"],
  ])}`;
}

export function renderSignIn(options: {
  request: string;
  users: LoginPageUser[];
  loginHint?: string;
  requiredOrganization?: string;
  error?: string;
}): string {
  const users = options.users
    .map(({ user, organizations }) => {
      const value = escapeHtml(user.email ?? user.id);
      const hasName = Boolean(user.givenName || user.familyName);
      const detail = escapeHtml(hasName ? (user.email ?? user.id) : user.id);
      const tag =
        organizations.length === 0
          ? "no organization"
          : organizations.length === 1
            ? escapeHtml(organizations[0]!.code)
            : `${organizations.length} organizations`;
      return `<button class="option" type="submit" name="user" value="${value}"><span><strong>${escapeHtml(displayName(user))}</strong><small>${detail}</small></span><span class="tag">${tag}</span></button>`;
    })
    .join("");
  const orgNote = options.requiredOrganization
    ? `<p class="note">The app asked to sign in to <strong>${escapeHtml(options.requiredOrganization)}</strong>.</p>`
    : "";
  return layout(
    "Sign in",
    `<h1>Sign in</h1><p>Test sign-in. Tokens are signed with a local key and are only valid for this issuer.</p>${orgNote}${
      options.error ? `<div class="error" role="alert">${escapeHtml(options.error)}</div>` : ""
    }<form method="post" action="/oauth2/auth/login"><input type="hidden" name="request" value="${escapeHtml(options.request)}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="off" value="${escapeHtml(options.loginHint ?? "")}" placeholder="name@example.test"><button class="primary" type="submit">Continue</button>${
      users ? `<h2>Seeded users</h2><div class="list">${users}</div>` : ""
    }${testOptions()}</form>`,
  );
}

export function renderOrganizationPicker(options: {
  request: string;
  user: KindeUser;
  organizations: KindeOrganization[];
  /** Form fields to send again with the chosen organization, such as the sign-in method. */
  carry?: Record<string, string>;
}): string {
  const carried = Object.entries(options.carry ?? {})
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("");
  const choices = options.organizations
    .map(
      (org) =>
        `<button class="option" type="submit" name="org" value="${escapeHtml(org.code)}"><span><strong>${escapeHtml(org.name)}</strong><small>${escapeHtml(org.code)}</small></span></button>`,
    )
    .join("");
  return layout(
    "Choose an organization",
    `<h1>Choose an organization</h1><p>${escapeHtml(options.user.email ?? options.user.id)} belongs to more than one organization.</p><form method="post" action="/oauth2/auth/login"><input type="hidden" name="request" value="${escapeHtml(options.request)}"><input type="hidden" name="user" value="${escapeHtml(options.user.email ?? options.user.id)}">${carried}<div class="list" style="margin-top:20px">${choices}</div></form>`,
  );
}

export function renderMessage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

/** The page a user opens from a device's verification_uri. */
export function renderDeviceCodeEntry(options: { userCode?: string; error?: string } = {}): string {
  return layout(
    "Connect a device",
    `<h1>Connect a device</h1><p>Enter the code the device shows.</p>${
      options.error ? `<div class="error" role="alert">${escapeHtml(options.error)}</div>` : ""
    }<form method="get" action="/device"><label for="user_code">Code</label><input id="user_code" name="user_code" type="text" autocomplete="off" value="${escapeHtml(options.userCode ?? "")}" placeholder="ABCDEFGH" style="width:100%;height:42px;padding:0 12px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;letter-spacing:.2em"><button class="primary" type="submit">Continue</button></form>`,
  );
}

/** Asks the user to confirm the device before signing in. */
export function renderDeviceConfirm(options: { userCode: string; clientId: string }): string {
  const code = escapeHtml(options.userCode);
  return layout(
    "Connect a device",
    `<h1>Connect a device</h1><p>A device using the app <strong>${escapeHtml(options.clientId)}</strong> wants to sign in. Check that it shows this code.</p><p class="note" style="font:600 20px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;text-align:center">${code}</p><form method="get" action="/device/sign-in"><input type="hidden" name="user_code" value="${code}"><button class="primary" type="submit">Continue</button></form><form method="post" action="/device/deny"><input type="hidden" name="user_code" value="${code}"><button class="option" type="submit" style="margin-top:8px;justify-content:center">Deny</button></form>`,
  );
}
