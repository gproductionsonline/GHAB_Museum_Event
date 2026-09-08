"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useAuth, useEvent } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass, Spinner, StatusBadge } from "@/components/ui";

type DeviceRow = {
  id: string;
  publicId: string;
  name: string;
  deviceType: string | null;
  status: string;
  expiresAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  offlineCheckInCount: number;
};

type SyncOperation = {
  id: string;
  operationId: string;
  status: string;
  resultDetail: string | null;
  gate: string | null;
  clientTimestamp: string;
  receivedAt: string;
  checkInId: string | null;
  checkIn: { scannedAt: string; gate: string | null } | null;
};

export default function DevicesPage() {
  const { event } = useEvent();
  const { isAdmin } = useAuth();
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [historyFor, setHistoryFor] = useState<DeviceRow | null>(null);

  const load = useCallback(async () => {
    if (!event) return;
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ devices: DeviceRow[] }>(`/devices?eventId=${event.id}`);
      setDevices(data.devices);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load devices");
    } finally {
      setLoading(false);
    }
  }, [event]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(d: DeviceRow) {
    if (!window.confirm(`Revoke "${d.name}"? It can no longer sync or download snapshots.`)) return;
    setError(null);
    try {
      await api(`/devices/${d.id}/revoke`, { method: "POST", body: {} });
      setNotice(`Device "${d.name}" revoked.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not revoke device");
    }
  }

  async function activate(d: DeviceRow) {
    setError(null);
    try {
      await api(`/devices/${d.id}/activate`, { method: "POST", body: {} });
      setNotice(`Device "${d.name}" re-activated.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not activate device");
    }
  }

  if (!isAdmin) {
    return (
      <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Device management requires an administrator account.
      </p>
    );
  }
  if (!event) return <Spinner label="Loading event…" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold text-gray-900">Scanner devices</h1>
          <p className="text-sm text-gray-500">
            Pre-authorized offline check-in devices for {event.name}. Devices must be registered
            here before they can sync — unknown devices are rejected.
          </p>
        </div>
        <Button onClick={() => setRegistering(true)}>+ Register device</Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && <p className="rounded-lg bg-blue-50 px-4 py-3 text-sm text-blue-800">{notice}</p>}
      {loading && <Spinner label="Loading devices…" />}

      {!loading && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">Device</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last seen</th>
                  <th className="px-3 py-2">Expires</th>
                  <th className="px-3 py-2">Offline ops</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <p className="font-medium text-[#0f2a4a]">{d.name}</p>
                      <p className="font-mono text-[10px] text-gray-400">{d.publicId}</p>
                    </td>
                    <td className="px-3 py-2 text-xs">{d.deviceType ?? "—"}</td>
                    <td className="px-3 py-2">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : "—"}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{d.offlineCheckInCount}</td>
                    <td className="px-3 py-2 text-right">
                      <span className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setHistoryFor(d)}>
                          Sync history
                        </Button>
                        {d.status === "ACTIVE" ? (
                          <Button size="sm" variant="danger" onClick={() => void revoke(d)}>Revoke</Button>
                        ) : (
                          <Button size="sm" onClick={() => void activate(d)}>Activate</Button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
                {devices.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-400">
                      No devices registered for this event yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {registering && (
        <RegisterDialog
          eventId={event.id}
          onClose={() => setRegistering(false)}
          onRegistered={async (token) => {
            setRegistering(false);
            setNotice(token);
            await load();
          }}
        />
      )}

      {historyFor && (
        <SyncHistoryDialog device={historyFor} onClose={() => setHistoryFor(null)} />
      )}
    </div>
  );
}

function RegisterDialog({
  eventId,
  onClose,
  onRegistered,
}: {
  eventId: string;
  onClose: () => void;
  onRegistered: (tokenNotice: string) => Promise<void>;
}) {
  const [form, setForm] = useState({
    name: "",
    deviceType: "PHONE",
    expiresInHours: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ device: { name: string }; token: string }>("/devices", {
        method: "POST",
        body: {
          eventId,
          name: form.name,
          deviceType: form.deviceType,
          ...(form.expiresInHours ? { expiresInHours: Number(form.expiresInHours) } : {}),
        },
      });
      await onRegistered(
        `Device "${res.device.name}" registered. One-time device token: ${res.token} — shown only once. Enter it on the scanner device during setup.`,
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not register device");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 font-serif text-xl font-bold">Register scanner device</h2>
        <form onSubmit={submit} className="grid gap-3">
          <Field label="Device name" hint="Must be unique per event; used in reports and sync.">
            <input required className={inputClass} value={form.name} placeholder="iPad — Main Gate"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Device type">
            <select className={inputClass} value={form.deviceType}
              onChange={(e) => setForm({ ...form, deviceType: e.target.value })}>
              <option value="PHONE">Phone</option>
              <option value="TABLET">Tablet</option>
              <option value="KIOSK">Kiosk</option>
            </select>
          </Field>
          <Field label="Authorization expires in (hours, optional)" hint="Leave empty for no expiry.">
            <input type="number" min={1} max={720} className={inputClass} value={form.expiresInHours}
              onChange={(e) => setForm({ ...form, expiresInHours: e.target.value })} />
          </Field>
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Registering…" : "Register device"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SyncHistoryDialog({ device, onClose }: { device: DeviceRow; onClose: () => void }) {
  const [operations, setOperations] = useState<SyncOperation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ operations: SyncOperation[] }>(`/devices/${device.id}/sync-history`)
      .then((data) => setOperations(data.operations))
      .catch((err) =>
        setError(err instanceof ApiRequestError ? err.message : "Could not load sync history"),
      );
  }, [device.id]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 font-serif text-xl font-bold">Sync history — {device.name}</h2>
        <p className="mb-4 text-xs text-gray-400">
          Retained offline operations, including rejected ones (evidence per offline policy).
        </p>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {operations === null && !error && <Spinner label="Loading history…" />}
        {operations && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                <th className="py-2">Received</th>
                <th className="py-2">Result</th>
                <th className="py-2">Gate</th>
                <th className="py-2">Client time</th>
                <th className="py-2">Check-in</th>
              </tr>
            </thead>
            <tbody>
              {operations.map((o) => (
                <tr key={o.id} className="border-b border-gray-50">
                  <td className="py-2 text-xs">{new Date(o.receivedAt).toLocaleString()}</td>
                  <td className="py-2"><StatusBadge status={o.status} /></td>
                  <td className="py-2 text-xs">{o.gate ?? "—"}</td>
                  <td className="py-2 text-xs text-gray-500">
                    {new Date(o.clientTimestamp).toLocaleTimeString()}
                  </td>
                  <td className="py-2 text-xs">
                    {o.checkIn ? `admitted ${new Date(o.checkIn.scannedAt).toLocaleTimeString()}` : "—"}
                  </td>
                </tr>
              ))}
              {operations.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-gray-400">
                  No offline operations synced from this device yet.
                </td></tr>
              )}
            </tbody>
          </table>
        )}
        <div className="mt-4 text-right">
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
