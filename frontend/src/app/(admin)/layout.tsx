"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getUser } from "@/lib/api";
import { useAuth, useEvent, type Event } from "@/lib/auth";

type NavItem = { href: string; label: string; adminOnly?: boolean };

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/guests", label: "Guests" },
  { href: "/import", label: "Import", adminOnly: true },
  { href: "/reports", label: "Reports" },
  { href: "/email", label: "Email" },
  { href: "/audit", label: "Audit" },
  { href: "/events", label: "Events", adminOnly: true },
  { href: "/devices", label: "Devices", adminOnly: true },
  { href: "/users", label: "Users", adminOnly: true },
];

function EventPicker({
  events,
  event,
  onChange,
}: {
  events: Event[];
  event: Event | null;
  onChange: (id: string) => void;
}) {
  if (!event) return null;
  return (
    <select
      value={event.id}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-sm text-white focus:outline-none"
      aria-label="Active event"
    >
      {events.map((e) => (
        <option key={e.id} value={e.id} className="text-gray-900">
          {e.name}
        </option>
      ))}
    </select>
  );
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, ready, logout, isAdmin } = useAuth();
  const { events, event, setEventId } = useEvent();
  const pathname = usePathname();
  const router = useRouter();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const stored = getUser();
    if (!stored) {
      router.replace("/login");
    } else if (stored.role === "CHECKIN_OPERATOR") {
      router.replace("/scanner");
    }
    setChecked(true);
  }, [ready, router]);

  if (!checked || !user || user.role === "CHECKIN_OPERATOR") {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-gray-500">Loading…</p>
      </main>
    );
  }

  const items = NAV.filter((item) => !item.adminOnly || isAdmin);

  return (
    <div className="min-h-screen">
      <header className="no-select sticky top-0 z-40 bg-[#0f2a4a] text-white shadow-md">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/dashboard" className="flex items-baseline gap-2">
            <span className="text-xs font-semibold tracking-[0.3em] text-[#d4af37] uppercase">
              Government House
            </span>
          </Link>
          <nav className="flex flex-wrap items-center gap-1">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  pathname.startsWith(item.href)
                    ? "bg-white/15 text-white"
                    : "text-blue-100 hover:bg-white/10"
                }`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <EventPicker events={events} event={event} onChange={setEventId} />
            <Link
              href="/scanner"
              className="rounded-lg bg-[#d4af37] px-3 py-1.5 text-sm font-semibold text-[#0f2a4a] hover:bg-[#c9a52e]"
            >
              Scanner
            </Link>
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="text-xs text-blue-200">{user.role}</p>
            </div>
            <button
              onClick={logout}
              className="rounded-lg border border-white/20 px-3 py-1.5 text-sm text-blue-100 hover:bg-white/10"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>

      <footer className="mx-auto max-w-7xl px-4 pb-6 text-xs text-gray-400">
        Phase 1 — Guest & entry management. Payments (Phase 2) will be enabled once
        the local bank account is ready.
      </footer>
    </div>
  );
}
