import type { Enums } from "@/server/supabase/database.types";
import { defineStateMachine } from "@/server/workflows/state-machine";

export type ProspectStatus = Enums<"prospect_status">;

/**
 * PRD §4: new → contacted → engaged → proposal_sent → converted / declined /
 * disqualified / archived. Converted means a signed client, not paid or active.
 */
export const prospectStateMachine = defineStateMachine<ProspectStatus>({
  name: "prospect",
  initial: "new",
  transitions: {
    new: ["contacted", "disqualified", "archived"],
    contacted: ["engaged", "declined", "disqualified", "archived"],
    engaged: ["proposal_sent", "declined", "disqualified", "archived"],
    proposal_sent: ["engaged", "converted", "declined", "archived"],
    declined: ["contacted", "archived"],
    disqualified: ["archived"],
    converted: ["archived"],
    archived: [],
  },
});
