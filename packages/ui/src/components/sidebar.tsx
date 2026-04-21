"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { cn } from "@/lib/cn";
import { NAV_GROUPS } from "@/lib/nav";

/**
 * Desktop: fixed 240px left sidebar with grouped nav.
 * Mobile (<768px): slide-out drawer triggered by hamburger button in TopBar.
 * Click-outside closes the drawer. Navigation click closes too.
 */
export function Sidebar() {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <>
      {/* Mobile hamburger — hidden on desktop. */}
      <button
        type="button"
        onClick={() => setDrawerOpen((v) => !v)}
        className={cn(
          "md:hidden fixed top-3 left-3 z-40 rounded-md border border-border-default bg-bg-1 p-2",
          "text-text-secondary hover:bg-bg-2 active:scale-[0.98] transition-all duration-150",
        )}
        aria-label="Toggle navigation"
        aria-expanded={drawerOpen}
      >
        <HamburgerIcon />
      </button>

      {/* Backdrop for mobile drawer. */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/60"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={cn(
          "fixed md:sticky md:top-0 top-0 left-0 z-30 h-screen w-60 shrink-0",
          "bg-bg-1 border-r border-border-subtle overflow-y-auto",
          "transition-transform duration-200 ease-out-snappy md:translate-x-0",
          drawerOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
        aria-label="Main navigation"
      >
        <div className="px-6 pt-6 pb-4 border-b border-border-subtle">
          <div className="font-mono text-subhead text-accent">HYDRA</div>
          <div className="font-mono text-secondary text-text-tertiary mt-0.5">
            trading bot
          </div>
        </div>

        <nav className="px-3 py-4 space-y-6">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="px-3 mb-2 text-table-dense tracking-wider text-text-tertiary uppercase">
                {group.title}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setDrawerOpen(false)}
                        className={cn(
                          "block px-3 py-2 rounded-md text-default",
                          "transition-colors duration-150",
                          active
                            ? "bg-bg-2 text-text-primary border-l-2 border-accent pl-[10px]"
                            : "text-text-secondary hover:bg-bg-1",
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}

function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  );
}
