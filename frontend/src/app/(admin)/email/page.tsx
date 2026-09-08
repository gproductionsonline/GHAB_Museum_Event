"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useEvent } from "@/lib/auth";
import { Button, Card, inputClass, Spinner, StatusBadge } from "@/components/ui";

type Delivery = {
  id: string;
  recipient: string;
  guest: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
};

const PAGE_SIZE = 50;

export default function EmailPage() {
  const { event, events } = useEvent();
  const [rows, setRows] = useState<Delivery[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [eventId, setEventId] = useState("");
  const [status, setStatus] = useState("");
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
        if (status) params.set("status", status);
        const data = await api<{ total: number; deliveries: Delivery[] }>(
          `/email/deliveries?${params.toString()}`,
        );
        setRows(data.deliveries);
        setTotal(data.total);
      } catch (err) {
        setError(err instanceof ApiRequestError ? err.message : "Could not load deliveries");
      } finally {
        setLoading(false);
      }
    },
    [page, eventId, status],
  );

  useEffect(() => {
    setPage(1);
  }, [eventId, status]);

  useEffect(() => {
    const t = setTimeout(() => void load(page), 200);
    return () => clearTimeout(t);
  }, [load, page]);

  // Auto-refresh while work is in flight so queue progress is visible.
  useEffect(() => {
    const hasPending = rows.some((r) => r.status === "QUEUED" || r.status === "SENDING");
    if (!hasPending) return;
    const t = setInterval(() => void load(page), 3000);
    return () => clearInterval(t);
  }, [rows, load, page]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-bold text-gray-900">Credential email deliveries</h1>
        <p className="text-sm text-gray-500">
          Queue, delivery attempts, retries and failures. The worker retries failed deliveries
          with exponential backoff (up to 5 attempts).
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className={`${inputClass} w-auto`} value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">All events</option>
          {events.map((e) => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <select className={`${inputClass} w-auto`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="QUEUED">Queued</option>
          <option value="SENDING">Sending</option>
          <option value="SENT">Sent</option>
          <option value="FAILED">Failed</option>
        </select>
        <Button variant="secondary" onClick={() => void load(page)}>Refresh</Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="px-3 py-2">Guest</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Attempts</th>
                <th className="px-3 py-2">Next retry</th>
                <th className="px-3 py-2">Sent / Created</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b border-gray-50 align-top hover:bg-gray-50">
                  <td className="px-3 py-2 font-medium text-[#0f2a4a]">{d.guest}</td>
                  <td className="px-3 py-2 text-xs">{d.recipient}</td>
                  <td className="px-3 py-2"><StatusBadge status={d.status} /></td>
                  <td className="px-3 py-2 font-mono text-xs">{d.attempts}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {d.nextAttemptAt ? new Date(d.nextAttemptAt).toLocaleTimeString() : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {d.sentAt
                      ? `sent ${new Date(d.sentAt).toLocaleString()}`
                      : new Date(d.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 max-w-[220px] text-xs text-red-600">{d.error ?? ""}</td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                    No email deliveries yet. Send credentials from a guest page or the dashboard
                    bulk action.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-gray-100 px-3 py-2 text-sm">
          <span className="text-gray-500">
            {loading ? "Loading…" : `${total} deliver${total === 1 ? "y" : "ies"}`}
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

      {event && (
        <p className="text-xs text-gray-400">
          When SMTP is not configured, deliveries are written to a local development outbox and
          still recorded here — no credentials are hard-coded.
        </p>
      )}
    </div>
  );
}
