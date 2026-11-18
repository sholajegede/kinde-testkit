/**
 * Steps for signing in through the testkit with plain HTTP requests instead of a browser page.
 * The Cypress commands use these. No Node APIs here, because Cypress bundles this file for the browser.
 */

export interface RequestSignInOptions {
  /** Email address or ID of the user. */
  user: string;
  /** Active organization, for users in more than one. */
  org?: string;
}

/** The app's login route, with the hints the testkit sign-in page reads. */
export function appLoginUrl(loginPath: string, options: RequestSignInOptions): string {
  const params = new URLSearchParams({ login_hint: options.user });
  if (options.org) params.set("org_code", options.org);
  return `${loginPath}${loginPath.includes("?") ? "&" : "?"}${params}`;
}

/** Reads the hidden request field from the testkit sign-in page. */
export function readSignInRequest(html: string): string {
  const match = /name="request" value="([^"]+)"/.exec(html);
  if (!match) {
    throw new Error("The page is not the kinde-testkit sign-in page. Check that the app's KINDE_ISSUER_URL points at the testkit.");
  }
  return decodeEntities(match[1]!);
}

/** The form the sign-in page posts to /oauth2/auth/login. */
export function signInForm(request: string, options: RequestSignInOptions): Record<string, string> {
  const form: Record<string, string> = { request, email: options.user };
  if (options.org) form.org = options.org;
  return form;
}

/** Explains why the testkit did not redirect back to the app after the form was posted. */
export function signInFailure(status: number, html: string, options: RequestSignInOptions): Error {
  if (status === 200 && html.includes("Choose an organization")) {
    return new Error(`${options.user} belongs to more than one organization. Pass one with { org: "org_..." }.`);
  }
  const alert = /role="alert"[^>]*>([\s\S]*?)<\//.exec(html)?.[1];
  const text = alert ? decodeEntities(alert.replace(/<[^>]+>/g, "")).trim() : `the sign-in page answered ${status}`;
  return new Error(`kinde-testkit refused the sign-in: ${text}`);
}

/** Resolves a Location header, which can be relative, against the URL that sent it. */
export function resolveLocation(location: string, from: string): string {
  return new URL(location, from).toString();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
