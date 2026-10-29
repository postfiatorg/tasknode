import { Lightbulb, Search } from "lucide-react";
import { ToolMenuRow } from "../shell/ShellControls";
import { CHAT_RESEARCH_DESCRIPTION } from "../../../shared/chat-research.js";
import { DECISION_TIERS } from "./decisions-client.js";

export function ResearchMenuItems({ chat, decisionTier, onSelect }) {
  return <>
    <ToolMenuRow disabled={chat?.decisionsAvailable !== true} icon={Lightbulb} label="Decisions"
      onClick={() => onSelect("decision", DECISION_TIERS[decisionTier].note)} />
    <ToolMenuRow disabled={chat?.deepResearchAvailable !== true} icon={Search} label="Deep Research"
      onClick={() => onSelect("research", chat?.deepResearchAtCost
        ? `${CHAT_RESEARCH_DESCRIPTION} At least $0.50 available is required.`
        : "Deep Research runs privately through Corbanu and can take several minutes. You can leave and return to the chat.")} />
  </>;
}
