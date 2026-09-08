"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Html5Qrcode } from "html5-qrcode";
import { api, ApiRequestError, getUser } from "@/lib/api";
import type { Event } from "@/lib/auth";
import {
  addLog,
  clearAll,
  dequeue,
  enqueue,
  listLog,
  listQueue,
  loadSnapshot,
  markLocalUsed,
  queueCount,
  saveSnapshot,
  type QueueItem,
  type ScanLogItem,
  type Snapshot,
  type SnapshotAttendee,
} from "@/lib/scanner-db";
import { extractCode, sha256Hex, verifyLocal } from "@/lib/scanner";

type Phase = "loading" | "setup" | "scan";
type Banner =
  | { tone: "ok" | "warn" | "err"; title: string; name: string | null; detail?: string; at: string }
  | null;

type SyncState = {
  online: boolean;
  syncing: boolean;
  queued: number;
  lastSyncAt: string | null;
};

/** POST /checkin/scan and /checkin/manual response. */
type ServerOutcome = {
  result: string;
  operationId: string;
  guest?: {
    id: string;
    displayName: string;
    category: string;
    isCompanion: boolean;
    partyOf?: string | null;
  };
  alreadyAt?: string;
};

/** A manual-search candidate from either the server guest list or the local snapshot. */
type ManualCandidate = {
  key: string;
  guestId?: string; // present when found via the server
  codeHash?: string; // present when found via the local snapshot
  name: string;
  category: string;
  isCompanion: boolean;
  partyOf: string | null;
  checkedInAt: string | null;
};

const SETUP_KEY = "ghab_scanner_setup";

export default function ScannerPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("loading");
  const [events, setEvents] = useState<Event[]>([]);
  const [event, setEvent] = useState<Event | null>(null);
  const [gate, setGate] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [manualQuery, setManualQuery] = useState("");
  const [manualResults, setManualResults] = useState<ManualCandidate[]>([]);
  const [manualBusy, setManualBusy] = useState(false);
  const [selected, setSelected] = useState<ManualCandidate | null>(null);
  const [logItems, setLogItems] = useState<ScanLogItem[]>([]);
  const [sync, setSync] = useState<SyncState>({ online: true, syncing: false, queued: 0, lastSyncAt: null });
  const [cameraError, setCameraError] = useState<string | null>(null);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const runningRef = useRef(false);
  const lastScanRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  function readSetup() {
    try {
      return JSON.parse(localStorage.getItem(SETUP_KEY) ?? "{}") as {
        gate?: string;
        deviceName?: string;
        eventId?: string;
      };
    } catch {
      return {};
    }
  }

  // ---------- bootstrap ----------
  useEffect(() => {
    const user = getUser();
    if (!user) {
      router.replace("/login");
      return;
    }
    (async () => {
      try {
        const data = await api<{ events: Event[] }>("/events");
        setEvents(data.events);
        const setup = readSetup();
        const chosen = data.events.find((e) => e.id === setup.eventId) ?? data.events[0] ?? null;
        setEvent(chosen);
        setGate(setup.gate ?? chosen?.gates[0]?.name ?? "");
        setDeviceName(setup.deviceName ?? "");
        const snap = await loadSnapshot();
        setSnapshot(snap);
        setLogItems(await listLog());
        const queued = await queueCount();
        setSync((s) => ({ ...s, queued }));
      } catch {
        /* server unreachable — still allow offline scanning with cached snapshot */
        const snap = await loadSnapshot();
        setSnapshot(snap);
        const setup = readSetup();
        setGate(setup.gate ?? "");
        setDeviceName(setup.deviceName ?? "");
      } finally {
        setPhase("setup");
      }
    })();
  }, [router]);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  // ---------- snapshot ----------
  const downloadSnapshot = useCallback(
    async (eventId: string): Promise<boolean> => {
      setSnapshotBusy(true);
      try {
        const snap = await api<Snapshot>(`/sync/snapshot?eventId=${eventId}`);
        await saveSnapshot(snap);
        setSnapshot(snap);
        return true;
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 304) return true;
        setCameraError(
          err instanceof ApiRequestError
            ? `Snapshot download failed: ${err.message}`
            : "Snapshot download failed — check connection. You can still scan with an existing snapshot.",
        );
        return false;
      } finally {
        setSnapshotBusy(false);
      }
    },
    [],
  );

  // ---------- banners & logging ----------
  const showBanner = useCallback((b: Banner) => {
    setBanner(b);
    setTimeout(() => setBanner((cur) => (cur && b && cur.at === b.at ? null : cur)), 6000);
  }, []);

  const recordLog = useCallback(
    async (at: string, result: string, name: string | null, synced: boolean) => {
      await addLog({ at, result, name, synced });
      setLogItems(await listLog());
    },
    [],
  );

  /** Map a server check-in outcome to the operator banner. */
  const handleServerOutcome = useCallback(
    async (outcome: ServerOutcome, at: string, method: "QR" | "MANUAL", codeHash?: string) => {
      const name = outcome.guest?.displayName ?? null;
      const detailParts = [
        outcome.guest?.category?.replace(/_/g, " "),
        outcome.guest?.partyOf ? `party of ${outcome.guest.partyOf}` : null,
      ].filter(Boolean);
      switch (outcome.result) {
        case "CHECKED_IN": {
          if (codeHash) {
            await markLocalUsed(codeHash);
            setSnapshot(await loadSnapshot());
          }
          showBanner({
            tone: "ok",
            title: "ADMIT",
            name,
            detail: detailParts.join(" · "),
            at,
          });
          vibrate([60]);
          await recordLog(at, method === "MANUAL" ? "CHECKED_IN_MANUAL" : "CHECKED_IN", name, true);
          break;
        }
        case "ALREADY_USED": {
          showBanner({
            tone: "err",
            title: "ALREADY USED",
            name,
            detail: outcome.alreadyAt
              ? `Checked in at ${new Date(outcome.alreadyAt).toLocaleTimeString()}`
              : "Already checked in on another device",
            at,
          });
          vibrate([200, 100, 200]);
          await recordLog(at, "ALREADY_USED", name, true);
          break;
        }
        case "CANCELLED": {
          showBanner({ tone: "err", title: "CANCELLED", name, detail: "Guest cancelled — do not admit", at });
          vibrate([200, 100, 200]);
          await recordLog(at, "CANCELLED", name, true);
          break;
        }
        case "REPLACED": {
          showBanner({
            tone: "err",
            title: "REPLACED",
            name,
            detail: "A newer credential was issued — ask for the guest's latest email",
            at,
          });
          vibrate([200, 100, 200]);
          await recordLog(at, "REPLACED", name, true);
          break;
        }
        case "GUEST_CANCELLED": {
          showBanner({
            tone: "err",
            title: "GUEST CANCELLED",
            name,
            detail: "Guest was cancelled after this credential was issued",
            at,
          });
          vibrate([200, 100, 200]);
          await recordLog(at, "GUEST_CANCELLED", name, true);
          break;
        }
        default: {
          showBanner({
            tone: "err",
            title: method === "MANUAL" ? "NO CREDENTIAL" : "INVALID CODE",
            name,
            detail:
              method === "MANUAL"
                ? "No active QR credential for this guest — use the printed door list"
                : "Not on this event's guest list",
            at,
          });
          vibrate([200, 100, 200]);
          await recordLog(at, "INVALID", name, true);
          break;
        }
      }
    },
    [recordLog, showBanner],
  );

  // ---------- check-in ----------
  /** Online-first: the server is authoritative; on network loss fall back to
   *  local snapshot verification + the offline queue. */
  const processCode = useCallback(
    async (code: string) => {
      const now = Date.now();
      if (lastScanRef.current.code === code && now - lastScanRef.current.at < 4000) return;
      lastScanRef.current = { code, at: now };

      const at = new Date().toISOString();
      if (navigator.onLine && event) {
        try {
          const outcome = await api<ServerOutcome>("/checkin/scan", {
            method: "POST",
            body: {
              eventId: event.id,
              code,
              gate: gate || null,
              deviceName: deviceName || null,
              operationId: crypto.randomUUID(),
              clientTimestamp: at,
            },
          });
          const hash = await sha256Hex(code);
          await handleServerOutcome(outcome, at, "QR", hash);
          return;
        } catch (err) {
          if (err instanceof ApiRequestError) {
            if (err.status === 401) {
              showBanner({ tone: "err", title: "SIGN-IN EXPIRED", name: null, detail: "Return to setup and sign in again", at });
            } else {
              showBanner({ tone: "err", title: "SCAN FAILED", name: null, detail: err.message, at });
            }
            vibrate([200, 100, 200]);
            await recordLog(at, "ERROR", null, true);
            return;
          }
          /* network unreachable — fall through to the offline path */
        }
      }

      const hash = await sha256Hex(code);
      const snap = snapshot ?? (await loadSnapshot());
      if (!snap) {
        showBanner({ tone: "err", title: "NO SNAPSHOT", name: null, detail: "Download the guest list before scanning", at });
        vibrate([200]);
        return;
      }
      const outcome = verifyLocal(hash, snap.attendees);

      if (outcome.kind === "CHECKED_IN") {
        const item: QueueItem = {
          localId: crypto.randomUUID(),
          codeHash: hash,
          gate: gate || null,
          clientTimestamp: at,
          queuedAt: at,
        };
        await enqueue(item);
        await markLocalUsed(hash);
        snap.attendees.find((a) => a.h === hash)!.u = at;
        setSnapshot({ ...snap });
        showBanner({
          tone: "ok",
          title: "ADMIT (OFFLINE)",
          name: outcome.attendee.n,
          detail: [outcome.attendee.c.replace(/_/g, " "), outcome.attendee.g ? `party of ${outcome.attendee.g}` : null]
            .filter(Boolean)
            .join(" · "),
          at,
        });
        vibrate([60]);
      } else if (outcome.kind === "ALREADY_USED") {
        showBanner({
          tone: "err",
          title: "ALREADY USED",
          name: outcome.attendee.n,
          detail: `Checked in at ${new Date(outcome.attendee.u!).toLocaleTimeString()}`,
          at,
        });
        vibrate([200, 100, 200]);
      } else {
        showBanner({ tone: "err", title: "INVALID CODE", name: null, detail: "Not on this event's guest list", at });
        vibrate([200, 100, 200]);
      }

      await recordLog(
        at,
        outcome.kind,
        "attendee" in outcome ? outcome.attendee.n : null,
        false,
      );
      setSync((s) => ({ ...s, queued: s.queued + (outcome.kind === "CHECKED_IN" ? 1 : 0) }));
    },
    [event, gate, deviceName, snapshot, handleServerOutcome, recordLog, showBanner],
  );

  const onScanText = useCallback(
    (text: string) => {
      const code = extractCode(text);
      if (!code) {
        showBanner({ tone: "err", title: "UNRECOGNISED QR", name: null, at: new Date().toISOString() });
        vibrate([200, 100, 200]);
        return;
      }
      void processCode(code);
    },
    [processCode, showBanner],
  );

  /** Manual check-in: online guests check in via the server; snapshot guests
   *  queue locally by code hash. Two-step confirmation guards mis-taps. */
  const manualCheckIn = useCallback(
    async (candidate: ManualCandidate) => {
      setSelected(null);
      setManualQuery("");
      setManualResults([]);
      const at = new Date().toISOString();
      if (candidate.checkedInAt) {
        showBanner({
          tone: "err",
          title: "ALREADY USED",
          name: candidate.name,
          detail: `Checked in at ${new Date(candidate.checkedInAt).toLocaleTimeString()}`,
          at,
        });
        vibrate([200, 100, 200]);
        await recordLog(at, "ALREADY_USED", candidate.name, true);
        return;
      }

      setManualBusy(true);
      try {
        if (navigator.onLine && event && candidate.guestId) {
          try {
            const outcome = await api<ServerOutcome>("/checkin/manual", {
              method: "POST",
              body: {
                eventId: event.id,
                guestId: candidate.guestId,
                gate: gate || null,
                deviceName: deviceName || null,
                operationId: crypto.randomUUID(),
              },
            });
            await handleServerOutcome(outcome, at, "MANUAL", candidate.codeHash);
            return;
          } catch (err) {
            if (err instanceof ApiRequestError) {
              if (err.status === 401) {
                showBanner({ tone: "err", title: "SIGN-IN EXPIRED", name: null, detail: "Return to setup and sign in again", at });
              } else {
                showBanner({ tone: "err", title: "CHECK-IN FAILED", name: candidate.name, detail: err.message, at });
              }
              vibrate([200, 100, 200]);
              await recordLog(at, "ERROR", candidate.name, true);
              return;
            }
            /* network lost — fall back to the local queue if we have a hash */
            if (!candidate.codeHash) {
              showBanner({ tone: "err", title: "NETWORK LOST", name: candidate.name, detail: "Connection dropped — retry the search", at });
              vibrate([200, 100, 200]);
              return;
            }
          }
        }

        if (!candidate.codeHash) {
          showBanner({ tone: "err", title: "OFFLINE", name: null, detail: "No snapshot on this device — reconnect to check in by name", at });
          vibrate([200]);
          return;
        }
        const snap = snapshot ?? (await loadSnapshot());
        const item: QueueItem = {
          localId: crypto.randomUUID(),
          codeHash: candidate.codeHash,
          gate: gate || null,
          clientTimestamp: at,
          queuedAt: at,
        };
        await enqueue(item);
        await markLocalUsed(candidate.codeHash);
        if (snap) {
          const attendee = snap.attendees.find((a) => a.h === candidate.codeHash);
          if (attendee) attendee.u = at;
          setSnapshot({ ...snap });
        }
        showBanner({
          tone: "ok",
          title: "ADMIT (MANUAL, OFFLINE)",
          name: candidate.name,
          detail: candidate.category.replace(/_/g, " "),
          at,
        });
        vibrate([60]);
        await recordLog(at, "CHECKED_IN_MANUAL", candidate.name, false);
        setSync((s) => ({ ...s, queued: s.queued + 1 }));
      } finally {
        setManualBusy(false);
      }
    },
    [event, gate, deviceName, snapshot, handleServerOutcome, recordLog, showBanner],
  );

  // ---------- sync ----------
  const syncNow = useCallback(async () => {
    if (!event) return;
    const queue = await listQueue();
    if (queue.length === 0) return;
    setSync((s) => ({ ...s, syncing: true }));
    try {
      const result = await api<{
        batchId: string;
        applied: number;
        duplicate: number;
        rejected: number;
        results: { localId: string; result: string }[];
      }>("/sync/checkins", {
        method: "POST",
        body: {
          eventId: event.id,
          deviceId: deviceName || "unnamed",
          deviceName: deviceName || "Unnamed device",
          items: queue.map((q) => ({
            localId: q.localId,
            codeHash: q.codeHash,
            gate: q.gate,
            clientTimestamp: q.clientTimestamp,
          })),
        },
      });
      const doneIds = result.results.map((r) => r.localId);
      await dequeue(doneIds);
      const queued = await queueCount();
      setSync((s) => ({
        ...s,
        queued,
        syncing: false,
        lastSyncAt: new Date().toISOString(),
      }));
    } catch {
      setSync((s) => ({ ...s, syncing: false }));
    }
  }, [event, deviceName]);

  useEffect(() => {
    const tick = () => setSync((s) => ({ ...s, online: navigator.onLine }));
    window.addEventListener("online", tick);
    window.addEventListener("offline", tick);
    setSync((s) => ({ ...s, online: navigator.onLine }));
    return () => {
      window.removeEventListener("online", tick);
      window.removeEventListener("offline", tick);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (navigator.onLine) void syncNow();
    }, 30000);
    const onOnline = () => void syncNow();
    window.addEventListener("online", onOnline);
    return () => {
      clearInterval(interval);
      window.removeEventListener("online", onOnline);
    };
  }, [syncNow]);

  // ---------- camera ----------
  const startCamera = useCallback(async () => {
    setCameraError(null);
    const el = document.getElementById("reader");
    if (!el) return;
    const scanner = new Html5Qrcode("reader");
    scannerRef.current = scanner;
    runningRef.current = true;
    try {
      await scanner.start(
        { facingMode: "environment" },
        { fps: 8, qrbox: { width: 240, height: 240 } },
        (text) => onScanText(text),
        () => {},
      );
    } catch {
      runningRef.current = false;
      setCameraError(
        "Camera unavailable. Use manual guest search below, or check camera permissions (HTTPS required).",
      );
    }
  }, [onScanText]);

  const stopCamera = useCallback(async () => {
    if (scannerRef.current && runningRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch {
        /* ignore */
      }
    }
    runningRef.current = false;
  }, []);

  useEffect(() => {
    if (phase !== "scan") return;
    void startCamera();
    return () => {
      void stopCamera();
    };
  }, [phase, startCamera, stopCamera]);

  // keep the screen awake while scanning
  useEffect(() => {
    let cancelled = false;
    const acquire = async () => {
      if (!("wakeLock" in navigator) || wakeLockRef.current) return;
      try {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
      } catch {
        /* not supported */
      }
    };
    if (phase === "scan") void acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible" && phase === "scan" && !cancelled) void acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [phase]);

  // manual search: server guest list when online, local snapshot otherwise
  const searchManual = useCallback(
    async (q: string) => {
      if (navigator.onLine && event) {
        try {
          const data = await api<{
            guests: {
              id: string;
              name: string;
              category: string;
              isCompanion: boolean;
              partyOf: string | null;
              checkIn: { scannedAt: string } | null;
            }[];
          }>(`/guests?eventId=${event.id}&q=${encodeURIComponent(q)}&pageSize=8`);
          setManualResults(
            data.guests.map((g) => ({
              key: g.id,
              guestId: g.id,
              name: g.name,
              category: g.category,
              isCompanion: g.isCompanion,
              partyOf: g.partyOf,
              checkedInAt: g.checkIn?.scannedAt ?? null,
              codeHash: snapshot?.attendees.find((a) => a.n === g.name)?.h,
            })),
          );
          return;
        } catch {
          /* fall back to the local snapshot */
        }
      }
      if (!snapshot) {
        setManualResults([]);
        return;
      }
      const lq = q.toLowerCase();
      setManualResults(
        snapshot.attendees
          .filter((a) => a.n.toLowerCase().includes(lq))
          .slice(0, 6)
          .map((a) => ({
            key: a.h,
            codeHash: a.h,
            name: a.n,
            category: a.c,
            isCompanion: a.p === 1,
            partyOf: a.g,
            checkedInAt: a.u,
          })),
      );
    },
    [event, snapshot],
  );

  useEffect(() => {
    const q = manualQuery.trim();
    if (!q) {
      setManualResults([]);
      setSelected(null);
      return;
    }
    const t = setTimeout(() => void searchManual(q), 300);
    return () => clearTimeout(t);
  }, [manualQuery, searchManual, sync.online]);

  function beginScanning() {
    if (!event || !gate) return;
    localStorage.setItem(SETUP_KEY, JSON.stringify({ eventId: event.id, gate, deviceName }));
    setPhase("scan");
  }

  async function refreshSnapshot() {
    if (!event) return;
    const ok = await downloadSnapshot(event.id);
    if (ok) setCameraError(null);
  }

  async function resetDevice() {
    await stopCamera();
    await clearAll();
    setSnapshot(null);
    setLogItems([]);
    setSync({ online: navigator.onLine, syncing: false, queued: 0, lastSyncAt: null });
    setPhase("setup");
  }

  // ---------- render ----------
  if (phase === "loading") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0f2a4a]">
        <p className="text-sm text-blue-200">Loading scanner…</p>
      </main>
    );
  }

  if (phase === "setup") {
    return (
      <main className="min-h-screen bg-[#0f2a4a] px-4 py-8 text-white">
        <div className="mx-auto max-w-md space-y-5">
          <header className="text-center">
            <p className="text-xs font-semibold tracking-[0.3em] text-[#d4af37] uppercase">Government House</p>
            <h1 className="mt-1 font-serif text-2xl font-bold">Admission Scanner</h1>
          </header>

          {cameraError && (
            <p className="rounded-lg bg-amber-500/20 px-4 py-3 text-sm text-amber-200">{cameraError}</p>
          )}

          <section className="space-y-4 rounded-xl bg-white/10 p-5">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-blue-200 uppercase">Event</span>
              <select
                value={event?.id ?? ""}
                onChange={(e) => {
                  const chosen = events.find((ev) => ev.id === e.target.value) ?? null;
                  setEvent(chosen);
                  setGate(chosen?.gates[0]?.name ?? "");
                }}
                className="w-full rounded-lg border border-white/20 bg-[#0f2a4a] px-3 py-2 text-sm"
              >
                {events.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
                {events.length === 0 && <option>— no events reachable —</option>}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-blue-200 uppercase">Gate / door</span>
              <select
                value={gate}
                onChange={(e) => setGate(e.target.value)}
                className="w-full rounded-lg border border-white/20 bg-[#0f2a4a] px-3 py-2 text-sm"
              >
                {(event?.gates ?? []).map((g) => (
                  <option key={g.id} value={g.name}>{g.name}</option>
                ))}
                <option value="">Other / unspecified</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-blue-200 uppercase">Device name (for reports)</span>
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. iPad — Main Gate"
                className="w-full rounded-lg border border-white/20 bg-[#0f2a4a] px-3 py-2 text-sm placeholder:text-blue-300/50"
              />
            </label>
          </section>

          <section className="rounded-xl bg-white/10 p-5 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-semibold">Guest list snapshot</span>
              <button onClick={() => void refreshSnapshot()} disabled={snapshotBusy}
                className="rounded-lg bg-[#d4af37] px-3 py-1.5 text-xs font-bold text-[#0f2a4a] disabled:bg-gray-500">
                {snapshotBusy ? "Downloading…" : snapshot ? "Refresh" : "Download"}
              </button>
            </div>
            {snapshot ? (
              <p className="mt-2 text-blue-100">
                {snapshot.counts.active} guests · updated{" "}
                {new Date(snapshot.generatedAt).toLocaleTimeString()}
              </p>
            ) : (
              <p className="mt-2 text-amber-300">
                No snapshot on this device. Download while connected — scanning then works
                fully offline.
              </p>
            )}
          </section>

          <button
            onClick={beginScanning}
            disabled={!event || !snapshot}
            className="w-full rounded-xl bg-[#d4af37] py-4 font-serif text-lg font-bold text-[#0f2a4a] disabled:bg-gray-500 disabled:text-gray-300"
          >
            Start scanning
          </button>

          <div className="flex items-center justify-between text-xs text-blue-200/70">
            <span>
              {sync.online ? "● Online" : "● Offline"} · {sync.queued} queued
            </span>
            <button onClick={() => router.push("/login")} className="underline">Switch user</button>
          </div>
        </div>
      </main>
    );
  }

  // phase === "scan"
  const bannerTone =
    banner?.tone === "ok"
      ? "bg-emerald-600"
      : banner?.tone === "warn"
        ? "bg-amber-600"
        : "bg-red-700";

  return (
    <main className="flex min-h-screen flex-col bg-[#0f2a4a] text-white">
      <header className="flex items-center justify-between px-4 py-2 text-xs">
        <button onClick={() => void resetDevice()} className="rounded-lg border border-white/20 px-3 py-1">
          ← Setup
        </button>
        <span className="font-semibold">{gate}</span>
        <span className={sync.online ? "text-emerald-400" : "text-amber-400"}>
          {sync.online ? (sync.syncing ? "syncing…" : "online · server") : "OFFLINE · local"}
          {sync.queued > 0 ? ` · ${sync.queued} queued` : ""}
        </span>
      </header>

      <div className="relative mx-3 overflow-hidden rounded-xl bg-black/40">
        <div id="reader" className="w-full" />
        {!cameraError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-56 w-56 rounded-2xl border-2 border-[#d4af37]/70" />
          </div>
        )}
        {cameraError && (
          <p className="px-4 py-8 text-center text-sm text-amber-300">{cameraError}</p>
        )}
      </div>

      {banner && (
        <div className={`no-select mx-3 mt-3 rounded-xl px-5 py-4 text-center ${bannerTone}`}>
          <p className="font-serif text-2xl font-bold tracking-widest">{banner.title}</p>
          {banner.name && <p className="mt-1 text-lg font-semibold">{banner.name}</p>}
          {banner.detail && <p className="text-xs opacity-80">{banner.detail}</p>}
          <p className="mt-1 text-[10px] opacity-60">{new Date(banner.at).toLocaleTimeString()}</p>
        </div>
      )}

      <div className="mt-3 px-3">
        <input
          value={manualQuery}
          onChange={(e) => setManualQuery(e.target.value)}
          placeholder={`Manual guest search (${sync.online ? "server" : "works offline"})…`}
          className="w-full rounded-lg border border-white/20 bg-white/10 px-3 py-2.5 text-sm placeholder:text-blue-300/50"
        />

        {manualResults.length > 0 && (
          <ul className="mt-2 overflow-hidden rounded-lg border border-white/10 bg-[#12325a] text-sm">
            {manualResults.map((c) => (
              <li key={c.key} className="border-b border-white/10 last:border-0">
                <button
                  onClick={() => setSelected(selected?.key === c.key ? null : c)}
                  className={`flex w-full items-center justify-between px-4 py-3 text-left active:bg-white/10 ${
                    selected?.key === c.key ? "bg-white/10" : ""
                  }`}
                >
                  <span className="font-medium">
                    {c.name}
                    {c.isCompanion ? <span className="text-blue-300"> (accompanying)</span> : null}
                  </span>
                  <span className="text-xs">
                    {c.checkedInAt ? (
                      <span className="text-amber-400">already in {new Date(c.checkedInAt).toLocaleTimeString()}</span>
                    ) : (
                      <span className="text-[#d4af37]">{c.category.replace(/_/g, " ")} → select</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selected && (
          <div className="mt-2 rounded-lg border border-[#d4af37]/60 bg-[#12325a] px-4 py-3">
            <p className="text-sm">
              Check in <b>{selected.name}</b>
              {selected.isCompanion ? " (accompanying guest)" : ""}?
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void manualCheckIn(selected)}
                disabled={manualBusy || Boolean(selected.checkedInAt)}
                className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold disabled:bg-gray-500"
              >
                {manualBusy ? "…" : "Confirm check-in"}
              </button>
              <button
                onClick={() => setSelected(null)}
                className="rounded-lg border border-white/20 px-4 py-2 text-xs font-bold"
              >
                Cancel
              </button>
            </div>
            {selected.checkedInAt && (
              <p className="mt-2 text-xs text-amber-400">
                Already checked in at {new Date(selected.checkedInAt).toLocaleTimeString()} — undo from the admin console if needed.
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 max-h-44 flex-1 overflow-y-auto px-3 pb-4">
        <ul className="space-y-1 text-xs">
          {logItems.map((l) => (
            <li key={l.at} className="flex items-center justify-between rounded bg-white/5 px-3 py-1.5">
              <span>
                <span
                  className={
                    l.result === "CHECKED_IN" || l.result === "CHECKED_IN_MANUAL"
                      ? "font-bold text-emerald-400"
                      : "font-bold text-red-400"
                  }
                >
                  {l.result.replace(/_/g, " ")}
                </span>{" "}
                {l.name}
                {!l.synced && <span className="text-amber-400"> (queued)</span>}
              </span>
              <span className="text-blue-200/60">
                {new Date(l.at).toLocaleTimeString()}
              </span>
            </li>
          ))}
          {logItems.length === 0 && (
            <li className="px-1 text-blue-200/50">No scans yet on this device.</li>
          )}
        </ul>
      </div>

      <footer className="px-4 py-2 text-center text-[10px] text-blue-200/50">
        Online scans verify against the server instantly; offline scans queue locally and
        sync automatically. Queue: {sync.queued}
      </footer>
    </main>
  );
}

function vibrate(pattern: number[]) {
  if ("vibrate" in navigator) navigator.vibrate(pattern);
}
