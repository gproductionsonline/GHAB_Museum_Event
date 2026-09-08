"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, clearSession, getUser, getToken, setSession, type StoredUser } from "./api";

export type Event = {
  id: string;
  name: string;
  slug: string | null;
  startsAt: string;
  endsAt: string | null;
  venue: string | null;
  status: string;
  gates: { id: string; name: string; sort: number }[];
  _count?: { guests: number; checkIns: number };
};

const EVENT_KEY = "ghab_event_id";

export function useAuth() {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [ready, setReady] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setUser(getUser());
    setReady(true);
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
    router.push("/login");
  }, [router]);

  return { user, ready, logout, isAdmin: user?.role === "ADMIN" };
}

export function useEvent(): {
  event: Event | null;
  events: Event[];
  setEventId: (id: string) => void;
  refresh: () => Promise<void>;
} {
  const [events, setEvents] = useState<Event[]>([]);
  const [event, setEvent] = useState<Event | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ events: Event[] }>("/events");
      setEvents(data.events);
      const stored = localStorage.getItem(EVENT_KEY);
      const current = data.events.find((e) => e.id === stored) ?? data.events[0] ?? null;
      if (current) localStorage.setItem(EVENT_KEY, current.id);
      setEvent(current);
    } catch {
      setEvents([]);
      setEvent(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setEventId = useCallback(
    (id: string) => {
      localStorage.setItem(EVENT_KEY, id);
      setEvent(events.find((e) => e.id === id) ?? null);
    },
    [events],
  );

  return { event, events, setEventId, refresh: load };
}

export async function login(email: string, password: string): Promise<StoredUser> {
  const data = await api<{ token: string; user: StoredUser }>("/auth/login", {
    method: "POST",
    body: { email, password },
  });
  setSession(data.token, data.user);
  return data.user;
}

export function currentToken(): string | null {
  return getToken();
}
