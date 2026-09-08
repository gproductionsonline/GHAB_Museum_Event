"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useAuth, useEvent } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass, Spinner, StatusBadge } from "@/components/ui";

type Gate = { id: string; name: string; code: string; active: boolean; sort: number };
type Category = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  active: boolean;
  sort: number;
};
type EventRow = {
  id: string;
  name: string;
  slug: string | null;
  startsAt: string;
  endsAt: string | null;
  venue: string | null;
  timezone: string;
  status: string;
  gates: Gate[];
  categories: Category[];
  _count?: { guests: number; checkIns: number };
};

const STATUSES = ["DRAFT", "SCHEDULED", "LIVE", "COMPLETED", "CANCELLED"];
const TIMEZONES = [
  "UTC",
  "America/Antigua",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Asia/Dubai",
];

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function EventsPage() {
  const { event: activeEvent, refresh } = useEvent();
  const { isAdmin } = useAuth();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EventRow | "new" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ events: EventRow[] }>("/events");
      setEvents(data.events);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load events");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saved() {
    setEditing(null);
    await load();
    await refresh();
  }

  if (!isAdmin) {
    return (
      <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Event management requires an administrator account.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold text-gray-900">Events</h1>
          <p className="text-sm text-gray-500">
            Event configuration, gates and guest categories.
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>+ New event</Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {loading && <Spinner label="Loading events…" />}

      {!loading && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">Event</th>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Gates</th>
                  <th className="px-3 py-2">Guests</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <p className="font-medium text-[#0f2a4a]">{e.name}</p>
                      <p className="text-xs text-gray-400">
                        {e.venue ?? "—"} · {e.timezone}
                      </p>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {new Date(e.startsAt).toLocaleString()}
                      {e.endsAt && ` → ${new Date(e.endsAt).toLocaleTimeString()}`}
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={e.status} /></td>
                    <td className="px-3 py-2 text-xs">
                      {e.gates.length ? e.gates.map((g) => g.name).join(", ") : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {e._count?.guests ?? 0} guests · {e._count?.checkIns ?? 0} check-ins
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(e)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
                {events.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                      No events yet. Create the first event.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {activeEvent && (
        <CategoryManager
          key={activeEvent.id}
          eventId={activeEvent.id}
          onCategoriesChanged={load}
        />
      )}

      {editing && (
        <EventDialog
          event={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Event create / edit dialog (including gate management).
// ---------------------------------------------------------------------------

function EventDialog({
  event,
  onClose,
  onSaved,
}: {
  event: EventRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: event?.name ?? "",
    slug: event?.slug ?? "",
    startsAt: toLocalInput(event?.startsAt ?? null),
    endsAt: toLocalInput(event?.endsAt ?? null),
    venue: event?.venue ?? "",
    timezone: event?.timezone ?? "UTC",
    status: event?.status ?? "SCHEDULED",
  });
  const [gates, setGates] = useState<string[]>(
    event?.gates.length ? event.gates.map((g) => g.name) : ["Main Entrance"],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setGate(i: number, value: string) {
    setGates(gates.map((g, idx) => (idx === i ? value : g)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        ...(form.slug ? { slug: form.slug } : {}),
        startsAt: new Date(form.startsAt).toISOString(),
        ...(form.endsAt ? { endsAt: new Date(form.endsAt).toISOString() } : {}),
        ...(form.venue ? { venue: form.venue } : {}),
        timezone: form.timezone,
        status: form.status,
        gates: gates.filter((g) => g.trim()).map((g, i) => ({ name: g.trim(), sort: i })),
      };
      if (event) {
        await api(`/events/${event.id}`, { method: "PATCH", body });
      } else {
        await api("/events", { method: "POST", body });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not save event");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 font-serif text-xl font-bold">
          {event ? `Edit — ${event.name}` : "New event"}
        </h2>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Event name">
              <input required className={inputClass} value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
          </div>
          <Field label="URL slug (optional)">
            <input className={inputClass} value={form.slug} placeholder="chogm-reception"
              onChange={(e) => setForm({ ...form, slug: e.target.value })} />
          </Field>
          <Field label="Venue">
            <input className={inputClass} value={form.venue} placeholder="Government House"
              onChange={(e) => setForm({ ...form, venue: e.target.value })} />
          </Field>
          <Field label="Starts at">
            <input required type="datetime-local" className={inputClass} value={form.startsAt}
              onChange={(e) => setForm({ ...form, startsAt: e.target.value })} />
          </Field>
          <Field label="Ends at (optional)">
            <input type="datetime-local" className={inputClass} value={form.endsAt}
              onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </Field>
          <Field label="Timezone">
            <select className={inputClass} value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              {!TIMEZONES.includes(form.timezone) && (
                <option value={form.timezone}>{form.timezone}</option>
              )}
            </select>
          </Field>
          <Field label="Status">
            <select className={inputClass} value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>

          <div className="sm:col-span-2">
            <p className="mb-1 text-xs font-semibold tracking-gray-600 uppercase text-gray-600">Gates / entrances</p>
            {gates.map((g, i) => (
              <div key={i} className="mb-2 flex items-center gap-2">
                <input className={inputClass} value={g} placeholder="Gate name"
                  onChange={(e) => setGate(i, e.target.value)} />
                <Button type="button" size="sm" variant="danger"
                  onClick={() => setGates(gates.length > 1 ? gates.filter((_, idx) => idx !== i) : gates)}>
                  Remove
                </Button>
              </div>
            ))}
            <Button type="button" size="sm" variant="secondary" onClick={() => setGates([...gates, ""])}>
              + Add gate
            </Button>
            {event && (
              <p className="mt-2 text-xs text-amber-700">
                Saving replaces the gate list. Past check-in records keep their historical gate names.
              </p>
            )}
          </div>

          {error && <p className="sm:col-span-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="sm:col-span-2 flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : event ? "Save changes" : "Create event"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category management for the active event (database-driven, admin-managed).
// ---------------------------------------------------------------------------

function CategoryManager({
  eventId,
  onCategoriesChanged,
}: {
  eventId: string;
  onCategoriesChanged: () => Promise<void>;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingCat, setEditingCat] = useState<Category | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ categories: Category[] }>(
        `/events/${eventId}/categories${showAll ? "?includeInactive=1" : ""}`,
      );
      setCategories(data.categories);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load categories");
    }
  }, [eventId, showAll]);

  useEffect(() => {
    void load();
  }, [load]);

  async function deactivate(cat: Category) {
    if (!window.confirm(`Deactivate "${cat.name}"? Guests already assigned keep it as their historical category.`)) return;
    setError(null);
    try {
      const res = await api<{ assignedGuests?: number }>(
        `/events/${eventId}/categories/${cat.id}`,
        { method: "PATCH", body: { active: false } },
      );
      setNotice(
        typeof res.assignedGuests === "number" && res.assignedGuests > 0
          ? `Deactivated — ${res.assignedGuests} guests keep this category historically.`
          : "Category deactivated.",
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not deactivate");
    }
  }

  const visible = showAll ? categories : categories;

  return (
    <Card
      title="Guest categories (this event)"
      actions={
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Hide inactive" : "Show inactive"}
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>+ New category</Button>
        </div>
      }
    >
      {notice && <p className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">{notice}</p>}
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
              <th className="py-2">Code</th>
              <th className="py-2">Name</th>
              <th className="py-2">Description</th>
              <th className="py-2">Sort</th>
              <th className="py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((c) => (
              <tr key={c.id} className={`border-b border-gray-50 ${c.active ? "" : "opacity-50"}`}>
                <td className="py-2"><Badge tone="blue">{c.code}</Badge></td>
                <td className="py-2 font-medium">{c.name}</td>
                <td className="py-2 text-xs text-gray-500">{c.description ?? "—"}</td>
                <td className="py-2 font-mono text-xs">{c.sort}</td>
                <td className="py-2 text-right">
                  <span className="flex justify-end gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEditingCat(c)}>Edit</Button>
                    {c.active && (
                      <Button size="sm" variant="danger" onClick={() => void deactivate(c)}>Deactivate</Button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr><td colSpan={5} className="py-6 text-center text-gray-400">No categories.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-gray-400">
        Categories are database-driven per event — guests must reference an active category.
      </p>

      {creating && (
        <CategoryDialog
          eventId={eventId}
          category={null}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await load();
            await onCategoriesChanged();
          }}
        />
      )}
      {editingCat && (
        <CategoryDialog
          eventId={eventId}
          category={editingCat}
          onClose={() => setEditingCat(null)}
          onSaved={async () => {
            setEditingCat(null);
            await load();
            await onCategoriesChanged();
          }}
        />
      )}
    </Card>
  );
}

function CategoryDialog({
  eventId,
  category,
  onClose,
  onSaved,
}: {
  eventId: string;
  category: Category | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    code: category?.code ?? "",
    name: category?.name ?? "",
    description: category?.description ?? "",
    sort: String(category?.sort ?? 100),
    active: category?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (category) {
        await api(`/events/${eventId}/categories/${category.id}`, {
          method: "PATCH",
          body: {
            name: form.name,
            description: form.description || null,
            sort: Number(form.sort),
            active: form.active,
          },
        });
      } else {
        await api(`/events/${eventId}/categories`, {
          method: "POST",
          body: {
            code: form.code,
            name: form.name,
            description: form.description || null,
            sort: Number(form.sort),
          },
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not save category");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 font-serif text-xl font-bold">
          {category ? `Edit — ${category.name}` : "New category"}
        </h2>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Code (e.g. VIP, MEDIA)">
            <input required disabled={Boolean(category)} className={`${inputClass} disabled:bg-gray-100`}
              value={form.code} placeholder="VIP"
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Display name">
            <input required className={inputClass} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description (optional)">
            <input className={inputClass} value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Sort order">
            <input type="number" min={0} max={999} className={inputClass} value={form.sort}
              onChange={(e) => setForm({ ...form, sort: e.target.value })} />
          </Field>
          {category && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active
            </label>
          )}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
