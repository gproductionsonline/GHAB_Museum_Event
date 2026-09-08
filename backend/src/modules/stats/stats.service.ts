import { prisma } from "../../lib/prisma.js";
import { broadcast } from "../../lib/sse.js";

// Dashboard aggregation uses grouped/count queries only — never full-table
// scans (see ARCHITECTURE.md "Scalability and observability").
export type EventStats = {
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
  recent: {
    id: string;
    guest: string;
    category: string;
    gate: string | null;
    method: string;
    scannedAt: string;
  }[];
  syncDevices: { deviceName: string; lastSyncAt: string; applied: number; duplicate: number }[];
  generatedAt: string;
};

export async function computeStats(eventId: string): Promise<EventStats> {
  const [confirmed, checkedInCount, accompanyingCount, pendingEmail, cancelledCount, categoryGroups, gateGroups, checkIns, deviceAgg] =
    await Promise.all([
      prisma.guest.count({ where: { eventId, rsvpStatus: { code: "CONFIRMED" } } }),
      prisma.checkIn.count({ where: { eventId } }),
      prisma.guest.count({
        where: { eventId, parentId: { not: null }, rsvpStatus: { code: "CONFIRMED" } },
      }),
      prisma.guest.count({
        where: {
          eventId,
          parentId: null,
          rsvpStatus: { code: "CONFIRMED" },
          activeCredentialId: { not: null },
          credential: { emailDeliveries: { none: { status: "SENT" } } },
        },
      }),
      prisma.guest.count({
        where: { eventId, rsvpStatus: { code: { in: ["CANCELLED", "DECLINED"] } } },
      }),
      prisma.guest.groupBy({
        by: ["categoryId"],
        where: { eventId, rsvpStatus: { code: "CONFIRMED" } },
        _count: { _all: true },
      }),
      prisma.checkIn.groupBy({
        by: ["gate"],
        where: { eventId },
        _count: { _all: true },
        _max: { scannedAt: true },
      }),
      prisma.checkIn.findMany({
        where: { eventId },
        orderBy: { scannedAt: "desc" },
        take: 15,
        include: { guest: { include: { category: true } } },
      }),
      prisma.device.findMany({
        where: { eventId },
        include: {
          offlineCheckIns: { orderBy: { receivedAt: "desc" }, take: 200, select: { status: true, receivedAt: true } },
        },
      }),
    ]);

  // Checked-in counts per category (single grouped query over check-ins).
  const checkedInByCategory = await prisma.checkIn.groupBy({
    by: ["guestId"],
    where: { eventId },
  });
  const checkedGuests = await prisma.guest.findMany({
    where: { id: { in: checkedInByCategory.map((c) => c.guestId) } },
    select: { categoryId: true },
  });
  const checkedCountByCategory = new Map<string, number>();
  for (const g of checkedGuests) {
    checkedCountByCategory.set(g.categoryId, (checkedCountByCategory.get(g.categoryId) ?? 0) + 1);
  }

  const categories = await prisma.guestCategory.findMany({
    where: { eventId },
    select: { id: true, code: true },
    orderBy: { sort: "asc" },
  });
  const byCategory = categories.map((c) => ({
    category: c.code,
    expected: categoryGroups.find((g) => g.categoryId === c.id)?._count._all ?? 0,
    checkedIn: checkedCountByCategory.get(c.id) ?? 0,
  }));

  // 10-minute buckets over the last 3 hours.
  const now = Date.now();
  const bucketMs = 10 * 60 * 1000;
  const start = Math.floor((now - 3 * 3600 * 1000) / bucketMs) * bucketMs;
  const recentWindow = await prisma.checkIn.findMany({
    where: { eventId, scannedAt: { gte: new Date(start) } },
    select: { scannedAt: true },
  });
  const counts = new Map<number, number>();
  for (const c of recentWindow) {
    const t = Math.floor(c.scannedAt.getTime() / bucketMs) * bucketMs;
    if (t >= start) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const timeline: { bucket: string; count: number }[] = [];
  for (let t = start; t <= now; t += bucketMs) {
    timeline.push({ bucket: new Date(t).toISOString(), count: counts.get(t) ?? 0 });
  }

  return {
    eventId,
    totals: {
      expected: confirmed,
      checkedIn: checkedInCount,
      notArrived: confirmed - checkedInCount,
      accompanying: accompanyingCount,
      pendingEmail,
      cancelled: cancelledCount,
    },
    byCategory,
    byGate: gateGroups
      .map((g) => ({
        gate: g.gate ?? "Unknown gate",
        count: g._count._all,
        lastAt: g._max.scannedAt?.toISOString() ?? null,
      }))
      .sort((a, b) => b.count - a.count),
    timeline,
    recent: checkIns.map((c) => ({
      id: c.id,
      guest:
        c.guest.displayName ??
        [c.guest.title, c.guest.firstName, c.guest.lastName].filter(Boolean).join(" "),
      category: c.guest.category.code,
      gate: c.gate,
      method: c.method,
      scannedAt: c.scannedAt.toISOString(),
    })),
    syncDevices: deviceAgg.map((d) => ({
      deviceName: d.name,
      lastSyncAt: d.offlineCheckIns[0]?.receivedAt.toISOString() ?? d.lastSeenAt?.toISOString() ?? new Date(0).toISOString(),
      applied: d.offlineCheckIns.filter((o) => o.status === "APPLIED").length,
      duplicate: d.offlineCheckIns.filter((o) => o.status === "ALREADY_CHECKED_IN").length,
    })),
    generatedAt: new Date().toISOString(),
  };
}

export async function broadcastStats(eventId: string): Promise<void> {
  const stats = await computeStats(eventId);
  broadcast(eventId, "stats", stats);
}

// ---------------------------------------------------------------------------
// Debounced dashboard updates (production hardening): a burst of admissions
// no longer recomputes full event statistics synchronously inside each scan
// response. Updates coalesce per event; the dashboard lags at most
// STATS_DEBOUNCE_MS behind the database, which is always authoritative.
// ---------------------------------------------------------------------------
const STATS_DEBOUNCE_MS = Number(process.env.STATS_DEBOUNCE_MS ?? 500);

const pendingTimers = new Map<string, NodeJS.Timeout>();

export function scheduleStatsBroadcast(eventId: string): void {
  const existing = pendingTimers.get(eventId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingTimers.delete(eventId);
    broadcastStats(eventId).catch(() => {
      /* dashboard refresh failure never affects admission */
    });
  }, STATS_DEBOUNCE_MS);
  pendingTimers.set(eventId, timer);
}
