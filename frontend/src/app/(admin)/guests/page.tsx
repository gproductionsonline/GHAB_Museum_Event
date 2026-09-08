"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useEvent, useAuth } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass, Spinner, StatusBadge } from "@/components/ui";

type GuestRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  category: string;
  status: string;
  source: string;
  organisation: string | null;
  tableSeat: string | null;
  isCompanion: boolean;
  partyOf: string | null;
  companionCount: number;
  credential: { status: string; codeLast4: string; emailedAt: string | null } | null;
  checkIn: { scannedAt: string; gate: string | null; method: string } | null;
};

type ListResponse = { total: number; page: number; pageSize: number; guests: GuestRow[] };

const PAGE_SIZE = 25;

type Category = { id: string; code: string; name: string };

export default function GuestsPage() {
  const { event } = useEvent();
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<GuestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [checkedIn, setCheckedIn] = useState("");
  const [primary, setPrimary] = useState("");
  const [emailed, setEmailed] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);

  useEffect(() => {
    if (!event) return;
    api<{ categories: Category[] }>(`/events/${event.id}/categories`)
      .then((data) => setCategories(data.categories))
      .catch(() => setCategories([]));
  }, [event]);

  const load = useCallback(
    async (p = page) => {
      if (!event) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          eventId: event.id,
          page: String(p),
          pageSize: String(PAGE_SIZE),
        });
        if (q) params.set("q", q);
        if (category) params.set("category", category);
        if (status) params.set("status", status);
        if (checkedIn) params.set("checkedIn", checkedIn);
        if (primary) params.set("primary", primary);
        if (emailed) params.set("emailed", emailed);
        const data = await api<ListResponse>(`/guests?${params.toString()}`);
        setRows(data.guests);
        setTotal(data.total);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : "Could not load guests");
      } finally {
        setLoading(false);
      }
    },
    [event, page, q, category, status, checkedIn, primary, emailed],
  );

  useEffect(() => {
    setPage(1);
  }, [q, category, status, checkedIn, primary, emailed]);

  useEffect(() => {
    const t = setTimeout(() => void load(page), 200);
    return () => clearTimeout(t);
  }, [load, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (!event) return <Spinner label="Loading event…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-bold text-gray-900">
          Guests <span className="text-base font-normal text-gray-400">({total})</span>
        </h1>
        {isAdmin && <Button onClick={() => setShowNew(true)}>+ Add guest manually</Button>}
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          placeholder="Search name, email, phone, organisation…"
          className={`${inputClass} max-w-xs`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className={`${inputClass} w-auto`} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.id} value={c.code}>{c.name}</option>
          ))}
        </select>
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="PENDING">Pending</option>
          <option value="INVITED">Invited</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="DECLINED">Declined</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <select className={`${inputClass} w-auto`} value={checkedIn} onChange={(e) => setCheckedIn(e.target.value)}>
          <option value="">Attendance: any</option>
          <option value="yes">Checked in</option>
          <option value="no">Not checked in</option>
        </select>
        <select className={`${inputClass} w-auto`} value={primary} onChange={(e) => setPrimary(e.target.value)}>
          <option value="">Primary &amp; accompanying</option>
          <option value="yes">Primary only</option>
          <option value="no">Accompanying only</option>
        </select>
        <select className={`${inputClass} w-auto`} value={emailed} onChange={(e) => setEmailed(e.target.value)}>
          <option value="">Email: any</option>
          <option value="yes">Credential emailed</option>
          <option value="no">Not emailed yet</option>
        </select>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="px-3 py-2">Guest</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Credential</th>
                <th className="px-3 py-2">Emailed</th>
                <th className="px-3 py-2">Checked in</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-b border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2">
                    <Link href={`/guests/${g.id}`} className="font-medium text-[#0f2a4a] hover:underline">
                      {g.name}
                    </Link>
                    {g.isCompanion && g.partyOf && (
                      <p className="text-xs text-gray-400">accompanying {g.partyOf}</p>
                    )}
                    {!g.isCompanion && g.companionCount > 0 && (
                      <p className="text-xs text-gray-400">+{g.companionCount} accompanying</p>
                    )}
                    {g.organisation && <p className="text-xs text-gray-400">{g.organisation}</p>}
                  </td>
                  <td className="px-3 py-2"><Badge tone="blue">{g.category.replace(/_/g, " ")}</Badge></td>
                  <td className="px-3 py-2">
                    {g.credential ? <StatusBadge status={g.credential.status} /> : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {g.credential?.emailedAt
                      ? new Date(g.credential.emailedAt).toLocaleDateString()
                      : g.email ? <span className="text-amber-600">pending</span> : <span className="text-gray-300">no email</span>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {g.checkIn ? (
                      <span className="font-medium text-emerald-700">
                        {new Date(g.checkIn.scannedAt).toLocaleTimeString()} · {g.checkIn.gate ?? ""}
                      </span>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={g.status} /></td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                  No guests match. Import a guest list or add guests manually.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-sm">
          <span className="text-gray-500">
            {loading ? "Loading…" : `${total} guest${total === 1 ? "" : "s"}`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</Button>
            <span className="text-gray-500">Page {page} / {pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next →</Button>
          </div>
        </div>
      </Card>

      {showNew && <NewGuestDialog eventId={event.id} categories={categories} onClose={() => setShowNew(false)} onCreated={() => void load(page)} />}
    </div>
  );
}

function NewGuestDialog({
  eventId,
  categories,
  onClose,
  onCreated,
}: {
  eventId: string;
  categories: Category[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    title: "", firstName: "", lastName: "", email: "", phone: "",
    organisation: "", designation: "", category: categories[0]?.code ?? "GENERAL_GUEST", tableSeat: "", notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm({ ...form, [key]: e.target.value });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/guests", {
        method: "POST",
        body: {
          eventId,
          title: form.title || null,
          firstName: form.firstName,
          lastName: form.lastName,
          email: form.email || null,
          phone: form.phone || null,
          organisation: form.organisation || null,
          designation: form.designation || null,
          category: form.category,
          tableSeat: form.tableSeat || null,
          notes: form.notes || null,
        },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not create guest");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 font-serif text-xl font-bold">Add guest manually</h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Title"><input className={inputClass} value={form.title} onChange={set("title")} placeholder="Hon., Dr." /></Field>
          <Field label="Category">
            <select className={inputClass} value={form.category} onChange={set("category")}>
              {categories.map((c) => (
                <option key={c.id} value={c.code}>{c.name}</option>
              ))}
            </select>
          </Field>
          <Field label="First name"><input required className={inputClass} value={form.firstName} onChange={set("firstName")} /></Field>
          <Field label="Last name"><input required className={inputClass} value={form.lastName} onChange={set("lastName")} /></Field>
          <Field label="Email"><input type="email" className={inputClass} value={form.email} onChange={set("email")} /></Field>
          <Field label="Phone"><input className={inputClass} value={form.phone} onChange={set("phone")} /></Field>
          <Field label="Organisation"><input className={inputClass} value={form.organisation} onChange={set("organisation")} /></Field>
          <Field label="Designation"><input className={inputClass} value={form.designation} onChange={set("designation")} /></Field>
          <Field label="Table / seat"><input className={inputClass} value={form.tableSeat} onChange={set("tableSeat")} /></Field>
          <div className="sm:col-span-2">
            <Field label="Notes"><textarea rows={2} className={inputClass} value={form.notes} onChange={set("notes")} /></Field>
          </div>
          {error && <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Add guest"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
