"use client";

import type { ReactNode } from "react";

export function Card({
  title,
  children,
  actions,
  className = "",
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-gray-200 bg-white shadow-sm ${className}`}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          {title && <h2 className="text-sm font-semibold tracking-wide text-gray-700 uppercase">{title}</h2>}
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "gold";
  size?: "sm" | "md";
};

export function Button({ variant = "primary", size = "md", className = "", ...props }: ButtonProps) {
  const styles: Record<string, string> = {
    primary: "bg-[#0f2a4a] text-white hover:bg-[#163a63] disabled:bg-gray-300",
    secondary:
      "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:text-gray-400",
    danger: "bg-red-700 text-white hover:bg-red-800 disabled:bg-gray-300",
    gold: "bg-[#d4af37] text-[#0f2a4a] hover:bg-[#c9a52e] disabled:bg-gray-300",
  };
  const sizes = { sm: "px-2.5 py-1 text-xs", md: "px-4 py-2 text-sm" };
  return (
    <button
      className={`rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold tracking-wide text-gray-600 uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-gray-400">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-[#0f2a4a] focus:ring-2 focus:ring-[#0f2a4a]/20 focus:outline-none";

export function Badge({
  children,
  tone = "gray",
}: {
  children: ReactNode;
  tone?: "gray" | "green" | "red" | "amber" | "blue" | "gold";
}) {
  const tones: Record<string, string> = {
    gray: "bg-gray-100 text-gray-700",
    green: "bg-emerald-100 text-emerald-800",
    red: "bg-red-100 text-red-700",
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-blue-100 text-blue-800",
    gold: "bg-[#d4af37]/20 text-[#8a711a]",
  };
  return (
    <span
      className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, "green" | "red" | "amber" | "gray" | "blue"> = {
    CONFIRMED: "green",
    ACTIVE: "green",
    CHECKED_IN: "green",
    COMPLETED: "green",
    CANCELLED: "red",
    REVOKED: "red",
    DECLINED: "red",
    REPLACED: "amber",
    PENDING: "amber",
    PREVIEW: "blue",
  };
  return <Badge tone={map[status] ?? "gray"}>{status.replace(/_/g, " ")}</Badge>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <span className="inline-block size-4 animate-spin rounded-full border-2 border-gray-300 border-t-[#0f2a4a]" />
      {label}
    </div>
  );
}
