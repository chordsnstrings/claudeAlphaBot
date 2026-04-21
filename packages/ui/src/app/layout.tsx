import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Sidebar } from "@/components/sidebar";

import "./globals.css";

export const metadata: Metadata = {
  title: "Hydra — Trading Bot",
  description: "Hydra crypto perpetual futures bot dashboard",
};

/**
 * Root layout: dark theme only, grouped sidebar on desktop, mobile
 * drawer toggled from the TopBar hamburger. Inter + JetBrains Mono
 * loaded via CSS import in globals.css (link-tag based; subset
 * latin) — avoids the `next/font` runtime to keep CLS at 0.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body className="bg-bg-0 text-text-primary min-h-screen">
        <div className="md:flex">
          <Sidebar />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </body>
    </html>
  );
}
