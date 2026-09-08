"use client";

import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "ghab-scanner";
const DB_VERSION = 1;

export type SnapshotAttendee = {
  h: string; // code hash
  n: string; // display name
  c: string; // category
  p: 0 | 1; // is companion
  g: string | null; // party of
  u: string | null; // checked-in at
};

export type Snapshot = {
  version: string;
  eventId: string;
  eventName: string;
  generatedAt: string;
  signature: string;
  counts: { total: number; active: number };
  attendees: SnapshotAttendee[];
};

export type QueueItem = {
  localId: string;
  codeHash: string;
  gate: string | null;
  clientTimestamp: string;
  queuedAt: string;
};

export type ScanLogItem = {
  at: string;
  result: string;
  name: string | null;
  detail?: string;
  synced: boolean;
};

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("snapshot")) {
          database.createObjectStore("snapshot");
        }
        if (!database.objectStoreNames.contains("queue")) {
          database.createObjectStore("queue", { keyPath: "localId" });
        }
        if (!database.objectStoreNames.contains("log")) {
          const log = database.createObjectStore("log", { keyPath: "at" });
          log.createIndex("at", "at");
        }
      },
    });
  }
  return dbPromise;
}

export async function saveSnapshot(snap: Snapshot) {
  const store = await (await db()).put("snapshot", snap, "current");
  return store;
}

export async function loadSnapshot(): Promise<Snapshot | null> {
  const database = await db();
  return (await database.get("snapshot", "current")) ?? null;
}

export async function clearAll() {
  const database = await db();
  await Promise.all([
    database.clear("snapshot"),
    database.clear("queue"),
    database.clear("log"),
  ]);
}

export async function enqueue(item: QueueItem) {
  const database = await db();
  await database.put("queue", item);
}

export async function listQueue(): Promise<QueueItem[]> {
  const database = await db();
  return database.getAll("queue");
}

export async function dequeue(localIds: string[]) {
  const database = await db();
  const tx = database.transaction("queue", "readwrite");
  await Promise.all(localIds.map((id) => tx.store.delete(id)));
  await tx.done;
}

export async function queueCount(): Promise<number> {
  const database = await db();
  return database.count("queue");
}

export async function addLog(item: ScanLogItem) {
  const database = await db();
  const items = await database.getAll("log");
  const trimmed = [item, ...items].slice(0, 100);
  const tx = database.transaction("log", "readwrite");
  await Promise.all(trimmed.map((l) => tx.store.put(l)));
  await tx.done;
}

export async function listLog(): Promise<ScanLogItem[]> {
  const database = await db();
  const items = await database.getAll("log");
  return items.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 50);
}

/** Mark an attendee as locally used after an offline check-in. */
export async function markLocalUsed(codeHash: string) {
  const snap = await loadSnapshot();
  if (!snap) return;
  const attendee = snap.attendees.find((a) => a.h === codeHash);
  if (attendee && !attendee.u) {
    attendee.u = new Date().toISOString();
    await saveSnapshot(snap);
  }
}
