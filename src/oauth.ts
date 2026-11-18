import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createKindeUser } from "./factories.js";
import { effectivePermissions, featureFlagsFor, findUser, seedScenario, type ResolvedSeed } from "./seed.js";
import { DEFAULT_CLIENT_ID, DEFAULT_SCOPES, type KindeTestkit } from "./testkit.js";
import { renderDeviceCodeEntry, renderDeviceConfirm, renderMessage, renderOrganizationPicker, renderSignIn } from "./login-page.js";
import type { AuthenticatedScenario, KindeOrganization, KindeUser } from "./types.js";
import type { Directory } from "./directory.js";

export type UserEventEmitter = (type: "user.created" | "user.authenticated", user: KindeUser) => void;

const CODE_LIFETIME_MS = 10 * 60 * 1000;
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// Kinde uses eight letters, such as CSLDFDUU. Leave out letters that are easy to misread.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export interface DeviceFlowOptions {
  /** Seconds a client must wait between polls. Kinde uses 5. Set 0 in tests that poll in a loop. */
  intervalSeconds?: number;
  /** Seconds before the device code expires. Kinde uses 600. */
  expiresInSeconds?: number;
}

interface PendingDevice {
  deviceCode: string;
  userCode: string;
  clientId: string;
  scope: string[];
  audience: string[];
  expiresAt: number;
  interval: number;
  lastPollAt: number;
  status: "pending" | "approved" | "denied";
  grant: Grant | null;
}

interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
}

interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  state: string | null;
  scope: string[];
  nonce: string | null;
  audience: string[];
  orgCode: string | null;
  loginHint: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: "S256" | "plain" | null;
}

interface Grant {
  clientId: string;
  scenario: AuthenticatedScenario;
  scope: string[];
  audience: string[];
  nonce: string | null;
  authTime: number;
  /** The amr claim. Defaults to ["email"]. */
  authMethods?: string[];
}

interface PendingCode extends Grant {
  redirectUri: string;
  codeChallenge: string | null;
  codeChallengeMethod: "S256" | "plain" | null;
  expiresAt: number;
}

export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    description: string,
  ) {
    super(description);
  }
}

export class AuthorizationServer {
  private readonly codes = new Map<string, PendingCode>();
  private readonly refreshTokens = new Map<string, Grant>();
  private readonly signedUpUsers = new Map<string, KindeUser>();
  private readonly devices = new Map<string, PendingDevice>();
  private readonly registeredClients = new Map<string, RegisteredClient>();

  constructor(
    private readonly testkit: KindeTestkit,
    private readonly seed: ResolvedSeed,
    private readonly emit: UserEventEmitter = () => undefined,
    private readonly directory?: Directory,
    private readonly observe: (id: string) => void = () => undefined,
    private readonly deviceOptions: DeviceFlowOptions = {},
  ) {}

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    readBody: () => Promise<Record<string, string>>,
    readJson: () => Promise<unknown> = async () => ({}),
  ): Promise<boolean> {
    const method = req.method ?? "GET";
    switch (`${method} ${url.pathname}`) {
      case "POST /oauth2/device/auth":
        this.deviceAuthorization(res, await readBody());
        return true;
      case "GET /device":
        this.devicePage(res, url.searchParams);
        return true;
      case "GET /device/sign-in":
        this.deviceSignIn(res, url.searchParams);
        return true;
      case "GET /device/complete":
        this.deviceComplete(res, url.searchParams);
        return true;
      case "POST /device/deny":
        this.deviceDeny(res, await readBody());
        return true;
      case "POST /oauth2/introspect":
        await this.introspect(req, res, await readBody());
        return true;
      case "POST /oauth2/register":
        this.register(res, await readJson());
        return true;
      case "GET /oauth2/auth":
        this.authorize(res, url.searchParams);
        return true;
      case "POST /oauth2/auth/login":
        this.login(res, await readBody());
        return true;
      case "POST /oauth2/token":
        await this.token(req, res, await readBody());
        return true;
      case "GET /oauth2/v2/user_profile":
        await this.profile(req, res);
        return true;
      case "POST /oauth2/revoke":
        this.revoke(res, await readBody());
        return true;
      case "GET /logout":
        this.logout(res, url.searchParams);
        return true;
      default:
        return false;
    }
  }

  private authorize(res: ServerResponse, params: URLSearchParams): void {
    let request: AuthorizeRequest;
    try {
      request = parseAuthorizeRequest(params);
    } catch (error) {
      return sendHtml(res, 400, renderMessage("Sign-in request rejected", (error as Error).message));
    }
    if (params.get("prompt") === "none") {
      this.observe("session.silent");
      return redirectWithError(res, request, "login_required", "kinde-testkit has no signed-in browser session.");
    }
    sendHtml(
      res,
      200,
      renderSignIn({
        request: encodeRequest(request),
        users: this.loginPageUsers(),
        loginHint: request.loginHint ?? undefined,
        requiredOrganization: request.orgCode ?? undefined,
      }),
    );
  }

  private login(res: ServerResponse, form: Record<string, string>): void {
    let request: AuthorizeRequest;
    try {
      request = decodeRequest(form.request ?? "");
    } catch {
      return sendHtml(res, 400, renderMessage("Sign-in request rejected", "The sign-in form is missing its request. Start again from the app."));
    }
    const encoded = encodeRequest(request);
    const connection = (form.connection || "email").trim().toLowerCase();
    const providerResult = form.provider_result || "success";
    const mfa = form.mfa || "none";
    if (!/^[a-z0-9_-]{1,40}$/.test(connection) || !["success", "cancelled", "error"].includes(providerResult) || !["none", "passed", "failed", "cancelled"].includes(mfa)) {
      return sendHtml(res, 400, renderSignIn({ request: encoded, users: this.loginPageUsers(), requiredOrganization: request.orgCode ?? undefined, error: "The test options on the sign-in form are not valid." }));
    }
    if (connection !== "email" && providerResult !== "success") {
      this.observe("session.sign-in-refused");
      return providerResult === "cancelled"
        ? redirectWithError(res, request, "access_denied", `The user cancelled sign-in with ${connection}.`)
        : redirectWithError(res, request, "server_error", `${connection} returned an error during sign-in.`);
    }
    const carry: Record<string, string> = { connection, provider_result: providerResult, mfa };
    const ref = (form.user || form.email || "").trim();
    if (!ref) {
      return sendHtml(res, 400, renderSignIn({ request: encoded, users: this.loginPageUsers(), requiredOrganization: request.orgCode ?? undefined, error: "Enter an email address or pick a seeded user." }));
    }
    const user = this.resolveUser(ref);
    if (!user) {
      return sendHtml(res, 400, renderSignIn({ request: encoded, users: this.loginPageUsers(), requiredOrganization: request.orgCode ?? undefined, error: `"${ref}" is not a valid email address.` }));
    }

    if (this.directory?.isSuspended(user.id)) {
      this.observe("identity.suspended");
      return sendHtml(
        res,
        403,
        renderSignIn({
          request: encoded,
          users: this.loginPageUsers(),
          requiredOrganization: request.orgCode ?? undefined,
          error: `${user.email ?? user.id} is suspended and cannot sign in.`,
        }),
      );
    }
    if (mfa === "failed") {
      this.observe("session.sign-in-refused");
      return sendHtml(
        res,
        401,
        renderSignIn({ request: encoded, users: this.loginPageUsers(), requiredOrganization: request.orgCode ?? undefined, error: "The verification code is not correct." }),
      );
    }
    if (mfa === "cancelled") {
      this.observe("session.sign-in-refused");
      return redirectWithError(res, request, "access_denied", "The user cancelled multi-factor authentication.");
    }
    if (connection !== "email") this.observe("identity.social");
    if (mfa === "passed") this.observe("identity.mfa");
    // Kinde does not document its amr values for social and MFA sign-ins. The testkit uses the
    // connection name and RFC 8176's "mfa".
    const authMethods = [connection, ...(mfa === "passed" ? ["mfa"] : [])];
    const memberships = this.seed.memberships.filter((m) => m.userId === user.id);
    const wanted = request.orgCode ?? form.org ?? null;
    let organizationCode: string | null = null;
    if (wanted) {
      if (!memberships.some((m) => m.organizationCode === wanted)) {
        this.observe("organization.non-member");
        return sendHtml(
          res,
          403,
          renderSignIn({
            request: encoded,
            users: this.loginPageUsers(),
            requiredOrganization: request.orgCode ?? undefined,
            error: `${user.email ?? user.id} is not a member of ${wanted}.`,
          }),
        );
      }
      organizationCode = wanted;
    } else if (memberships.length === 1) {
      organizationCode = memberships[0]!.organizationCode;
    } else if (memberships.length > 1) {
      return sendHtml(
        res,
        200,
        renderOrganizationPicker({
          request: encoded,
          user,
          organizations: memberships
            .map((m) => this.organization(m.organizationCode))
            .filter((org): org is KindeOrganization => org !== null),
          carry,
        }),
      );
    }

    const membership = memberships.find((m) => m.organizationCode === organizationCode);
    const scenario: AuthenticatedScenario = {
      kind: "authenticated",
      user,
      organization: organizationCode ? this.organization(organizationCode) : null,
      roles: [...(membership?.roles ?? [])],
      permissions: effectivePermissions(this.seed, membership),
      claims: {},
    };
    const code = randomToken();
    this.codes.set(code, {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      scenario,
      scope: request.scope,
      audience: request.audience,
      nonce: request.nonce,
      authTime: Math.floor(Date.now() / 1000),
      authMethods,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: request.codeChallengeMethod,
      expiresAt: Date.now() + CODE_LIFETIME_MS,
    });
    this.directory?.recordSignIn(user, organizationCode);
    this.emit("user.authenticated", user);
    const target = new URL(request.redirectUri);
    target.searchParams.set("code", code);
    if (request.state !== null) target.searchParams.set("state", request.state);
    redirect(res, target.toString());
  }

  private async token(req: IncomingMessage, res: ServerResponse, form: Record<string, string>): Promise<void> {
    try {
      const clientId = clientIdFrom(req, form);
      const grantType = form.grant_type;
      if (grantType === "client_credentials") {
        return sendJson(res, 200, await this.clientCredentials(clientId, clientSecretFrom(req, form), form));
      }
      let grant: Grant;
      if (grantType === "authorization_code") {
        grant = this.redeemCode(form, clientId);
        this.observe("session.sign-in");
      } else if (grantType === "refresh_token") {
        grant = this.redeemRefreshToken(form, clientId);
        this.observe("session.refresh");
      } else if (grantType === DEVICE_CODE_GRANT) {
        grant = this.pollDevice(form, clientId);
      } else {
        throw new OAuthError(
          400,
          "unsupported_grant_type",
          `kinde-testkit supports authorization_code, refresh_token, client_credentials and ${DEVICE_CODE_GRANT}, not "${grantType ?? ""}".`,
        );
      }
      sendJson(res, 200, await this.issueTokens(grant));
    } catch (error) {
      if (error instanceof OAuthError) {
        return sendJson(res, error.status, { error: error.error, error_description: error.message });
      }
      throw error;
    }
  }

  private async clientCredentials(
    clientId: string,
    clientSecret: string | null,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const app = this.seed.applications.find((a) => a.clientId === clientId);
    if (app?.clientSecret && app.clientSecret !== clientSecret) {
      throw new OAuthError(401, "invalid_client", `The client secret for ${clientId} is wrong.`);
    }
    const requested = (form.scope ?? "").split(/\s+/).filter(Boolean);
    const granted = app?.scopes
      ? requested.length === 0
        ? [...app.scopes]
        : requested.filter((scope) => app.scopes!.includes(scope))
      : requested;
    const audience = (form.audience ?? "").split(/\s+/).filter(Boolean);
    this.checkAudience(app?.audience ?? null, audience);
    return {
      access_token: await this.testkit.m2mToken({
        clientId,
        organizationCode: app?.organizationCode ?? null,
        scopes: requested,
        grantedScopes: granted,
        audience: audience.length > 0 ? audience : (app?.audience ?? undefined),
        permissions: app?.permissions ?? undefined,
      }),
      expires_in: this.testkit.accessTokenLifetime,
      scope: granted.join(" "),
      token_type: "bearer",
    };
  }

  reset(): void {
    this.codes.clear();
    this.refreshTokens.clear();
    this.signedUpUsers.clear();
    this.devices.clear();
    this.registeredClients.clear();
  }

  /** A seeded application that lists audiences may only ask for those, as in Kinde, where each API must be authorized for the app. */
  private checkAudience(allowed: string[] | null, requested: string[]): void {
    if (!allowed) return;
    const refused = requested.find((audience) => !allowed.includes(audience));
    if (refused) {
      throw new OAuthError(
        400,
        "invalid_request",
        `The request is missing a required parameter, includes an invalid parameter value, includes a parameter more than once, or is otherwise malformed. Requested audience '${refused}' has not been whitelisted by the OAuth 2.0 Client.`,
      );
    }
  }

  private deviceAuthorization(res: ServerResponse, form: Record<string, string>): void {
    try {
      const clientId = form.client_id || DEFAULT_CLIENT_ID;
      const audience = (form.audience ?? "").split(/\s+/).filter(Boolean);
      const app = this.seed.applications.find((a) => a.clientId === clientId);
      this.checkAudience(app?.audience ?? null, audience);
      const interval = this.deviceOptions.intervalSeconds ?? 5;
      const expiresIn = this.deviceOptions.expiresInSeconds ?? 600;
      const device: PendingDevice = {
        deviceCode: `kinde_dc_${randomToken()}`,
        userCode: userCode(),
        clientId,
        scope: (form.scope ?? "").split(/\s+/).filter(Boolean),
        audience,
        expiresAt: Date.now() + expiresIn * 1000,
        interval,
        lastPollAt: 0,
        status: "pending",
        grant: null,
      };
      this.devices.set(device.deviceCode, device);
      this.observe("session.device");
      const verification = `${this.testkit.issuer}/device`;
      sendJson(res, 200, {
        device_code: device.deviceCode,
        user_code: device.userCode,
        verification_uri: verification,
        verification_uri_complete: `${verification}?user_code=${device.userCode}`,
        expires_in: expiresIn,
        interval,
      });
    } catch (error) {
      if (error instanceof OAuthError) return sendJson(res, error.status, { error: error.error, error_description: error.message });
      throw error;
    }
  }

  private findDevice(userCode: string | null | undefined): PendingDevice | null {
    const wanted = (userCode ?? "").toUpperCase().replace(/[^A-Z]/g, "");
    for (const device of this.devices.values()) {
      if (device.userCode === wanted && device.status === "pending" && device.expiresAt > Date.now()) return device;
    }
    return null;
  }

  private devicePage(res: ServerResponse, params: URLSearchParams): void {
    const code = params.get("user_code");
    if (!code) return sendHtml(res, 200, renderDeviceCodeEntry());
    const device = this.findDevice(code);
    if (!device) return sendHtml(res, 400, renderDeviceCodeEntry({ userCode: code, error: "That code is unknown, expired or already used." }));
    sendHtml(res, 200, renderDeviceConfirm({ userCode: device.userCode, clientId: device.clientId }));
  }

  private deviceSignIn(res: ServerResponse, params: URLSearchParams): void {
    const device = this.findDevice(params.get("user_code"));
    if (!device) return sendHtml(res, 400, renderDeviceCodeEntry({ error: "That code is unknown, expired or already used." }));
    const request: AuthorizeRequest = {
      clientId: device.clientId,
      redirectUri: `${this.testkit.issuer}/device/complete?user_code=${device.userCode}`,
      state: null,
      scope: device.scope,
      nonce: null,
      audience: device.audience,
      orgCode: null,
      loginHint: params.get("login_hint"),
      codeChallenge: null,
      codeChallengeMethod: null,
    };
    sendHtml(res, 200, renderSignIn({ request: encodeRequest(request), users: this.loginPageUsers(), loginHint: request.loginHint ?? undefined }));
  }

  private deviceComplete(res: ServerResponse, params: URLSearchParams): void {
    const device = this.findDevice(params.get("user_code"));
    const pending = this.codes.get(params.get("code") ?? "");
    this.codes.delete(params.get("code") ?? "");
    if (!device || !pending || pending.clientId !== device.clientId) {
      return sendHtml(res, 400, renderMessage("Device not connected", "The code expired or was already used. Start again on the device."));
    }
    device.status = "approved";
    device.grant = { ...pending, scope: device.scope, audience: device.audience };
    sendHtml(res, 200, renderMessage("Device connected", "You can go back to your device. It signs in the next time it checks."));
  }

  private deviceDeny(res: ServerResponse, form: Record<string, string>): void {
    const device = this.findDevice(form.user_code);
    if (device) device.status = "denied";
    sendHtml(res, 200, renderMessage("Device denied", "The device will not be signed in."));
  }

  /** Approves or denies a device without a browser. Used by POST /testkit/device. */
  resolveDevice(input: { userCode: string; user?: string; organization?: string | null; deny?: boolean }): void {
    const device = this.findDevice(input.userCode);
    if (!device) throw new OAuthError(400, "invalid_request", `No pending device has the user code "${input.userCode}".`);
    if (input.deny) {
      device.status = "denied";
      return;
    }
    if (!input.user) throw new OAuthError(400, "invalid_request", "Pass the user who approves the device.");
    const scenario = seedScenario(this.seed, { user: input.user, organization: input.organization ?? undefined });
    device.status = "approved";
    device.grant = {
      clientId: device.clientId,
      scenario,
      scope: device.scope,
      audience: device.audience,
      nonce: null,
      authTime: Math.floor(Date.now() / 1000),
    };
  }

  private pollDevice(form: Record<string, string>, clientId: string): Grant {
    const device = this.devices.get(form.device_code ?? "");
    if (!device || device.clientId !== clientId) {
      throw new OAuthError(400, "invalid_grant", "The device code is unknown or was issued to a different client.");
    }
    if (device.expiresAt <= Date.now()) {
      this.devices.delete(device.deviceCode);
      throw new OAuthError(400, "expired_token", "The device code has expired. Request a new one.");
    }
    if (device.status === "denied") {
      this.devices.delete(device.deviceCode);
      throw new OAuthError(400, "access_denied", "The user denied the device.");
    }
    if (device.status === "pending") {
      const now = Date.now();
      const tooSoon = device.lastPollAt > 0 && now - device.lastPollAt < device.interval * 1000;
      device.lastPollAt = now;
      if (tooSoon) {
        device.interval += 5;
        throw new OAuthError(400, "slow_down", `Poll at most every ${device.interval} seconds.`);
      }
      throw new OAuthError(400, "authorization_pending", "The user has not finished signing in.");
    }
    this.devices.delete(device.deviceCode);
    this.observe("session.device-approved");
    return device.grant!;
  }

  private async introspect(req: IncomingMessage, res: ServerResponse, form: Record<string, string>): Promise<void> {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      return sendJson(res, 401, { error: "request_unauthorized", error_description: "The request could not be authorized. HTTP Authorization header missing." });
    }
    const bearer = header.slice(7);
    const token = form.token ?? "";
    if (bearer === token) {
      return sendJson(res, 401, { error: "request_unauthorized", error_description: "The request could not be authorized. Bearer and introspection token are identical." });
    }
    try {
      await this.testkit.verify(bearer);
    } catch {
      return sendJson(res, 401, { error: "request_unauthorized", error_description: "The request could not be authorized. The Bearer token is not valid for this issuer." });
    }
    if (!token) return sendJson(res, 400, { error: "invalid_request", error_description: "Send the token to introspect in the token field." });
    this.observe("token.introspect");
    const refresh = this.refreshTokens.get(token);
    if (refresh) return sendJson(res, 200, { active: true, client_id: refresh.clientId });
    try {
      const claims = await this.testkit.verify(token);
      const aud = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      sendJson(res, 200, { active: true, aud, client_id: claims.azp ?? null, exp: claims.exp, iat: claims.iat });
    } catch {
      sendJson(res, 200, { active: false });
    }
  }

  /** OAuth dynamic client registration (RFC 7591), which Kinde offers for MCP connectors. */
  private register(res: ServerResponse, body: unknown): void {
    const input = (typeof body === "object" && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
    if (redirectUris.length === 0 || !redirectUris.every(isHttpUrl)) {
      return sendJson(res, 400, { error: "invalid_redirect_uri", error_description: "Redirect URI is not allowed for MCP connector registration" });
    }
    const client: RegisteredClient = {
      client_id: randomBytes(16).toString("hex"),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(typeof input.client_name === "string" ? { client_name: input.client_name } : {}),
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
    this.registeredClients.set(client.client_id, client);
    this.observe("session.register");
    sendJson(res, 201, client);
  }

  /** Clients registered through /oauth2/register since the last reset. */
  registrations(): RegisteredClient[] {
    return [...this.registeredClients.values()];
  }

  private redeemCode(form: Record<string, string>, clientId: string): Grant {
    const code = form.code ?? "";
    const pending = this.codes.get(code);
    this.codes.delete(code);
    if (!pending || pending.expiresAt < Date.now()) {
      throw new OAuthError(400, "invalid_grant", "The authorization code is unknown, expired or already used.");
    }
    if (pending.clientId !== clientId) {
      throw new OAuthError(400, "invalid_grant", "The authorization code was issued to a different client.");
    }
    if (form.redirect_uri !== pending.redirectUri) {
      throw new OAuthError(400, "invalid_grant", "redirect_uri does not match the one used to start sign-in.");
    }
    if (pending.codeChallenge) {
      const verifier = form.code_verifier ?? "";
      const expected =
        pending.codeChallengeMethod === "plain"
          ? verifier
          : createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || !safeEqual(expected, pending.codeChallenge)) {
        throw new OAuthError(400, "invalid_grant", "code_verifier does not match the code_challenge.");
      }
    }
    return pending;
  }

  private redeemRefreshToken(form: Record<string, string>, clientId: string): Grant {
    const token = form.refresh_token ?? "";
    const grant = this.refreshTokens.get(token);
    this.refreshTokens.delete(token);
    if (!grant) {
      throw new OAuthError(400, "invalid_grant", "The refresh token is unknown, revoked or already used.");
    }
    if (grant.clientId !== clientId) {
      throw new OAuthError(400, "invalid_grant", "The refresh token was issued to a different client.");
    }
    return grant;
  }

  private async issueTokens(grant: Grant): Promise<Record<string, unknown>> {
    const { scenario } = grant;
    const body: Record<string, unknown> = {
      access_token: await this.testkit.token({
        subject: scenario.user.id,
        organizationCode: scenario.organization?.code ?? null,
        roles: scenario.roles.length > 0 ? scenario.roles : undefined,
        permissions: scenario.permissions.length > 0 ? scenario.permissions : undefined,
        scopes: grant.scope,
        clientId: grant.clientId,
        audience: grant.audience.length > 0 ? grant.audience : undefined,
        authTime: grant.authTime,
        authMethods: grant.authMethods,
        featureFlags: featureFlagsFor(this.seed, scenario.organization?.code ?? null),
      }),
      expires_in: this.testkit.accessTokenLifetime,
      scope: grant.scope.join(" "),
      token_type: "bearer",
    };
    if (grant.scope.includes("openid")) {
      body.id_token = await this.testkit.idTokenFor(scenario, {
        clientId: grant.clientId,
        nonce: grant.nonce ?? undefined,
        authTime: grant.authTime,
        authMethods: grant.authMethods,
      });
    }
    if (grant.scope.includes("offline")) {
      const refreshToken = randomToken();
      this.refreshTokens.set(refreshToken, { ...grant, nonce: null });
      body.refresh_token = refreshToken;
    }
    return body;
  }

  private async profile(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) {
      return sendJson(res, 401, { error: "invalid_token", error_description: "Send the access token as a Bearer token." });
    }
    let sub: string;
    try {
      sub = String((await this.testkit.verify(header.slice(7))).sub ?? "");
    } catch {
      return sendJson(res, 401, { error: "invalid_token", error_description: "The access token is not valid for this issuer." });
    }
    const user = this.seed.users.find((u) => u.id === sub) ?? this.signedUpUsers.get(sub);
    if (!user) {
      return sendJson(res, 404, { error: "not_found", error_description: `No user has the id ${sub}.` });
    }
    const name = [user.givenName, user.familyName].filter(Boolean).join(" ");
    sendJson(res, 200, {
      id: user.id,
      sub: user.id,
      provided_id: null,
      name: name || null,
      given_name: user.givenName,
      family_name: user.familyName,
      updated_at: Math.floor(Date.now() / 1000),
      email: user.email,
      email_verified: user.emailVerified,
      picture: user.picture,
      preferred_username: null,
      phone: null,
    });
  }

  private revoke(res: ServerResponse, form: Record<string, string>): void {
    if (form.token) this.refreshTokens.delete(form.token);
    this.observe("session.revoke");
    sendJson(res, 200, {});
  }

  private logout(res: ServerResponse, params: URLSearchParams): void {
    this.observe("session.sign-out");
    const target = params.get("redirect");
    if (target && isHttpUrl(target)) return redirect(res, target);
    sendHtml(res, 200, renderMessage("Signed out", "You are signed out of kinde-testkit. You can close this tab."));
  }

  private resolveUser(ref: string): KindeUser | null {
    const seeded = findUser(this.seed.users, ref);
    if (seeded) return seeded;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ref)) return null;
    const user = createKindeUser({ email: ref.toLowerCase() });
    if (!this.signedUpUsers.has(user.id)) {
      this.signedUpUsers.set(user.id, user);
      this.observe("identity.unseeded");
      if (this.directory) this.seed.users.push(user);
      this.emit("user.created", user);
    }
    return this.signedUpUsers.get(user.id)!;
  }

  private organization(code: string): KindeOrganization | null {
    return this.seed.organizations.find((org) => org.code === code) ?? null;
  }

  private loginPageUsers() {
    return this.seed.users.map((user) => ({
      user,
      organizations: this.seed.memberships
        .filter((m) => m.userId === user.id)
        .map((m) => this.organization(m.organizationCode))
        .filter((org): org is KindeOrganization => org !== null),
    }));
  }
}

function parseAuthorizeRequest(params: URLSearchParams): AuthorizeRequest {
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId) throw new Error("client_id is missing.");
  if (!redirectUri || !isHttpUrl(redirectUri)) {
    throw new Error("redirect_uri must be an absolute http or https URL.");
  }
  if (params.get("response_type") !== "code") {
    throw new Error('response_type must be "code".');
  }
  const method = params.get("code_challenge_method");
  const challenge = params.get("code_challenge");
  if (challenge && method && method !== "S256" && method !== "plain") {
    throw new Error('code_challenge_method must be "S256" or "plain".');
  }
  return {
    clientId,
    redirectUri,
    state: params.get("state"),
    scope: (params.get("scope") ?? DEFAULT_SCOPES.join(" ")).split(/\s+/).filter(Boolean),
    nonce: params.get("nonce"),
    audience: params.getAll("audience").flatMap((a) => a.split(/\s+/)).filter(Boolean),
    orgCode: params.get("org_code"),
    loginHint: params.get("login_hint"),
    codeChallenge: challenge,
    codeChallengeMethod: challenge ? ((method as "S256" | "plain" | null) ?? "plain") : null,
  };
}

function encodeRequest(request: AuthorizeRequest): string {
  return Buffer.from(JSON.stringify(request)).toString("base64url");
}

function decodeRequest(value: string): AuthorizeRequest {
  const request = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as AuthorizeRequest;
  if (!request.clientId || !request.redirectUri || !isHttpUrl(request.redirectUri)) {
    throw new Error("invalid request");
  }
  return request;
}

function clientIdFrom(req: IncomingMessage, form: Record<string, string>): string {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const id = decodeURIComponent(decoded.split(":")[0] ?? "");
    if (id) return id;
  }
  if (form.client_id) return form.client_id;
  throw new OAuthError(401, "invalid_client", "Send client_id in the body or with HTTP Basic authentication.");
}

function clientSecretFrom(req: IncomingMessage, form: Record<string, string>): string | null {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const index = decoded.indexOf(":");
    if (index >= 0) return decodeURIComponent(decoded.slice(index + 1));
  }
  return form.client_secret ?? null;
}

function redirectWithError(res: ServerResponse, request: AuthorizeRequest, error: string, description: string): void {
  const target = new URL(request.redirectUri);
  target.searchParams.set("error", error);
  target.searchParams.set("error_description", description);
  if (request.state !== null) target.searchParams.set("state", request.state);
  redirect(res, target.toString());
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function userCode(): string {
  return Array.from(randomBytes(8), (byte) => USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]).join("");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http: https:; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(html);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
