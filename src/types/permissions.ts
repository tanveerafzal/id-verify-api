export const PERMISSIONS = {
  // Verification Permissions
  VIEW_VERIFICATIONS: 'view_verifications',
  REQUEST_VERIFICATIONS: 'request_verifications',
  MANAGE_VERIFICATIONS: 'manage_verifications',

  // Team Permissions
  VIEW_TEAM: 'view_team',
  INVITE_TEAM: 'invite_team',
  MANAGE_TEAM: 'manage_team',

  // Settings Permissions
  VIEW_SETTINGS: 'view_settings',
  MANAGE_SETTINGS: 'manage_settings',

  // Role Permissions
  VIEW_ROLES: 'view_roles',
  MANAGE_ROLES: 'manage_roles',

  // Dashboard/Analytics
  VIEW_DASHBOARD: 'view_dashboard',
  VIEW_ANALYTICS: 'view_analytics',

  // API Access
  VIEW_API_CREDENTIALS: 'view_api_credentials',
  REGENERATE_API_CREDENTIALS: 'regenerate_api_credentials',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const DEFAULT_ROLES = {
  ADMIN: {
    name: 'admin',
    description: 'Full access to all features',
    permissions: Object.values(PERMISSIONS),
  },
  MANAGER: {
    name: 'manager',
    description: 'Can manage verifications and team',
    permissions: [
      PERMISSIONS.VIEW_DASHBOARD,
      PERMISSIONS.VIEW_VERIFICATIONS,
      PERMISSIONS.REQUEST_VERIFICATIONS,
      PERMISSIONS.MANAGE_VERIFICATIONS,
      PERMISSIONS.VIEW_TEAM,
      PERMISSIONS.INVITE_TEAM,
      PERMISSIONS.VIEW_SETTINGS,
    ],
  },
  VIEWER: {
    name: 'viewer',
    description: 'View-only access to verifications',
    permissions: [PERMISSIONS.VIEW_DASHBOARD, PERMISSIONS.VIEW_VERIFICATIONS],
  },
  OPERATOR: {
    name: 'operator',
    description: 'Can request and manage verifications',
    permissions: [
      PERMISSIONS.VIEW_DASHBOARD,
      PERMISSIONS.VIEW_VERIFICATIONS,
      PERMISSIONS.REQUEST_VERIFICATIONS,
      PERMISSIONS.MANAGE_VERIFICATIONS,
    ],
  },
};
