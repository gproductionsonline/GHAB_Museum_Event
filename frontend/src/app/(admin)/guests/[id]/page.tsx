"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, ApiRequestError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass, Spinner, StatusBadge } from "@/components/ui";

type Detail = {
  guest: {
    id: string;
    eventId: string;
    guestRef: string | null;
    title: string | null;
    firstName: string;
    lastName: string;
    displayName: string | null;
    email: string | null;
    phone: string | null;
    organisation: string | null;
    designation: string | null;
    category: string;
    rsvpStatus: string;
    status: string;
    source: string;
    tableSeat: string | null;
    invitedBy: string | null;
    notes: string | null;
    isCompanion: boolean;
    partyOf: string | null;
    createdAt: string;
    credential: {
      id: string;
      status: string;
      codeLast4: string;
      issuedAt: string;
      emailedAt: string | null;
      revokedAt: string | null;
      revokedReason: string | null;
    } | null;
    qr: { code: string; dataUrl: string } | null;
    checkIn: { id: string; scannedAt: string; gate: string | null; method: string } | null;
    companions: {
      id: string;
      name: string;
      email: string | null;
      status: string;
      credential: { status: string; emailedAt: string | null } | null;
      checkIn: { scannedAt: string } | null;
    }[];
  };
};

type AuditEntry = { id: string; action: string; summary: string; actorLabel: string | null; createdAt: string };
type Category = { id: string; code: string; name: string };
type CredentialVersion = {
  id: string;
  versionNumber: number;
  status: string;
  codeLast4: string;
  issuedAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  expiresAt: string | null;
  emailedAt: string | null;
};

const RSVP_STATES = ["PENDING", "INVITED", "CONFIRMED", "DECLINED", "CANCELLED"] as const;

export default function GuestDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { isAdmin } = useAuth();
  const [detail, setDetail] = useState<Detail["guest"] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [credentials, setCredentials] = useState<CredentialVersion[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [rsvpChoice, setRsvpChoice] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([
        api<Detail>(`/guests/${id}`),
        api<{ credentials: CredentialVersion[] }>(`/guests/${id}/credentials`).catch(() => ({
          credentials: [] as CredentialVersion[],
        })),
      ]);
      setDetail(d.guest);
      setCredentials(c.credentials);
      setRsvpChoice(d.guest.rsvpStatus);
      setError(null);
      api<{ logs: AuditEntry[] }>(`/guests/${id}/audit`)
        .then((a) => setAudit(a.logs))
        .catch(() => setAudit([]));
      api<{ categories: Category[] }>(`/events/${d.guest.eventId}/categories`)
        .then((data) => setCategories(data.categories))
        .catch(() => setCategories([]));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load guest");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, okMessage: string) {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      setNotice(okMessage);
      await load();
    } catch (err) {
      setNotice(err instanceof ApiRequestError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  function applyRsvp() {
    if (!detail || rsvpChoice === detail.rsvpStatus) return;
    const terminal = rsvpChoice === "DECLINED" || rsvpChoice === "CANCELLED";
    const ask = terminal
      ? `Set RSVP to ${rsvpChoice}? This revokes the guest's active credential (and those of accompanying guests).`
      : `Set RSVP to ${rsvpChoice}?`;
    if (!window.confirm(ask)) {
      setRsvpChoice(detail.rsvpStatus);
      return;
    }
    const reason = terminal ? window.prompt("Reason (optional, recorded in the audit log):") ?? undefined : undefined;
    void act(
      () =>
        api(`/guests/${detail.id}/rsvp`, {
          method: "POST",
          body: { code: rsvpChoice, ...(reason ? { reason } : {}) },
        }),
      `RSVP set to ${rsvpChoice}`,
    );
  }

  if (error) return <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!detail) return <Spinner label="Loading guest…" />;

  const g = detail;
  const fullName = g.displayName ?? `${g.title ?? ""} ${g.firstName} ${g.lastName}`.trim();
  const hasActiveCredential = g.credential?.status === "ACTIVE";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/guests" className="text-sm text-[#0f2a4a] hover:underline">← Guests</Link>
          <h1 className="mt-1 font-serif text-2xl font-bold text-gray-900">{fullName}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge tone="blue">{g.category.replace(/_/g, " ")}</Badge>
            <StatusBadge status={g.status} />
            {g.isCompanion && g.partyOf && <Badge tone="amber">accompanying {g.partyOf}</Badge>}
            <span className="text-xs text-gray-400">added {new Date(g.createdAt).toLocaleDateString()} via {g.source.toLowerCase()}</span>
          </div>
        </div>
        {isAdmin && !editing && (
          <Button variant="secondary" onClick={() => setEditing(true)}>Amend details</Button>
        )}
      </div>

      {notice && <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">{notice}</p>}

      {editing && (
        <AmendForm
          guest={g}
          categories={categories}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await load();
          }}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Guest details" className="lg:col-span-2">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            <DetailRow label="Email" value={g.email ?? "—"} />
            <DetailRow label="Phone" value={g.phone ?? "—"} />
            <DetailRow label="Organisation" value={g.organisation ?? "—"} />
            <DetailRow label="Designation" value={g.designation ?? "—"} />
            <DetailRow label="Table / seat" value={g.tableSeat ?? "—"} />
            <DetailRow label="Invited by" value={g.invitedBy ?? "—"} />
            <DetailRow label="Reference" value={g.guestRef ?? "—"} />
            <DetailRow label="RSVP" value={g.rsvpStatus} />
          </dl>
          {g.notes && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{g.notes}</p>}
        </Card>

        <Card title="Credential">
          {g.qr ? (
            <div className="flex flex-col items-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={g.qr.dataUrl} alt="Admission QR code" width={200} height={200} className="rounded-lg border border-gray-200" />
              <p className="mt-2 font-mono text-sm font-bold tracking-widest">{g.qr.code.match(/.{1,5}/g)?.join(" ")}</p>
              <p className="mt-1 text-xs text-gray-400">
                issued {new Date(g.credential!.issuedAt).toLocaleDateString()} ·{" "}
                {g.credential!.emailedAt ? `emailed ${new Date(g.credential!.emailedAt).toLocaleDateString()}` : "not emailed yet"}
              </p>
            </div>
          ) : g.credential ? (
            <p className="text-sm text-gray-500">
              Credential {g.credential.status.toLowerCase()}
              {g.credential.revokedReason ? ` — ${g.credential.revokedReason}` : ""}
            </p>
          ) : (
            <p className="text-sm text-gray-400">No credential issued.</p>
          )}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {isAdmin && !hasActiveCredential && g.status === "CONFIRMED" && (
              <Button size="sm" disabled={busy} onClick={() => act(() => api(`/guests/${g.id}/credential/issue`, { method: "POST", body: {} }), "Credential issued")}>
                Issue credential
              </Button>
            )}
            {isAdmin && hasActiveCredential && (
              <Button size="sm" variant="gold" disabled={busy}
                onClick={() => {
                  const reason = window.prompt("Reason for reissue (e.g. lost phone)?") ?? undefined;
                  void act(() => api(`/guests/${g.id}/credential/reissue`, { method: "POST", body: { reason } }), "Credential reissued — previous code is now invalid");
                }}>
                Reissue
              </Button>
            )}
            {isAdmin && hasActiveCredential && (
              <Button size="sm" variant="danger" disabled={busy}
                onClick={() => {
                  const reason = window.prompt("Reason for revocation?") ?? undefined;
                  void act(() => api(`/guests/${g.id}/credential/revoke`, { method: "POST", body: { reason } }), "Credential revoked");
                }}>
                Revoke
              </Button>
            )}
            {hasActiveCredential && g.email && (
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => act(() => api(`/guests/${g.id}/credential/email`, { method: "POST", body: {} }), "Credential email sent (check outbox if SMTP off)")}>
                {g.credential?.emailedAt ? "Resend email" : "Email credential"}
              </Button>
            )}
            {hasActiveCredential && (
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => {
                  void (async () => {
                    const { downloadFile } = await import("@/lib/api");
                    await downloadFile(`/credentials/${g.id}/qr.png`, `credential-${g.lastName}.png`);
                  })();
                }}>
                Download QR
              </Button>
            )}
          </div>
        </Card>

        <Card title={`Credential history (${credentials.length})`} className="lg:col-span-1">
          <ul className="space-y-2 text-sm">
            {credentials.map((v) => (
              <li key={v.id} className="rounded-lg border border-gray-100 px-3 py-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[#0f2a4a]">v{v.versionNumber}</span>
                  <StatusBadge status={v.status} />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                  issued {new Date(v.issuedAt).toLocaleDateString()}
                  {v.emailedAt && ` · emailed ${new Date(v.emailedAt).toLocaleDateString()}`}
                </p>
                {v.revokedAt && (
                  <p className="text-xs text-red-600">
                    revoked {new Date(v.revokedAt).toLocaleDateString()}
                    {v.revokedReason ? ` — ${v.revokedReason}` : ""}
                  </p>
                )}
              </li>
            ))}
            {credentials.length === 0 && (
              <li className="py-2 text-gray-400">No credentials issued yet.</li>
            )}
          </ul>
          <p className="mt-2 text-[10px] text-gray-400">
            Old versions are immutable evidence; a replaced credential can never become valid again.
          </p>
        </Card>

        <Card title="Attendance" className="lg:col-span-1">
          {isAdmin && (
            <div className="mb-4 border-b border-gray-100 pb-3">
              <p className="mb-1 text-xs font-semibold tracking-wide text-gray-600 uppercase">
                RSVP status
              </p>
              <div className="flex items-center gap-2">
                <select
                  className={inputClass}
                  value={rsvpChoice}
                  onChange={(e) => setRsvpChoice(e.target.value)}
                  disabled={busy}
                >
                  {RSVP_STATES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <Button size="sm" disabled={busy || !detail || rsvpChoice === detail.rsvpStatus}
                  onClick={applyRsvp}>
                  Apply
                </Button>
              </div>
              <p className="mt-1 text-[10px] text-gray-400">
                Declined/Cancelled revoke credentials, including accompanying guests.
              </p>
            </div>
          )}
          {g.checkIn ? (
            <div className="text-sm">
              <p className="font-semibold text-emerald-700">Checked in</p>
              <p className="mt-1 text-gray-600">
                {new Date(g.checkIn.scannedAt).toLocaleString()}<br />
                Gate: {g.checkIn.gate ?? "—"} · Method: {g.checkIn.method}
              </p>
              {isAdmin && (
                <Button className="mt-3" size="sm" variant="secondary" disabled={busy}
                  onClick={() => act(() => api("/checkin/undo", { method: "POST", body: { checkInId: g.checkIn!.id } }), "Check-in undone — guest may be re-admitted")}>
                  Undo check-in
                </Button>
              )}
            </div>
          ) : (
            <div className="text-sm">
              <p className="text-gray-500">Not checked in.</p>
              {isAdmin && (
                <Button className="mt-3" size="sm" variant="gold" disabled={busy}
                  onClick={() => act(() => api("/checkin/manual", { method: "POST", body: { eventId: g.eventId, guestId: g.id } }), "Manually checked in")}>
                  Manual check-in
                </Button>
              )}
            </div>
          )}
          {isAdmin && g.status === "CONFIRMED" && (
            <Button className="mt-2" size="sm" variant="danger" disabled={busy}
              onClick={() => {
                const reason = window.prompt("Reason for cancellation?") ?? undefined;
                void act(() => api(`/guests/${g.id}/cancel`, { method: "POST", body: { reason } }), "Guest cancelled — credential revoked");
              }}>
              Cancel guest
            </Button>
          )}
          {isAdmin && g.status === "CANCELLED" && (
            <Button className="mt-2" size="sm" disabled={busy}
              onClick={() => act(() => api(`/guests/${g.id}/restore`, { method: "POST", body: {} }), "Guest restored — issue a new credential")}>
              Restore guest
            </Button>
          )}
        </Card>

        {!g.isCompanion && (
          <Card title={`Accompanying guests (${g.companions.length})`} className="lg:col-span-2">
            <ul className="space-y-1 text-sm">
              {g.companions.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 odd:bg-gray-50">
                  <Link href={`/guests/${c.id}`} className="font-medium text-[#0f2a4a] hover:underline">{c.name}</Link>
                  <span className="flex items-center gap-2 text-xs text-gray-500">
                    {c.checkIn
                      ? <Badge tone="green">in {new Date(c.checkIn.scannedAt).toLocaleTimeString()}</Badge>
                      : <Badge tone="gray">not in</Badge>}
                    {c.credential?.status === "ACTIVE" ? <Badge tone="blue">credential active</Badge> : <Badge tone="red">no active credential</Badge>}
                  </span>
                </li>
              ))}
              {g.companions.length === 0 && <li className="py-2 text-gray-400">No accompanying guests recorded.</li>}
            </ul>
            {isAdmin && (
              <AddCompanion guestId={g.id} defaultCategory={g.category} defaultTable={g.tableSeat} disabled={busy}
                onAdded={() => act(async () => { await load(); }, "Companion added")} />
            )}
          </Card>
        )}

        <Card title="Audit trail" className="lg:col-span-3">
          <ul className="space-y-1 text-sm">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-50 py-1.5 last:border-0">
                <span>
                  <StatusBadge status={a.action} />
                  <span className="ml-2 text-gray-700">{a.summary}</span>
                </span>
                <span className="text-xs text-gray-400">
                  {a.actorLabel} · {new Date(a.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
            {audit.length === 0 && <li className="py-2 text-gray-400">No audit entries.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-gray-50 py-1">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-right font-medium text-gray-800">{value}</dd>
    </div>
  );
}

function AmendForm({
  guest,
  categories,
  onCancel,
  onSaved,
}: {
  guest: Detail["guest"];
  categories: Category[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    title: guest.title ?? "",
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email ?? "",
    phone: guest.phone ?? "",
    organisation: guest.organisation ?? "",
    designation: guest.designation ?? "",
    category: guest.category,
    tableSeat: guest.tableSeat ?? "",
    notes: guest.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/guests/${guest.id}`, {
        method: "PATCH",
        body: {
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
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  function set(key: keyof typeof form) {
    return (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm({ ...form, [key]: e.target.value });
  }

  return (
    <Card title="Amend guest details">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3">
        <Field label="Title"><input className={inputClass} value={form.title} onChange={set("title")} /></Field>
        <Field label="First name"><input required className={inputClass} value={form.firstName} onChange={set("firstName")} /></Field>
        <Field label="Last name"><input required className={inputClass} value={form.lastName} onChange={set("lastName")} /></Field>
        <Field label="Email"><input type="email" className={inputClass} value={form.email} onChange={set("email")} /></Field>
        <Field label="Phone"><input className={inputClass} value={form.phone} onChange={set("phone")} /></Field>
        <Field label="Category">
          <select className={inputClass} value={form.category} onChange={set("category")}>
            {categories.map((c) => (
              <option key={c.id} value={c.code}>{c.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Organisation"><input className={inputClass} value={form.organisation} onChange={set("organisation")} /></Field>
        <Field label="Designation"><input className={inputClass} value={form.designation} onChange={set("designation")} /></Field>
        <Field label="Table / seat"><input className={inputClass} value={form.tableSeat} onChange={set("tableSeat")} /></Field>
        <div className="sm:col-span-3">
          <Field label="Notes"><textarea rows={2} className={inputClass} value={form.notes} onChange={set("notes")} /></Field>
        </div>
        {error && <p className="sm:col-span-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="sm:col-span-3 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>
    </Card>
  );
}

function AddCompanion({
  guestId,
  defaultCategory,
  defaultTable,
  onAdded,
  disabled,
}: {
  guestId: string;
  defaultCategory: string;
  defaultTable: string | null;
  onAdded: () => void;
  disabled: boolean;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const tokens = name.trim().split(/\s+/);
      await api(`/guests/${guestId}/companions`, {
        method: "POST",
        body: {
          firstName: tokens[0],
          lastName: tokens.slice(1).join(" ") || "",
          email: email || null,
        },
      });
      setName("");
      setEmail("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not add companion");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-gray-100 pt-3">
      <Field label="Add accompanying guest (first last)">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="James Smith" />
      </Field>
      <Field label="Email (optional — gets own credential)">
        <input type="email" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      <Button size="sm" onClick={add} disabled={busy || disabled || !name.trim()}>
        {busy ? "Adding…" : "Add"}
      </Button>
      <span className="text-xs text-gray-400">
        Category defaults to {defaultCategory.replace(/_/g, " ")}
        {defaultTable ? `, table ${defaultTable}` : ""}
      </span>
      {error && <p className="w-full rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
    </div>
  );
}
