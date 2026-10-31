// Shapes of the role administration API (src/app/api/roles/**).
import type { RolePerm } from './model';

export interface RoleSummary {
  id: string; code: string; name: string; description: string; status: string; status_reason: string | null;
  status_changed_at: string | null; status_changed_by_name: string | null; is_system: boolean; db_role_code: string;
  tier_name: string | null; tier_rank: number | null; version: number; created_at: string; updated_at: string;
  created_by_name: string | null; member_count: number; grantable: boolean; permissions: RolePerm[];
}
export interface CatalogueEntry { resource: string; action: string; description: string; is_sensitive: boolean }
export interface Tier { code: string; name: string; description: string; rank: number }
export interface RolesActor {
  id: string; tier: string | null; tierRank: number; holds: Record<string, string>;
  can: { create: boolean; update: boolean; delete: boolean; managePermissions: boolean; reviewRead: boolean; reviewWrite: boolean };
}
export interface RolesPayload { roles: RoleSummary[]; catalogue: CatalogueEntry[]; tiers: Tier[]; scopes: string[]; actor: RolesActor }
