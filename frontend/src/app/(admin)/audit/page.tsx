"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useAuth, useEvent } from "@/lib/auth";
import { Badge, Button, Card, inputClass, Spinner, StatusBadge } from "@/components/ui";

type AuditRow = {
  id: string;
  at: string;
  actor: string | null;
  action: string;
  result: string;
  entityType: string | null;
  entityId: string | null;
  eventId: string | null;
  summary: string;
};

const ENTITY_TYPES = [
  "",
  "Guest",
  "CredentialVersion",
  "Event",
  "GuestCategory",
  "User",
  "Device",
  "ImportJob",
  "ReportJob",
  "CheckIn",
  "EmailDelivery",
  "Role",
];

const PAGE_SIZE = 50;

export default function AuditPage() {
  const { events } = useEvent();
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [eventId, setEventId] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p = page) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          page: String(p),
          pageSize: String(PAGE_SIZE),
        });
        if (eventId) params.set("eventId", eventId);
        if (action.trim()) params.set("action", action.trim().toUpperCase());
        if (entityType) params.set("entityType", entityType);
        const data = await api<{ total: number; logs: AuditRow[] }>(`/audit?${params.toString()}`);
        setRows(data.logs);
        setTotal(data.total);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : "Could not load audit log");
      } finally {
        setLoading(false);
      }
    },
    [page, eventId, action, entityType],
  );

  useEffect(() => {
    setPage(1);
  }, [eventId, action, entityType]);

  useEffect(() => {
    const t = setTimeout(() => void load(page), 200);
    return () => clearTimeout(t);
  }, [load, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-bold text-gray-900">Audit log</h1>
        <p className="text-sm text-gray-500">
          Append-only record of every security-sensitive action. Entries can never be edited or
          deleted.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className={`${inputClass} w-auto`} value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">All events (incl. system actions)</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <input
          className={`${inputClass} w-auto`}
          placeholder="Filter by action (e.g. GUEST_CANCELLED)"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        />
        <select className={`${inputClass} w-auto`} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>{t || "All entity types"}</option>
          ))}
        </select>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">Entity</th>
                <th className="px-3 py-2">Result</th>
                <th className="px-3 py-2">Summary</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-gray-50 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 text-xs whitespace-nowrap text-gray-500">
                    {new Date(r.at).toLocaleString()}
                  </td>
                  <td className="px-3 py-2"><StatusBadge status={r.action} /></td>
                  <td className="px-3 py-2 text-xs">{r.actor ?? "system"}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.entityType ? <Badge tone="gray">{r.entityType}</Badge> : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <span className={r.result === "FAILURE" ? "text-red-600" : "text-emerald-600"}>
                      {r.result}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-700">{r.summary}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                    No audit entries match the filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-sm">
          <span className="text-gray-500">
            {loading ? "Loading…" : `${total} entr${total === 1 ? "y" : "ies"}`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ← Prev
            </Button>
            <span className="text-gray-500">Page {page} / {pages}</span>
            <Button variant="secondary" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
              Next →
            </Button>
          </div>
        </div>
      </Card>

      {!isAdmin && (
        <p className="text-xs text-gray-400">
          Audit access requires the audit:read permission; the server enforces this on every request.
        </p>
      )}
    </div>
  );
}
