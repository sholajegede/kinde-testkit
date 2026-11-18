describe("sign-in with kinde-testkit", () => {
  beforeEach(() => cy.kindeReset());

  it("an admin signs in and can delete projects", () => {
    cy.kindeSignIn("admin@example.test");
    cy.visit("/");
    cy.get('[data-testid="signed-in-as"]').should("have.text", "Signed in as admin@example.test");
    cy.get('[data-testid="organization"]').should("have.text", "Organization: org_acme");
    cy.visit("/projects");
    cy.contains("button", "Delete Customer portal").should("be.visible");
  });

  it("a viewer sees projects but cannot delete them", () => {
    cy.kindeSignIn("viewer@example.test");
    cy.visit("/projects");
    cy.contains("Customer portal").should("be.visible");
    cy.contains("button", /Delete/).should("not.exist");
  });

  it("a user in two organizations sees each organization's projects", () => {
    cy.kindeSignIn("consultant@example.test", { org: "org_acme" });
    cy.visit("/projects");
    cy.contains("h1, h2", "org_acme projects").should("be.visible");
    cy.contains("button", /Delete/).should("not.exist");

    cy.kindeSignIn("consultant@example.test", { org: "org_globex" });
    cy.visit("/projects");
    cy.contains("h1, h2", "org_globex projects").should("be.visible");
    cy.contains("button", "Delete Data warehouse").should("be.visible");
  });

  it("signing out ends the session", () => {
    cy.kindeSignIn("admin@example.test");
    cy.kindeSignOut();
    cy.visit("/");
    cy.contains("You are signed out.").should("be.visible");
  });

  it("sign-in fails cleanly when Kinde's token endpoint is down", () => {
    cy.kindeInjectFailure({ path: "/oauth2/token", status: 503, times: 1 });
    // Open the app first. If the first visit of a test redirects to the testkit, Cypress treats the testkit as the top origin.
    cy.visit("/");
    cy.visit("/api/auth/login?login_hint=admin@example.test");
    cy.origin("http://localhost:4400", () => {
      cy.contains("button", "Continue").click();
    });
    cy.contains("kinde-testkit injected a 503 response.").should("be.visible");

    cy.kindeSignIn("admin@example.test");
    cy.visit("/");
    cy.get('[data-testid="signed-in-as"]').should("have.text", "Signed in as admin@example.test");
  });

  it("signs in as an inline identity with the permissions the test gives it", () => {
    cy.kindeAuthenticateAs({ email: "auditor@example.test", organization: "org_acme", permissions: ["projects:read", "projects:delete"] });
    cy.visit("/projects");
    cy.contains("button", "Delete Customer portal").should("be.visible");
  });

  it("a cancelled Google sign-in leaves the user signed out", () => {
    cy.visit("/");
    cy.kindeSignIn("admin@example.test", { connection: "google", providerResult: "cancelled" });
    cy.visit("/");
    cy.contains("You are signed out.").should("be.visible");
  });
});
