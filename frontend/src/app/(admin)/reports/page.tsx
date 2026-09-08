"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError, downloadFile } from "@/lib/api";
import { useEvent } from "@/lib/auth";
import { Button, Card, Spinner, StatusBadge } from "@/components/ui";

type ReportJob = {
  id: string;
  type: string;
  format: string;
  status: string;
  rows: number | null;
  createdAt: string;
  completedAt: string | null;
  expiresAt: string | null;
};

const REPORT_TYPES: { value: string; label: string }[] = [
  { value: "GUEST_LIST", label: "Guest list" },
  { value: "ATTENDANCE", label: "Attendance" },
  { value: "DOOR_LIST", label: "Door list" },
  { value: "AUDIT", label: "Audit log" },
];

const ACTIVE_JOB_STATUSES = ["QUEUED", "PROCESSING"];

export default function ReportsPage() {
  const { event } = useEvent();
  const [busy, setBusy] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ReportJob[]>([]);
  const [queueType, setQueueType] = useState("GUEST_LIST");
  const [queueBusy, setQueueBusy] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [failedDetail, setFailedDetail] = useState<{ id: string; error: string | null } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadJobs = useCallback(async (eventId: string) => {
    try {
      const data = await api<{ reportJobs: ReportJob[] }>(`/reports/jobs?eventId=${eventId}`);
      setJobs(data.reportJobs);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (!event) return;
    void loadJobs(event.id);
  }, [event, loadJobs]);

  // Poll while any job is in flight.
  useEffect(() => {
    if (!event) return;
    if (!jobs.some((j) => ACTIVE_JOB_STATUSES.includes(j.status))) return;
    const t = setInterval(() => void loadJobs(event.id), 2000);
    return () => clearInterval(t);
  }, [event, jobs, loadJobs]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function download(kind: string) {
    if (!event) return;
    setBusy(kind);
    try {
      const map: Record<string, [string, string]> = {
        guests: [`/reports/guests.csv?eventId=${event.id}`, "guest-list.csv"],
        attendance: [`/reports/attendance.csv?eventId=${event.id}`, "attendance.csv"],
        door: [`/reports/door-list.csv?eventId=${event.id}`, "door-list.csv"],
        audit: [`/reports/audit.csv?eventId=${event.id}`, "audit-log.csv"],
      };
      const [path, filename] = map[kind]!;
      await downloadFile(path, filename);
    } finally {
      setBusy(null);
    }
  }

  async function queueJob() {
    if (!event) return;
    setQueueBusy(true);
    setJobError(null);
    setFailedDetail(null);
    try {
      await api<{ reportJob: { id: string } }>("/reports/jobs", {
        method: "POST",
        body: { eventId: event.id, type: queueType },
      });
      await loadJobs(event.id);
    } catch (err) {
      setJobError(err instanceof ApiRequestError ? err.message : "Could not queue the export");
    } finally {
      setQueueBusy(false);
    }
  }

  async function downloadJob(job: ReportJob) {
    if (!event) return;
    setBusy(job.id);
    try {
      await downloadFile(`/reports/jobs/${job.id}/download`, `${job.type.toLowerCase()}-${job.id.slice(0, 8)}.csv`);
    } catch (err) {
      setJobError(err instanceof ApiRequestError ? err.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  async function showFailure(job: ReportJob) {
    setFailedDetail({ id: job.id, error: null });
    try {
      const detail = await api<{ reportJob: { id: string; error: string | null } }>(`/reports/jobs/${job.id}`);
      setFailedDetail({ id: detail.reportJob.id, error: detail.reportJob.error });
    } catch {
      setFailedDetail({ id: job.id, error: "Could not load the failure reason" });
    }
  }

  if (!event) return <Spinner label="Loading event…" />;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-bold text-gray-900">Reports & exports</h1>
        <p className="mt-1 text-sm text-gray-500">
          Downloadable CSV files for {event.name}. All exports include full audit information.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Guest list">
          <p className="mb-3 text-sm text-gray-500">
            Every guest and accompanying guest with categories, credential status, email
            status and check-in details.
          </p>
          <Button onClick={() => void download("guests")} disabled={busy === "guests"}>
            {busy === "guests" ? "Preparing…" : "Download guests.csv"}
          </Button>
        </Card>

        <Card title="Attendance">
          <p className="mb-3 text-sm text-gray-500">
            Chronological record of every admission: time, gate, device, method and
            offline-scan timestamps.
          </p>
          <Button onClick={() => void download("attendance")} disabled={busy === "attendance"}>
            {busy === "attendance" ? "Preparing…" : "Download attendance.csv"}
          </Button>
        </Card>

        <Card title="Door list (backup process)">
          <p className="mb-3 text-sm text-gray-500">
            Printable backup list sorted by name with a short manual code per guest.
            Print this before the event as the fallback if devices or connectivity fail.
          </p>
          <Button variant="gold" onClick={() => void download("door")} disabled={busy === "door"}>
            {busy === "door" ? "Preparing…" : "Download door-list.csv"}
          </Button>
        </Card>

        <Card title="Audit log">
          <p className="mb-3 text-sm text-gray-500">
            Every amendment, cancellation, credential issue/reissue/revocation, email and
            check-in undo — with actor and timestamp.
          </p>
          <Button variant="secondary" onClick={() => void download("audit")} disabled={busy === "audit"}>
            {busy === "audit" ? "Preparing…" : "Download audit-log.csv"}
          </Button>
        </Card>
      </div>

      <p className="text-xs text-gray-400">
        Direct downloads are capped at 5,000 rows each. For larger events use the background
        export below — it streams the full dataset in a server job and keeps the file
        available for 24 hours.
      </p>

      <Card title="Background export (large events)">
        <div className="flex flex-wrap items-center gap-3">
          <select
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            value={queueType}
            onChange={(e) => setQueueType(e.target.value)}
          >
            {REPORT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <Button onClick={queueJob} disabled={queueBusy}>
            {queueBusy ? "Queueing…" : "Queue background export"}
          </Button>
          <span className="text-xs text-gray-400">Generate the full dataset server-side.</span>
        </div>

        {jobError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{jobError}</p>}

        {jobs.length > 0 && (
          <table className="mt-4 w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs text-gray-400 uppercase">
                <th className="pb-2">Report</th>
                <th className="pb-2">Status</th>
                <th className="pb-2 text-right">Rows</th>
                <th className="pb-2">Created</th>
                <th className="pb-2 text-right">File</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const expired = j.expiresAt ? new Date(j.expiresAt) < new Date() : false;
                return (
                  <tr key={j.id} className="border-b border-gray-50 align-middle last:border-0">
                    <td className="py-2 font-medium">{REPORT_TYPES.find((t) => t.value === j.type)?.label ?? j.type}</td>
                    <td className="py-2">
                      <StatusBadge status={j.status} />
                      {j.status === "FAILED" && (
                        <button
                          className="ml-2 text-xs text-red-700 underline"
                          onClick={() => void showFailure(j)}
                        >
                          why?
                        </button>
                      )}
                    </td>
                    <td className="py-2 text-right font-mono">{j.rows ?? (ACTIVE_JOB_STATUSES.includes(j.status) ? "…" : "—")}</td>
                    <td className="py-2 text-xs text-gray-500">{new Date(j.createdAt).toLocaleString()}</td>
                    <td className="py-2 text-right">
                      {j.status === "COMPLETED" && !expired && (
                        <Button size="sm" onClick={() => void downloadJob(j)} disabled={busy === j.id}>
                          {busy === j.id ? "…" : "Download"}
                        </Button>
                      )}
                      {j.status === "COMPLETED" && expired && (
                        <span className="text-xs text-amber-600">expired</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {jobs.length === 0 && (
          <p className="mt-3 text-sm text-gray-400">No background exports queued yet.</p>
        )}

        {failedDetail && (
          <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {failedDetail.error ?? "Unknown failure"}{" "}
            <button className="underline" onClick={() => setFailedDetail(null)}>dismiss</button>
          </p>
        )}
      </Card>
    </div>
  );
}
