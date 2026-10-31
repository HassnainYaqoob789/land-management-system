export interface AppUser {
  id: string;
  code: string;
  username: string;
  full_name: string;
  role_code: string;
  position: string;
  department: string | null;
  office_code: string | null;
  email: string | null;
  status: string;
  is_service_account: boolean;
  /** Approval positions held (lms.app_user_group), from /api/auth/me. */
  groups?: string[];
}

export interface ProvinceSummary {
  province_code: string;
  province_name: string;
  display_order: number;
  projects: number;
  active_projects: number;
  parcels: number;
  total_area_acres: number;
  landowners: number;
  live_cases: number;
  approved_cases: number;
  approved_compensation: number;
  released_amount: number;
  active_leases: number;
  leases_expiring_90d: number;
  open_grievances: number;
  open_encroachments: number;
  active_stay_orders: number;
}

export interface Project {
  project_id: string;
  project_code: string;
  project_name: string;
  type_code: string;
  block: string;
  province_code: string;
  status: string;
  district_name: string;
  required_area: number;
  linked_parcels: number;
  linked_area: number;
  parcels_held: number;
  live_cases: number;
  approved_cases: number;
  approved_compensation: number;
  released_amount: number;
}

export interface Landowner {
  id: string;
  code: string;
  cnic: string;
  full_name: string;
  father_name: string | null;
  province_code: string;
  district_name?: string;
  filer_status: 'Filer' | 'Non-Filer';
  is_deceased: boolean;
  phone_primary?: string;
  total_parcels?: number;
  total_acres?: number;
}

export interface SurveyParcel {
  id: string;
  code: string;
  province_code: string;
  district_id: string;
  district_name?: string;
  survey_number: string;
  block_number: string | null;
  khasra_number: string | null;
  area_acres: number;
  area_sqft: number;
  status: string;
  total_share_percent: number;
  owners: Array<{
    share_id: string;
    landowner_id: string;
    full_name: string;
    cnic: string;
    share_percent: number;
    area_acres: number;
  }>;
}

export interface CompensationCase {
  id: string;
  code: string;
  project_id: string;
  project_name?: string;
  survey_id: string;
  survey_number?: string;
  case_type: 'Crop' | 'Tree' | 'Land' | 'Structure' | 'Flare Pit' | '50% Past Pending Balance';
  stage: string;
  gross_amount: number;
  tax_amount: number;
  net_payable: number;
  is_50pct_balance: boolean;
  status: string;
  created_at: string;
  created_by_name?: string;
  assigned_designation?: string;
}

export interface LeaseAgreement {
  id: string;
  code: string;
  project_id: string;
  project_name?: string;
  lease_type: string;
  annual_rent: number;
  escalation_rate: number;
  start_date: string;
  end_date: string;
  status: string;
  days_to_expiry?: number;
  lessor_name?: string;
  district_name?: string;
}

export interface RowCorridor {
  id: string;
  code: string;
  project_id: string;
  project_name?: string;
  corridor_name: string;
  diameter_inches: number;
  length_meters: number;
  width_meters: number;
  status: string;
  crop_damage_paid: number;
}

export interface PaymentVoucher {
  id: string;
  code: string;
  case_id: string;
  case_code?: string;
  project_id: string;
  project_name?: string;
  landowner_id: string;
  landowner_name?: string;
  landowner_cnic?: string;
  gross_amount: number;
  wht_rate: number;
  wht_amount: number;
  net_amount: number;
  status: 'Pending' | 'Approved' | 'Released' | 'On Hold';
  voucher_date: string;
}

export interface AuditEvent {
  event_id: string;
  actor_id: string;
  actor_name?: string;
  event_type: string;
  table_name: string;
  record_id: string;
  created_at: string;
  details?: Record<string, any>;
}
