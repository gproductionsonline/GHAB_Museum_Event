"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiRequestError, downloadFile } from "@/lib/api";
import { useAuth, useEvent } from "@/lib/auth";
import { Badge, Button, Card, Spinner, StatusBadge } from "@/components/ui";

type PreviewResponse = {
  batchId: string;
  filename: string;
  totalRows: number;
  validRows: number;
  errorCount: number;
  skippedRows: number;
  errors: { row: number; message: string }[];
  skipped: { row: number; message: string }[];
  sample: {
    firstName: string;
    lastName: string;
    email: string | null;
    category: string;
    accompanyingGuests: number;
  }[];
};

type ImportJob = {
  id: string;
  filename: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorCount: number;
  skippedRows: number;
  result: {
    guestsCreated?: number;
    companionsCreated?: number;
    credentialsIssued?: number;
    rowFailures?: number;
  } | null;
  createdAt: string;
  committedAt: string | null;
  completedAt: string | null;
};

type ImportJobDetail = { importJob: ImportJob; errors: { rowNumber: number; field: string | null; message: string }[] };

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACTIVE_STATUSES = ["PREVIEW", "QUEUED", "PROCESSING"];

export default function ImportPage() {
  const { event } = useEvent();
  const { isAdmin } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [batches, setBatches] = useState<ImportJob[]>([]);
  const [activeJob, setActiveJob] = useState<ImportJobDetail | null>(null);
  const [viewingJob, setViewingJob] = useState<ImportJobDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadBatches = useCallback(async () => {
    if (!event) return;
    try {
      const data = await api<{ batches: ImportJob[] }>(`/import/batches?eventId=${event.id}`);
      setBatches(data.batches);
    } catch {
      /* non-fatal */
    }
  }, [event]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  // Refresh history while jobs are in flight.
  useEffect(() => {
    const hasActive = batches.some((b) => ACTIVE_STATUSES.includes(b.status));
    if (!hasActive) return;
    const t = setInterval(() => void loadBatches(), 4000);
    return () => clearInterval(t);
  }, [batches, loadBatches]);

  // Poll the active (committing) job until it reaches a terminal state.
  useEffect(() => {
    if (!activeJob) return;
    const jobId = activeJob.importJob.id;
    let cancelled = false;
    const poll = async () => {
      try {
        const detail = await api<ImportJobDetail>(`/import/${jobId}`);
        if (cancelled) return;
        setActiveJob(detail);
        if (detail.importJob.status === "COMPLETED" || detail.importJob.status === "FAILED") {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setPreview(null);
          setFile(null);
          await loadBatches();
        }
      } catch {
        /* keep polling — transient network errors shouldn't abandon the job */
      }
    };
    pollRef.current = setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [activeJob, loadBatches]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function onFileChosen(f: File | null) {
    if (!f || !event) return;
    setError(null);
    if (f.size > MAX_UPLOAD_BYTES) {
      setError(`"${f.name}" is ${(f.size / 1024 / 1024).toFixed(1)} MB — the upload limit is 5 MB. Split the file.`);
      return;
    }
    setFile(f);
    setPreview(null);
    setActiveJob(null);
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("eventId", event.id);
      fd.append("file", f);
      const data = await api<PreviewResponse>("/import/preview", { method: "POST", formData: fd });
      setPreview(data);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not read the file");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ importJobId: string; status: string }>(
        `/import/${preview.batchId}/commit`,
        { method: "POST", body: {} },
      );
      // Background processing: track the job until completion.
      setActiveJob({
        importJob: {
          id: result.importJobId,
          filename: preview.filename,
          status: result.status,
          totalRows: preview.totalRows,
          validRows: preview.validRows,
          errorCount: preview.errorCount,
          skippedRows: preview.skippedRows,
          result: null,
          createdAt: new Date().toISOString(),
          committedAt: new Date().toISOString(),
          completedAt: null,
        },
        errors: [],
      });
      setPreview(null);
      setFile(null);
      await loadBatches();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Commit failed");
    } finally {
      setBusy(false);
    }
  }

  async function viewJob(jobId: string) {
    setViewingJob(null);
    try {
      setViewingJob(await api<ImportJobDetail>(`/import/${jobId}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load import details");
    }
  }

  if (!event) return <Spinner label="Loading event…" />;

  if (!isAdmin) {
    return (
      <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Only administrators can import guest lists (import:manage permission required).
      </p>
    );
  }

  const job = activeJob?.importJob;
  const processing = job && ACTIVE_STATUSES.includes(job.status);

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="font-serif text-2xl font-bold text-gray-900">Import guest list</h1>
        <p className="mt-1 text-sm text-gray-500">
          Upload the approved Excel (.xlsx) or CSV from Government House. Rows are validated
          before anything is saved — nothing enters the system until you commit.
        </p>
      </div>

      <Card title="1. Upload file">
        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer rounded-lg bg-[#0f2a4a] px-4 py-2 text-sm font-medium text-white hover:bg-[#163a63]">
            Choose .xlsx or .csv…
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => void onFileChosen(e.target.files?.[0] ?? null)}
            />
          </label>
          {file && <span className="text-sm text-gray-600">{file.name}</span>}
          <button
            className="text-sm text-[#0f2a4a] underline"
            onClick={() => downloadFile("/import/template.csv", "guest-list-template.csv")}
          >
            Download the CSV template
          </button>
        </div>
        <p className="mt-3 text-xs text-gray-400">
          Required columns: first_name, last_name. Recommended: email, phone, guest_category,
          accompanying_guests, accompanying_names (separated by ;), table_seat, rsvp_status.
          Limits: 5 MB, 10,000 rows, 200 columns.
        </p>
      </Card>

      {busy && !activeJob && <Spinner label="Validating…" />}
      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

      {preview && (
        <Card title="2. Review preview" actions={<Badge tone="blue">{preview.filename}</Badge>}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Rows" value={preview.totalRows} />
            <Stat label="Valid" value={preview.validRows} tone="green" />
            <Stat label="Errors" value={preview.errorCount} tone={preview.errorCount ? "red" : undefined} />
            <Stat label="Skipped (declined RSVP)" value={preview.skippedRows} tone="amber" />
          </div>

          {preview.errors.length > 0 && (
            <div className="mt-4 max-h-48 overflow-y-auto rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {preview.errors.map((e, i) => (
                <p key={i}>Row {e.row}: {e.message}</p>
              ))}
              {preview.errorCount > preview.errors.length && (
                <p className="mt-1 font-medium">
                  …and {preview.errorCount - preview.errors.length} more (shown after commit in the job detail).
                </p>
              )}
            </div>
          )}
          {preview.skipped.length > 0 && (
            <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              {preview.skipped.map((s, i) => (
                <p key={i}>Row {s.row}: {s.message}</p>
              ))}
            </div>
          )}
          {preview.sample.length > 0 && (
            <div className="mt-4">
              <p className="mb-1 text-xs font-semibold text-gray-500 uppercase">First valid rows</p>
              <ul className="text-sm text-gray-700">
                {preview.sample.map((s, i) => (
                  <li key={i}>
                    {s.firstName} {s.lastName} — {s.category}
                    {s.accompanyingGuests > 0 && ` (+${s.accompanyingGuests})`}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-5 flex items-center gap-3">
            <Button variant="gold" disabled={busy || preview.validRows === 0} onClick={commit}>
              Commit — import {preview.validRows} guests
            </Button>
            <span className="text-xs text-gray-400">
              Committing queues a background job: guests, accompanying-guest slots and QR
              credentials are created row by row.
            </span>
          </div>
        </Card>
      )}

      {job && (
        <Card
          title="3. Commit progress"
          actions={<StatusBadge status={job.status} />}
        >
          {processing && (
            <div className="flex items-center gap-3">
              <Spinner />
              <p className="text-sm text-gray-600">
                Processing <b>{job.filename}</b> — {job.validRows} valid rows. This page tracks
                the job; you can leave it open.
              </p>
            </div>
          )}
          {job.status === "COMPLETED" && job.result && (
            <div>
              <p className="text-sm text-emerald-700">
                Import complete: created <b>{job.result.guestsCreated ?? 0}</b> guests,{" "}
                <b>{job.result.companionsCreated ?? 0}</b> accompanying guests and issued{" "}
                <b>{job.result.credentialsIssued ?? 0}</b> QR credentials.
              </p>
              {(job.result.rowFailures ?? 0) > 0 && (
                <p className="mt-1 text-sm text-amber-700">
                  {job.result.rowFailures} row failures — see the errors below and the import history.
                </p>
              )}
              <p className="mt-2 text-sm text-gray-500">
                Next: use <b>Dashboard → Issue &amp; email pending credentials</b> to send QR
                codes to guests, or email individually from each guest page.
              </p>
            </div>
          )}
          {job.status === "FAILED" && (
            <p className="text-sm text-red-700">
              Import failed — no guests were created. Check the row errors below, fix the file and
              re-upload.
            </p>
          )}
          {activeJob && activeJob.errors.length > 0 && !processing && (
            <div className="mt-3 max-h-40 overflow-y-auto rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {activeJob.errors.map((e, i) => (
                <p key={i}>
                  {e.rowNumber > 0 ? `Row ${e.rowNumber}: ` : ""}
                  {e.message}
                </p>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="Import history">
        <ul className="space-y-1 text-sm">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-50 py-1.5 last:border-0">
              <span className="font-medium">
                {b.filename}
                {b.committedAt ? "" : " (preview only — not committed)"}
              </span>
              <span className="flex items-center gap-2 text-xs text-gray-500">
                {b.validRows}/{b.totalRows} valid
                <StatusBadge status={b.status} />
                {new Date(b.createdAt).toLocaleString()}
                <Button size="sm" variant="secondary" onClick={() => void viewJob(b.id)}>View</Button>
              </span>
            </li>
          ))}
          {batches.length === 0 && <li className="py-2 text-gray-400">No imports yet.</li>}
        </ul>
      </Card>

      {viewingJob && (
        <Card
          title={`Job detail — ${viewingJob.importJob.filename}`}
          actions={
            <span className="flex items-center gap-2">
              <StatusBadge status={viewingJob.importJob.status} />
              <Button size="sm" variant="secondary" onClick={() => setViewingJob(null)}>Close</Button>
            </span>
          }
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Rows" value={viewingJob.importJob.totalRows} />
            <Stat label="Valid" value={viewingJob.importJob.validRows} tone="green" />
            <Stat label="Errors" value={viewingJob.importJob.errorCount} tone={viewingJob.importJob.errorCount ? "red" : undefined} />
            <Stat label="Skipped" value={viewingJob.importJob.skippedRows} tone="amber" />
          </div>
          {viewingJob.importJob.result && (
            <p className="mt-3 text-sm text-gray-700">
              Created <b>{viewingJob.importJob.result.guestsCreated ?? 0}</b> guests,{" "}
              <b>{viewingJob.importJob.result.companionsCreated ?? 0}</b> accompanying guests,{" "}
              <b>{viewingJob.importJob.result.credentialsIssued ?? 0}</b> credentials
              {viewingJob.importJob.result.rowFailures ? `, ${viewingJob.importJob.result.rowFailures} row failures` : ""}.
            </p>
          )}
          {viewingJob.errors.length > 0 && (
            <div className="mt-3 max-h-48 overflow-y-auto rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {viewingJob.errors.map((e, i) => (
                <p key={i}>{e.rowNumber > 0 ? `Row ${e.rowNumber}: ` : ""}{e.message}</p>
              ))}
            </div>
          )}
          {viewingJob.errors.length === 0 && (
            <p className="mt-3 text-sm text-gray-400">No row errors recorded for this job.</p>
          )}
        </Card>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "green" | "red" | "amber";
}) {
  const colors = {
    green: "text-emerald-700",
    red: "text-red-700",
    amber: "text-amber-600",
  };
  return (
    <div className="rounded-lg bg-gray-50 px-3 py-2 text-center">
      <p className={`font-serif text-2xl font-bold ${tone ? colors[tone] : "text-[#0f2a4a]"}`}>{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}
