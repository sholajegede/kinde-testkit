export interface KindeUser {
  id: string;
  email: string | null;
  emailVerified: boolean;
  givenName: string | null;
  familyName: string | null;
  picture: string | null;
  claims: Record<string, unknown>;
}

export interface KindeOrganization {
  code: string;
  name: string;
  metadata: Record<string, unknown>;
}

export interface KindeRole {
  id: string;
  key: string;
  name: string;
}

export interface KindeMembership {
  userId: string;
  organizationCode: string;
  roles: string[];
  permissions: string[];
}

export interface AuthenticatedScenario {
  kind: "authenticated";
  user: KindeUser;
  organization: KindeOrganization | null;
  roles: string[];
  permissions: string[];
  claims: Record<string, unknown>;
}

export interface UnauthenticatedScenario {
  kind: "unauthenticated";
}

export type Scenario = AuthenticatedScenario | UnauthenticatedScenario;

export interface KindePrincipal {
  subject: string;
  issuer: string;
  organization: { code: string } | null;
  roles: string[];
  permissions: string[];
  claims: Record<string, unknown>;
}

export type InvalidTokenKind =
  | "expired"
  | "wrong-issuer"
  | "wrong-audience"
  | "missing-subject"
  | "missing-organization"
  | "missing-permissions"
  | "future-iat"
  | "bad-signature"
  | "unknown-key"
  | "unsigned";

export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

export interface KindeTokenOptions {
  subject?: string;
  organizationCode?: string | null;
  permissions?: string[];
  roles?: Array<string | KindeRole>;
  scopes?: string[];
  featureFlags?: Record<string, { t: "b" | "s" | "i"; v: boolean | string | number }>;
  claims?: Record<string, unknown>;
  expiresIn?: Duration;
  invalid?: InvalidTokenKind;
}
