import { getKindeServerSession } from "@kinde-oss/kinde-auth-nextjs/server";
import { redirect } from "next/navigation";

const projects: Record<string, string[]> = {
  org_acme: ["Customer portal", "Billing migration"],
  org_globex: ["Data warehouse"],
};

export default async function ProjectsPage() {
  const { isAuthenticated, getOrganization, getPermission } = getKindeServerSession();
  if (!(await isAuthenticated())) redirect("/api/auth/login");

  const orgCode = (await getOrganization())?.orgCode ?? "";
  const canDelete = (await getPermission("projects:delete"))?.isGranted ?? false;

  return (
    <main>
      <h1>{orgCode} projects</h1>
      <ul>
        {(projects[orgCode] ?? []).map((name) => (
          <li key={name}>
            {name} {canDelete && <button type="button">Delete {name}</button>}
          </li>
        ))}
      </ul>
    </main>
  );
}
