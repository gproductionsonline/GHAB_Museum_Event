"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Field, inputClass, Spinner, StatusBadge } from "@/components/ui";

type UserRow = {
  id: string;
  email: string;
  name: string;
  active: boolean;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
};

type RoleInfo = { code: string; name: string; permissions: string[] };
type PermissionInfo = { code: string; name: string };

export default function UsersPage() {
  const { isAdmin, user: me } = useAuth();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, r] = await Promise.all([
        api<{ users: UserRow[] }>("/users"),
        api<{ roles: RoleInfo[]; permissions: PermissionInfo[] }>("/users/roles"),
      ]);
      setUsers(u.users);
      setRoles(r.roles);
      setPermissions(r.permissions);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resetPassword(u: UserRow) {
    if (!window.confirm(`Generate a temporary password for ${u.email}? Their current password stops working immediately.`)) return;
    setNotice(null);
    setError(null);
    try {
      const res = await api<{ temporaryPassword: string }>(`/users/${u.id}/reset-password`, {
        method: "POST",
        body: {},
      });
      setNotice(
        `Temporary password for ${u.email}: ${res.temporaryPassword} — shown once. Deliver it to the user securely; they should change it before the event.`,
      );
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not reset password");
    }
  }

  if (!isAdmin) {
    return (
      <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        User management requires an administrator account.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-bold text-gray-900">Users & roles</h1>
          <p className="text-sm text-gray-500">
            Staff accounts, role assignment and password administration.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>+ New user</Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {notice && (
        <p className="rounded-lg bg-blue-50 px-4 py-3 font-mono text-sm text-blue-900">{notice}</p>
      )}
      {loading && <Spinner label="Loading users…" />}

      {!loading && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 uppercase">
                  <th className="px-3 py-2">User</th>
                  <th className="px-3 py-2">Roles</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last login</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <p className="font-medium text-[#0f2a4a]">{u.name}</p>
                      <p className="text-xs text-gray-400">{u.email}</p>
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {u.roles.map((r) => <Badge key={r} tone="blue">{r}</Badge>)}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={u.active ? "ACTIVE" : "DISABLED"} />
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => setEditing(u)}>Edit</Button>
                        <Button size="sm" onClick={() => void resetPassword(u)}>Reset password</Button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Roles & permissions">
        <div className="grid gap-4 md:grid-cols-3">
          {roles.map((r) => (
            <div key={r.code} className="rounded-lg border border-gray-100 p-3">
              <p className="font-semibold text-[#0f2a4a]">{r.code}</p>
              <p className="mb-2 text-xs text-gray-400">{r.name}</p>
              <div className="flex flex-wrap gap-1">
                {r.permissions.map((p) => (
                  <span key={p} className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[10px] text-gray-600">
                    {p}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-400">
          {permissions.length} permissions defined. Roles are database-backed; the server checks
          them on every request.
        </p>
      </Card>

      {creating && (
        <UserDialog
          roles={roles}
          user={null}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false);
            await load();
          }}
        />
      )}
      {editing && (
        <UserDialog
          roles={roles}
          user={editing}
          isSelf={me?.id === editing.id}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

function UserDialog({
  roles,
  user,
  isSelf,
  onClose,
  onSaved,
}: {
  roles: RoleInfo[];
  user: UserRow | null;
  isSelf?: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form, setForm] = useState({
    email: user?.email ?? "",
    name: user?.name ?? "",
    password: "",
    roleCodes: user?.roles.length ? user.roles : ["STAFF"],
    active: user?.active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(code: string) {
    setForm((f) => ({
      ...f,
      roleCodes: f.roleCodes.includes(code)
        ? f.roleCodes.filter((c) => c !== code)
        : [...f.roleCodes, code],
    }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (user) {
        await api(`/users/${user.id}`, {
          method: "PATCH",
          body: {
            name: form.name,
            active: form.active,
            roleCodes: form.roleCodes,
          },
        });
      } else {
        await api("/users", {
          method: "POST",
          body: {
            email: form.email,
            name: form.name,
            password: form.password,
            roleCodes: form.roleCodes,
          },
        });
      }
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Could not save user");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-4 font-serif text-xl font-bold">
          {user ? `Edit — ${user.email}` : "New user"}
        </h2>
        <form onSubmit={submit} className="grid gap-3">
          {!user && (
            <Field label="Email">
              <input required type="email" className={inputClass} value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
          )}
          <Field label="Name">
            <input required className={inputClass} value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          {!user && (
            <Field label="Initial password (min 10 chars)" hint="The user should change it before the event.">
              <input required type="password" minLength={10} className={inputClass} value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          )}
          <div>
            <p className="mb-1 text-xs font-semibold tracking-wide text-gray-600 uppercase">Roles</p>
            <div className="space-y-1">
              {roles.map((r) => (
                <label key={r.code} className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.roleCodes.includes(r.code)}
                    onChange={() => toggleRole(r.code)} />
                  <span className="font-medium">{r.code}</span>
                  <span className="text-xs text-gray-400">{r.name}</span>
                </label>
              ))}
            </div>
          </div>
          {user && (
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.active} disabled={isSelf}
                onChange={(e) => setForm({ ...form, active: e.target.checked })} />
              Active{isSelf ? " (you cannot deactivate your own account)" : ""}
            </label>
          )}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy || form.roleCodes.length === 0}>
              {busy ? "Saving…" : user ? "Save changes" : "Create user"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
