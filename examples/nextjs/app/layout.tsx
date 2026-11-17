import type { ReactNode } from "react";

export const metadata = { title: "kinde-testkit example" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "48px auto", padding: "0 24px" }}>
        {children}
      </body>
    </html>
  );
}
