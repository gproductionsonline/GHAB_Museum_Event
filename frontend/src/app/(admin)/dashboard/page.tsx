"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, sseUrl, ApiRequestError } from "@/lib/api";
import { useEvent } from "@/lib/auth";
import { Badge, Button, Card, Spinner, StatusBadge } from "@/components/ui";

type Stats = {
  eventId: string;
  totals: {
    expected: number;
    checkedIn: number;
    notArrived: number;
    accompanying: number;
    pendingEmail: number;
    cancelled: number;
  };
  byCategory: { category: string; expected: number; checkedIn: number }[];
  byGate: { gate: string; count: number; lastAt: string | null }[];
  timeline: { bucket: string; count: number }[];
  recent: { id: string; guest: string; category: string; gate: string | null; method: string; scannedAt: string }[];
  syncDevices: { deviceName: string; lastSyncAt: string; applied: number; duplicate: number }[];
  generatedAt: string;
};

export default function DashboardPage() {
  const { event } = useEvent();
  const [stats, setStats] = useState<Stats | null>(null);
  const [live, setLive] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const loadStats = useCallback(async (eventId: string) => {
    try {
      const data = await api<Stats>(`/stats?eventId=${eventId}`);
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load stats");
    }
  }, []);

  useEffect(() => {
    if (!event) return;
    void loadStats(event.id);

    const es = new EventSource(sseUrl("/stats/stream", { eventId: event.id }));
    esRef.current = es;
    es.addEventListener("hello", () => setLive(true));
    es.addEventListener("stats", (e) => {
      setLive(true);
      try {
        setStats(JSON.parse((e as MessageEvent).data) as Stats);
      } catch {
        /* ignore malformed frames */
      }
    });
    es.onerror = () => {
      setLive(false);
    };
    return () => {
      es.close();
      esRef.current = null;
      setLive(false);
    };
  }, [event, loadStats]);

  async function bulkEmail() {
    if (!event) return;
    setBulkBusy(true);
    setBulkMsg(null);
    try {
      const result = await api<{
        issued: number;
        queued: number;
        alreadyHandled: number;
        failed: { guestId: string; guest: string; error: string }[];
      }>("/credentials/bulk-email", { method: "POST", body: { eventId: event.id } });
      const parts = [
        `${result.issued} credential${result.issued === 1 ? "" : "s"} issued`,
        `${result.queued} email${result.queued === 1 ? "" : "s"} queued`,
      ];
      if (result.alreadyHandled) parts.push(`${result.alreadyHandled} already sent`);
      if (result.failed.length) {
        parts.push(`${result.failed.length} failed (${result.failed[0]?.guest}: ${result.failed[0]?.error})`);
      }
      setBulkMsg(`Done — ${parts.join(", ")}. The email worker delivers and retries automatically; see Email for status.`);
      void loadStats(event.id);
    } catch (err) {
      setBulkMsg(err instanceof ApiRequestError ? err.message : "Bulk email failed");
    } finally {
      setBulkBusy(false);
    }
  }

  if (!event) {
    return <Spinner label="Loading event…" />;
  }

  const pct = stats && stats.totals.expected > 0
    ? Math.round((stats.totals.checkedIn / stats.totals.expected) * 100)
    : 0;
  const maxBucket = Math.max(1, ...(stats?.timeline.map((t) => t.count) ?? [1]));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold text-gray-900">{event.name}</h1>
          <p className="text-sm text-gray-500">
            {new Date(event.startsAt).toLocaleString()} · {event.venue ?? "Government House"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={live ? "green" : "amber"}>{live ? "● Live" : "● Polling"}</Badge>
          <Button variant="gold" onClick={bulkEmail} disabled={bulkBusy}>
            {bulkBusy ? "Sending…" : "Issue & email pending credentials"}
          </Button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      )}
      {bulkMsg && (
        <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">{bulkMsg}</p>
      )}

      {stats ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Card>
              <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Expected</p>
              <p className="mt-1 font-serif text-4xl font-bold text-[#0f2a4a]">
                {stats.totals.expected}
              </p>
              <p className="mt-1 text-xs text-gray-400">confirmed, incl. {stats.totals.accompanying} accompanying</p>
            </Card>
            <Card>
              <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Checked in</p>
              <p className="mt-1 font-serif text-4xl font-bold text-emerald-700">
                {stats.totals.checkedIn}
              </p>
              <p className="mt-1 text-xs text-gray-400">{pct}% of expected</p>
            </Card>
            <Card>
              <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Not yet arrived</p>
              <p className="mt-1 font-serif text-4xl font-bold text-[#0f2a4a]">
                {stats.totals.notArrived}
              </p>
              <p className="mt-1 text-xs text-gray-400">confirmed guests still to come</p>
            </Card>
            <Card>
              <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Credentials pending email</p>
              <p className="mt-1 font-serif text-4xl font-bold text-amber-600">
                {stats.totals.pendingEmail}
              </p>
              <p className="mt-1 text-xs text-gray-400">primary guests not yet emailed</p>
            </Card>
            <Card>
              <p className="text-xs font-semibold tracking-wide text-gray-500 uppercase">Cancelled</p>
              <p className="mt-1 font-serif text-4xl font-bold text-red-700">
                {stats.totals.cancelled}
              </p>
              <p className="mt-1 text-xs text-gray-400">cancelled or declined guests</p>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="By category" className="lg:col-span-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-400 uppercase">
                    <th className="pb-2">Category</th>
                    <th className="pb-2 text-right">In</th>
                    <th className="pb-2 text-right">Expected</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byCategory.map((c) => (
                    <tr key={c.category} className="border-b border-gray-50 last:border-0">
                      <td className="py-1.5 font-medium">{c.category.replace(/_/g, " ")}</td>
                      <td className="py-1.5 text-right font-mono">{c.checkedIn}</td>
                      <td className="py-1.5 text-right font-mono text-gray-400">{c.expected}</td>
                    </tr>
                  ))}
                  {stats.byCategory.length === 0 && (
                    <tr><td className="py-3 text-gray-400" colSpan={3}>No guests imported yet</td></tr>
                  )}
                </tbody>
              </table>
            </Card>

            <Card title="Check-ins — last 3 hours" className="lg:col-span-2">
              <div className="flex h-28 items-end gap-1">
                {stats.timeline.map((t) => (
                  <div key={t.bucket} className="flex-1" title={`${new Date(t.bucket).toLocaleTimeString()} — ${t.count}`}>
                    <div
                      className="w-full rounded-t bg-[#0f2a4a]"
                      style={{ height: `${Math.max(4, (t.count / maxBucket) * 100)}%` }}
                    />
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-400">
                10-minute buckets · gates:{" "}
                {stats.byGate.length
                  ? stats.byGate.map((g) => `${g.gate} (${g.count})`).join(", ")
                  : "none yet"}
              </p>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Recent check-ins">
              <ul className="space-y-1 text-sm">
                {stats.recent.map((r) => (
                  <li key={r.id} className="flex items-center justify-between rounded-lg px-2 py-1.5 odd:bg-gray-50">
                    <span className="font-medium">{r.guest}</span>
                    <span className="flex items-center gap-2 text-xs text-gray-500">
                      <Badge tone="blue">{r.category.replace(/_/g, " ")}</Badge>
                      {r.gate && <span>{r.gate}</span>}
                      <span className="font-mono">{new Date(r.scannedAt).toLocaleTimeString()}</span>
                      <StatusBadge status={r.method} />
                    </span>
                  </li>
                ))}
                {stats.recent.length === 0 && (
                  <li className="py-3 text-gray-400">No check-ins yet</li>
                )}
              </ul>
            </Card>

            <Card title="Scanner devices">
              <ul className="space-y-1 text-sm">
                {stats.syncDevices.map((d) => (
                  <li key={d.deviceName} className="flex items-center justify-between rounded-lg px-2 py-1.5 odd:bg-gray-50">
                    <span className="font-medium">{d.deviceName}</span>
                    <span className="text-xs text-gray-500">
                      last sync {new Date(d.lastSyncAt).toLocaleTimeString()} ·{" "}
                      {d.applied} applied, {d.duplicate} duplicates
                    </span>
                  </li>
                ))}
                {stats.syncDevices.length === 0 && (
                  <li className="py-3 text-gray-400">No devices have synced yet</li>
                )}
              </ul>
              <p className="mt-3 text-xs text-gray-400">
                Devices verify against a local snapshot, queue scans offline and sync when
                connectivity returns.
              </p>
            </Card>
          </div>
        </>
      ) : (
        <Spinner label="Loading attendance…" />
      )}
    </div>
  );
}
