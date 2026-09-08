import { prisma } from "../src/lib/prisma.js";
import { hashPassword } from "../src/lib/auth.js";

const PERMISSIONS: { code: string; name: string }[] = [
  { code: "event:manage", name: "Create and configure events" },
  { code: "category:manage", name: "Manage guest categories" },
  { code: "guest:read", name: "View guests" },
  { code: "guest:write", name: "Create, amend, cancel guests" },
  { code: "credential:read", name: "View credentials" },
  { code: "credential:issue", name: "Issue credentials" },
  { code: "credential:revoke", name: "Revoke credentials" },
  { code: "email:send", name: "Send credential emails" },
  { code: "import:manage", name: "Import guest lists" },
  { code: "checkin:operate", name: "Operate check-in (QR and manual)" },
  { code: "checkin:void", name: "Void (undo) a check-in" },
  { code: "device:manage", name: "Register and revoke devices" },
  { code: "offline:provision", name: "Provision offline packages" },
  { code: "report:export", name: "Export reports" },
  { code: "audit:read", name: "Read audit log" },
  { code: "user:manage", name: "Manage users and roles" },
];

const ROLES: { code: string; name: string; permissions: string[] }[] = [
  {
    code: "ADMIN",
    name: "Administrator",
    permissions: PERMISSIONS.map((p) => p.code), // all permissions
  },
  {
    code: "STAFF",
    name: "Staff",
    // Approved subset per API_DESIGN.md authorization matrix.
    permissions: [
      "guest:read",
      "guest:write",
      "credential:read",
      "credential:issue",
      "credential:revoke",
      "email:send",
      "checkin:operate",
      "checkin:void",
      "report:export",
      "audit:read",
    ],
  },
  {
    code: "CHECKIN_OPERATOR",
    name: "Check-in Operator",
    // Least privilege: gate operation only.
    permissions: ["guest:read", "checkin:operate"],
  },
];

const RSVP_STATUSES = [
  { code: "PENDING", name: "Pending", isFinal: false, sort: 0 },
  { code: "INVITED", name: "Invited", isFinal: false, sort: 1 },
  { code: "CONFIRMED", name: "Confirmed", isFinal: false, sort: 2 },
  { code: "DECLINED", name: "Declined", isFinal: true, sort: 3 },
  { code: "CANCELLED", name: "Cancelled", isFinal: true, sort: 4 },
];

const DEFAULT_CATEGORIES = [
  { code: "VIP", name: "VIP", sort: 0 },
  { code: "OFFICIAL", name: "Official", sort: 1 },
  { code: "STAFF", name: "Staff", sort: 2 },
  { code: "MEDIA", name: "Media", sort: 3 },
  { code: "GENERAL_GUEST", name: "General Guest", sort: 4 },
];

async function main() {
  console.log("Seeding RBAC foundation…");

  // --- Permissions ---
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({ where: { code: p.code }, update: { name: p.name }, create: p });
  }

  // --- Roles + role-permission links ---
  for (const role of ROLES) {
    const created = await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name },
      create: { code: role.code, name: role.name },
    });
    for (const code of role.permissions) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { code } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: created.id, permissionId: permission.id } },
        update: {},
        create: { roleId: created.id, permissionId: permission.id },
      });
    }
  }

  // --- RSVP statuses ---
  for (const status of RSVP_STATUSES) {
    await prisma.rsvpStatus.upsert({
      where: { code: status.code },
      update: { name: status.name, isFinal: status.isFinal, sort: status.sort },
      create: status,
    });
  }

  // --- Users (dev credentials — change before the event) ---
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: "ADMIN" } });
  const staffRole = await prisma.role.findUniqueOrThrow({ where: { code: "STAFF" } });
  const operatorRole = await prisma.role.findUniqueOrThrow({ where: { code: "CHECKIN_OPERATOR" } });

  const users = [
    { email: "admin@ghab.gov", name: "System Administrator", role: adminRole },
    { email: "staff@ghab.gov", name: "Admissions Staff", role: staffRole },
    { email: "scanner@ghab.gov", name: "Gate Scanner", role: operatorRole },
  ];
  for (const u of users) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        name: u.name,
        passwordHash: await hashPassword("ChangeMe123!"),
      },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: u.role.id } },
      update: {},
      create: { userId: user.id, roleId: u.role.id },
    });
  }

  // --- Demo event with gates and configurable categories ---
  const event = await prisma.event.upsert({
    where: { slug: "chogm-welcome-reception" },
    update: {},
    create: {
      name: "CHOGM Welcome Reception",
      slug: "chogm-welcome-reception",
      startsAt: new Date("2026-10-20T18:00:00Z"),
      endsAt: new Date("2026-10-20T21:00:00Z"),
      venue: "Government House",
      status: "SCHEDULED",
      gates: {
        create: [
          { name: "Main Entrance", code: "MAIN_ENTRANCE", sort: 0 },
          { name: "VIP Gate", code: "VIP_GATE", sort: 1 },
          { name: "Media Gate", code: "MEDIA_GATE", sort: 2 },
        ],
      },
    },
  });

  for (const cat of DEFAULT_CATEGORIES) {
    await prisma.guestCategory.upsert({
      where: { eventId_code: { eventId: event.id, code: cat.code } },
      update: {},
      create: { eventId: event.id, ...cat },
    });
  }

  console.log("Seed complete.");
  console.log("  Event:", event.name, event.id);
  console.log("  Users: admin@ghab.gov (ADMIN) / staff@ghab.gov (STAFF) / scanner@ghab.gov (CHECKIN_OPERATOR)");
  console.log("  Password (all users, dev only): ChangeMe123!");
  console.log("  Change these credentials before the event.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
