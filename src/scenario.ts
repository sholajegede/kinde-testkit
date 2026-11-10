import type {
  AuthenticatedScenario,
  KindeOrganization,
  KindeUser,
  Scenario,
  UnauthenticatedScenario,
} from "./types.js";
import {
  createKindeOrganization,
  createKindeUser,
  type CreateKindeOrganizationOptions,
  type CreateKindeUserOptions,
} from "./factories.js";

export class ScenarioBuilder {
  private userValue: KindeUser | null = null;
  private organizationValue: KindeOrganization | null = null;
  private rolesValue: string[] = [];
  private permissionsValue: string[] = [];
  private claimsValue: Record<string, unknown> = {};

  user(user: CreateKindeUserOptions | KindeUser = {}): this {
    this.userValue = createKindeUser(user);
    return this;
  }

  organization(organization: string | CreateKindeOrganizationOptions | KindeOrganization): this {
    this.organizationValue = createKindeOrganization(
      typeof organization === "string" ? { code: organization } : organization,
    );
    return this;
  }

  withoutOrganization(): this {
    this.organizationValue = null;
    return this;
  }

  role(...roles: string[]): this {
    return this.roles(roles);
  }

  roles(roles: string[]): this {
    this.rolesValue = [...new Set([...this.rolesValue, ...roles])];
    return this;
  }

  permissions(permissions: string[]): this {
    this.permissionsValue = [...new Set([...this.permissionsValue, ...permissions])];
    return this;
  }

  claims(claims: Record<string, unknown>): this {
    this.claimsValue = { ...this.claimsValue, ...claims };
    return this;
  }

  authenticated(): AuthenticatedScenario {
    return {
      kind: "authenticated",
      user: this.userValue ?? createKindeUser(),
      organization: this.organizationValue,
      roles: [...this.rolesValue],
      permissions: [...this.permissionsValue],
      claims: { ...this.claimsValue },
    };
  }

  unauthenticated(): UnauthenticatedScenario {
    return { kind: "unauthenticated" };
  }
}

export function scenario(): ScenarioBuilder {
  return new ScenarioBuilder();
}

export function isAuthenticated(value: Scenario): value is AuthenticatedScenario {
  return value.kind === "authenticated";
}
