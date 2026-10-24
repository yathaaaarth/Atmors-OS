// Hand-maintained until a hosted project is linked; regenerate with
// `npm run db:types` and keep this file in sync with supabase/migrations.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

type MemberRole = "ceo" | "cto_coo" | "delivery";
type MemberStatus = "invited" | "active" | "suspended" | "revoked";
type ProfileStatus = "active" | "disabled";
type ActorType = "user" | "client" | "system";
type ProspectStatus =
  | "new"
  | "contacted"
  | "engaged"
  | "proposal_sent"
  | "converted"
  | "declined"
  | "disqualified"
  | "archived";

type OrganizationMembershipRow = {
  id: string;
  organization_id: string;
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  created_at: string;
  updated_at: string;
};

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
  public: {
    Tables: {
      organizations: {
        Row: {
          id: string;
          name: string;
          slug: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          slug: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          slug?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          email: string | null;
          display_name: string;
          status: ProfileStatus;
          timezone: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string;
          status?: ProfileStatus;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string | null;
          display_name?: string;
          status?: ProfileStatus;
          timezone?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      organization_memberships: {
        Row: OrganizationMembershipRow;
        Insert: {
          id?: string;
          organization_id: string;
          user_id: string;
          role: MemberRole;
          status?: MemberStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          user_id?: string;
          role?: MemberRole;
          status?: MemberStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_memberships_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_memberships_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      role_permissions: {
        Row: {
          role: MemberRole;
          permission_key: string;
          allowed: boolean;
          policy_version: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          role: MemberRole;
          permission_key: string;
          allowed?: boolean;
          policy_version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          role?: MemberRole;
          permission_key?: string;
          allowed?: boolean;
          policy_version?: number;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      prospects: {
        Row: {
          id: string;
          organization_id: string;
          owner_user_id: string;
          name: string;
          company: string | null;
          email: string | null;
          normalized_email: string | null;
          contact_channel: string;
          contact_handle: string | null;
          source: string | null;
          target_service: string | null;
          notes: string | null;
          status: ProspectStatus;
          next_action_at: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          organization_id: string;
          owner_user_id: string;
          name: string;
          company?: string | null;
          email?: string | null;
          contact_channel?: string;
          contact_handle?: string | null;
          source?: string | null;
          target_service?: string | null;
          notes?: string | null;
          status?: ProspectStatus;
          next_action_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          organization_id?: string;
          owner_user_id?: string;
          name?: string;
          company?: string | null;
          email?: string | null;
          contact_channel?: string;
          contact_handle?: string | null;
          source?: string | null;
          target_service?: string | null;
          notes?: string | null;
          status?: ProspectStatus;
          next_action_at?: string | null;
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_logs: {
        Row: {
          id: string;
          organization_id: string | null;
          actor_type: ActorType;
          actor_id: string | null;
          action: string;
          entity_type: string;
          entity_id: string | null;
          before_summary: Json | null;
          after_summary: Json | null;
          reason: string | null;
          correlation_id: string;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          actor_type: ActorType;
          actor_id?: string | null;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          before_summary?: Json | null;
          after_summary?: Json | null;
          reason?: string | null;
          correlation_id: string;
          occurred_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      workflow_events: {
        Row: {
          id: string;
          organization_id: string | null;
          aggregate_type: string;
          aggregate_id: string;
          event_type: string;
          payload_json: Json;
          source: string;
          correlation_id: string;
          occurred_at: string;
        };
        Insert: {
          id?: string;
          organization_id?: string | null;
          aggregate_type: string;
          aggregate_id: string;
          event_type: string;
          payload_json?: Json;
          source: string;
          correlation_id: string;
          occurred_at?: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      update_membership: {
        Args: {
          p_membership_id: string;
          p_role?: MemberRole;
          p_status?: MemberStatus;
          p_reason?: string;
          p_correlation_id?: string;
        };
        Returns: OrganizationMembershipRow;
      };
    };
    Enums: {
      member_role: MemberRole;
      member_status: MemberStatus;
      profile_status: ProfileStatus;
      actor_type: ActorType;
      prospect_status: ProspectStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];
