import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PERMISSIONS = {
  VIEW_VERIFICATIONS: 'view_verifications',
  REQUEST_VERIFICATIONS: 'request_verifications',
  MANAGE_VERIFICATIONS: 'manage_verifications',
  VIEW_TEAM: 'view_team',
  INVITE_TEAM: 'invite_team',
  MANAGE_TEAM: 'manage_team',
  VIEW_SETTINGS: 'view_settings',
  MANAGE_SETTINGS: 'manage_settings',
  VIEW_ROLES: 'view_roles',
  MANAGE_ROLES: 'manage_roles',
  VIEW_DASHBOARD: 'view_dashboard',
  VIEW_ANALYTICS: 'view_analytics',
  VIEW_API_CREDENTIALS: 'view_api_credentials',
  REGENERATE_API_CREDENTIALS: 'regenerate_api_credentials',
};

const DEFAULT_ROLES = [
  {
    name: 'admin',
    description: 'Full access to all features',
    permissions: JSON.stringify(Object.values(PERMISSIONS)),
  },
  {
    name: 'manager',
    description: 'Can manage verifications and team',
    permissions: JSON.stringify([
      PERMISSIONS.VIEW_DASHBOARD,
      PERMISSIONS.VIEW_VERIFICATIONS,
      PERMISSIONS.REQUEST_VERIFICATIONS,
      PERMISSIONS.MANAGE_VERIFICATIONS,
      PERMISSIONS.VIEW_TEAM,
      PERMISSIONS.INVITE_TEAM,
      PERMISSIONS.VIEW_SETTINGS,
    ]),
  },
  {
    name: 'viewer',
    description: 'View-only access to verifications',
    permissions: JSON.stringify([
      PERMISSIONS.VIEW_DASHBOARD,
      PERMISSIONS.VIEW_VERIFICATIONS,
    ]),
  },
  {
    name: 'operator',
    description: 'Can request and manage verifications',
    permissions: JSON.stringify([
      PERMISSIONS.VIEW_DASHBOARD,
      PERMISSIONS.VIEW_VERIFICATIONS,
      PERMISSIONS.REQUEST_VERIFICATIONS,
      PERMISSIONS.MANAGE_VERIFICATIONS,
    ]),
  },
];

async function main() {
  console.log('Seeding default roles...');

  for (const roleData of DEFAULT_ROLES) {
    const role = await prisma.role.upsert({
      where: { name: roleData.name },
      update: {
        description: roleData.description,
        permissions: roleData.permissions,
      },
      create: roleData,
    });
    console.log(`  - Role '${role.name}' seeded`);
  }

  console.log('Seeding complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
