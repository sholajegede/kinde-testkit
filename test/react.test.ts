// @vitest-environment jsdom
import { useKindeAuth } from "@kinde-oss/kinde-auth-react";
import { useKindeBrowserClient } from "@kinde-oss/kinde-auth-nextjs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement as h, useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { scenario } from "../src/index.js";
import { kindeAuth } from "../src/react.js";

afterEach(cleanup);

const admin = scenario()
  .user({ email: "admin@example.test", givenName: "Ada", familyName: "Okafor" })
  .organization("org_acme")
  .role("admin")
  .permissions(["projects:read", "projects:delete"])
  .authenticated();
const viewer = scenario().user({ email: "viewer@example.test" }).organization("org_acme").permissions(["projects:read"]).authenticated();

// A component written against @kinde-oss/kinde-auth-react.
function Projects() {
  const { isAuthenticated, user, getPermission, getFlag, login, logout } = useKindeAuth();
  const [canDelete, setCanDelete] = useState<boolean | null>(null);
  const [editor, setEditor] = useState<unknown>(null);
  useEffect(() => {
    if (!isAuthenticated) return;
    void getPermission("projects:delete").then((p) => setCanDelete(p.isGranted));
    void getFlag("new_editor").then(setEditor);
  }, [isAuthenticated, getPermission, getFlag]);
  if (!isAuthenticated) return h("button", { onClick: () => login() }, "Sign in");
  return h(
    "div",
    null,
    h("p", null, `Hello ${user?.givenName ?? user?.email}`),
    canDelete === null ? null : h("p", null, canDelete ? "Can delete" : "Read only"),
    editor === true ? h("p", null, "New editor") : null,
    h("button", { onClick: () => logout() }, "Sign out"),
  );
}

// A component written against the Next.js SDK's client hook.
function NextHeader() {
  const { isAuthenticated, user, getPermission, getOrganization } = useKindeBrowserClient();
  if (!isAuthenticated) return h("p", null, "Signed out");
  return h("p", null, `${user?.email} in ${getOrganization()?.orgCode}, delete: ${String(getPermission("projects:delete")?.isGranted)}`);
}

describe("kinde-testkit/react", () => {
  it("renders useKindeAuth() components with the scenario's permissions", async () => {
    const auth = await kindeAuth(admin);
    render(h(Projects), { wrapper: auth.wrapper });
    expect(screen.getByText("Hello Ada")).toBeTruthy();
    await screen.findByText("Can delete");

    const viewerAuth = await kindeAuth(viewer);
    cleanup();
    render(h(Projects), { wrapper: viewerAuth.wrapper });
    await screen.findByText("Read only");
  });

  it("reads feature flags from the token", async () => {
    const auth = await kindeAuth(admin, { featureFlags: { new_editor: true } });
    render(h(Projects), { wrapper: auth.wrapper });
    await screen.findByText("New editor");
  });

  it("records login and logout calls", async () => {
    const signedOut = await kindeAuth(scenario().unauthenticated());
    render(h(Projects), { wrapper: signedOut.wrapper });
    fireEvent.click(screen.getByText("Sign in"));
    await waitFor(() => expect(signedOut.calls).toEqual([{ method: "login", args: [] }]));

    cleanup();
    const auth = await kindeAuth(admin);
    render(h(Projects), { wrapper: auth.wrapper });
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(auth.calls.map((c) => c.method)).toEqual(["logout"]));
  });

  it("renders useKindeBrowserClient() components from the Next.js SDK", async () => {
    const auth = await kindeAuth(viewer);
    render(h(NextHeader), { wrapper: auth.wrapper });
    await screen.findByText("viewer@example.test in org_acme, delete: false");
    cleanup();
    render(h(NextHeader), { wrapper: (await kindeAuth(admin)).wrapper });
    await screen.findByText("admin@example.test in org_acme, delete: true");
  });
});
