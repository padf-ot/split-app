import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Split — Expense calculator",
  description: "Split shared expenses and settle up with fewer payments.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
