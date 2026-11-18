import { KindeContext, type KindeContextProps } from "@kinde-oss/kinde-auth-react";
import {
  getClaim,
  getClaims,
  getCurrentOrganization,
  getFlag,
  getPermission,
  getPermissions,
  getRoles,
  getUserOrganizations,
  getUserProfile,
  MemoryStorage,
  setActiveStorage,
  StorageKeys,
} from "@kinde/js-utils";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement, type Context, type ReactNode } from "react";
import { getDefaultTestkit, type KindeTestkit, type ScenarioTokenOverrides } from "./testkit.js";
import type { Scenario } from "./types.js";

export interface KindeTestAuthOptions {
  /** Signs the tokens. Defaults to the shared testkit whose issuer is http://localhost:4400. */
  testkit?: KindeTestkit;
  /** Feature flags in the access token, such as { new_editor: true }. */
  featureFlags?: Record<string, boolean | string | number>;
  /** Other token settings, the same as kindeTest() and tokenFor(). */
  token?: ScenarioTokenOverrides;
}

/** A call your component made to a Kinde action, such as login() or logout(). */
export interface KindeTestAuthCall {
  method: "login" | "register" | "logout" | "switchOrg" | "refreshToken" | "generatePortalUrl";
  args: unknown[];
}

export interface KindeTestAuth {
  /** Pass to React Testing Library: render(<App />, { wrapper: auth.wrapper }). */
  wrapper: (props: { children?: ReactNode }) => ReactNode;
  /** The value the wrapper gives KindeContext. */
  value: KindeContextProps;
  /** Every login(), logout(), register() and switchOrg() call, in order. */
  calls: KindeTestAuthCall[];
  accessToken: string | null;
  idToken: string | null;
}

let contextsPromise: Promise<Array<Context<KindeContextProps | null>>> | null = null;

/**
 * The KindeContext objects the installed SDKs read. @kinde-oss/kinde-auth-nextjs pins its own
 * version of @kinde-oss/kinde-auth-react, so a project can have two copies, each with its own context.
 */
function kindeContexts(): Promise<Array<Context<KindeContextProps | null>>> {
  contextsPromise ??= (async () => {
    const contexts = [KindeContext];
    try {
      const require = createRequire(import.meta.url);
      let dir = dirname(require.resolve("@kinde-oss/kinde-auth-nextjs"));
      while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
      const nested = join(dir, "node_modules", "@kinde-oss", "kinde-auth-react", "dist", "index.mjs");
      if (existsSync(nested)) {
        const module = (await import(pathToFileURL(nested).href)) as { KindeContext: Context<KindeContextProps | null> };
        if (module.KindeContext !== KindeContext) contexts.push(module.KindeContext);
      }
    } catch {
      // The Next.js SDK is not installed.
    }
    return contexts;
  })();
  return contextsPromise;
}

function flagClaims(flags: Record<string, boolean | string | number> | undefined) {
  if (!flags) return undefined;
  return Object.fromEntries(
    Object.entries(flags).map(([key, v]) => [key, { t: typeof v === "boolean" ? "b" : typeof v === "number" ? "i" : "s", v }]),
  ) as Record<string, { t: "b" | "s" | "i"; v: boolean | string | number }>;
}

/**
 * Builds Kinde auth state for components under test. Components that call useKindeAuth() from
 * @kinde-oss/kinde-auth-react or useKindeBrowserClient() from @kinde-oss/kinde-auth-nextjs read
 * real tokens signed for the scenario, through the same @kinde/js-utils functions the SDKs use.
 */
export async function kindeAuth(scenario: Scenario, options: KindeTestAuthOptions = {}): Promise<KindeTestAuth> {
  const testkit = options.testkit ?? (await getDefaultTestkit());
  const accessToken = await testkit.tokenFor(scenario, { ...options.token, featureFlags: flagClaims(options.featureFlags) ?? options.token?.featureFlags });
  const idToken = await testkit.idTokenFor(scenario);
  const storage = new MemoryStorage();
  if (accessToken) await storage.setSessionItem(StorageKeys.accessToken, accessToken);
  if (idToken) await storage.setSessionItem(StorageKeys.idToken, idToken);

  // @kinde/js-utils reads one active storage, so each call points it at this scenario's tokens first.
  const withStorage =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      setActiveStorage(storage);
      return fn(...args);
    };
  const calls: KindeTestAuthCall[] = [];
  const record =
    (method: KindeTestAuthCall["method"]) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
    };

  const authenticated = scenario.kind === "authenticated";
  const user = authenticated ? await withStorage(getUserProfile)() : null;
  const value = {
    isAuthenticated: authenticated,
    isLoading: false,
    user: user ?? undefined,
    error: undefined,
    login: record("login"),
    register: record("register"),
    logout: record("logout"),
    switchOrg: record("switchOrg"),
    refreshToken: async (...args: unknown[]) => {
      calls.push({ method: "refreshToken", args });
      return { success: true, accessToken: accessToken ?? undefined, idToken: idToken ?? undefined };
    },
    generatePortalUrl: async (...args: unknown[]) => {
      calls.push({ method: "generatePortalUrl", args });
      return { url: new URL(`${testkit.issuer}/testkit/portal`) };
    },
    getToken: async () => accessToken ?? undefined,
    getAccessToken: async () => accessToken ?? undefined,
    getIdToken: async () => idToken ?? undefined,
    getClaims: withStorage(getClaims),
    getClaim: withStorage(getClaim),
    getOrganization: withStorage(getCurrentOrganization),
    getCurrentOrganization: withStorage(getCurrentOrganization),
    getFlag: withStorage(getFlag),
    getUserProfile: withStorage(getUserProfile),
    getPermission: withStorage(getPermission),
    getPermissions: withStorage(getPermissions),
    getUserOrganizations: withStorage(getUserOrganizations),
    getRoles: withStorage(getRoles),
  } as unknown as KindeContextProps;

  const contexts = await kindeContexts();
  const wrapper = ({ children }: { children?: ReactNode }) =>
    contexts.reduce<ReactNode>((inner, context) => createElement(context.Provider, { value }, inner), children ?? null);
  return { wrapper, value, calls, accessToken, idToken };
}

/** Wraps children in Kinde auth state built by kindeAuth(). */
export function KindeTestProvider({ auth, children }: { auth: KindeTestAuth; children?: ReactNode }) {
  return auth.wrapper({ children });
}
