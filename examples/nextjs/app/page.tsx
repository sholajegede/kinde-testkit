import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";

export default async function Home() {
  const { isAuthenticated, getUser, getOrganization } = getKindeServerSession();

  if (!(await isAuthenticated())) {
    return (
      <main>
        <h1>Projects</h1>
        <p>You are signed out.</p>
        <a href="/api/auth/login">Sign in</a>
      </main>
    );
  }

  const user = await getUser();
  const organization = await getOrganization();

  return (
    <main>
      <h1>Projects</h1>
      <p data-testid="signed-in-as">Signed in as {user?.email}</p>
      <p data-testid="organization">Organization: {organization?.orgCode ?? "none"}</p>
      <p>
        <a href="/projects">Open projects</a> · <a href="/api/auth/logout">Sign out</a>
      </p>
    </main>
  );
}
