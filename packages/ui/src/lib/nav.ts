/**
 * Sidebar navigation structure per Phase 15 spec. Four groups, 11 pages.
 * The order here is the render order; do not reshuffle without spec consent.
 */
export interface NavItem {
  readonly label: string;
  readonly href: string;
}

export interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    title: "OVERVIEW",
    items: [
      { label: "Dashboard", href: "/dashboard" },
      { label: "Live Activity", href: "/activity" },
    ],
  },
  {
    title: "TRADING",
    items: [
      { label: "Open Positions", href: "/positions" },
      { label: "Trade History", href: "/trades" },
      { label: "Performance", href: "/performance" },
      { label: "Strategies", href: "/strategies" },
    ],
  },
  {
    title: "SYSTEM",
    items: [
      { label: "Regime Monitor", href: "/regime" },
      { label: "Validation", href: "/validation" },
      { label: "Circuit Breakers", href: "/breakers" },
    ],
  },
  {
    title: "CONTROLS",
    items: [
      { label: "Commands", href: "/commands" },
      { label: "Settings", href: "/settings" },
    ],
  },
];
