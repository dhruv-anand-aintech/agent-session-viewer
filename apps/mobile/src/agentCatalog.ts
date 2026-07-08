import { Bot, Cloud, Code2, Cpu, TerminalSquare } from "lucide-react-native";
import type { ComponentType } from "react";

export type MobileAgentId = string;

export type MobileAgent = {
  id: MobileAgentId;
  label: string;
  runtime: "termux" | "asv";
  installCommand: string;
  loginCommand: string;
  defaultModel?: string;
  icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
};

export const MOBILE_AGENT_HOME = "/data/data/com.aintech.mobileagents2/files/home";
export const MOBILE_AGENT_PREFIX = "/data/data/com.aintech.mobileagents2/files/usr";

export const MOBILE_AGENTS: MobileAgent[] = [
  {
    id: "codex",
    label: "Codex",
    runtime: "termux",
    installCommand: "mobile-agent-install codex",
    loginCommand: "codex login",
    defaultModel: "gpt-5.2-codex",
    icon: Code2
  },
  {
    id: "claude",
    label: "Claude Code",
    runtime: "termux",
    installCommand: "mobile-agent-install claude",
    loginCommand: "claude",
    defaultModel: "claude-sonnet-4-6",
    icon: Bot
  },
  {
    id: "opencode",
    label: "OpenCode",
    runtime: "termux",
    installCommand: "mobile-agent-install opencode",
    loginCommand: "opencode auth login",
    icon: TerminalSquare
  },
  {
    id: "cursor",
    label: "Cursor Agent",
    runtime: "termux",
    installCommand: "mobile-agent-install cursor",
    loginCommand: "cursor-agent login",
    icon: Cpu
  }
];

export const MOBILE_AGENT_CHOICES = MOBILE_AGENTS.map((agent) => ({
  label: agent.label,
  value: agent.id
}));

export function getMobileAgent(id: string): MobileAgent {
  return MOBILE_AGENTS.find((agent) => agent.id === id) ?? {
    id,
    label: id,
    runtime: "asv",
    installCommand: "",
    loginCommand: "",
    icon: Cloud
  };
}
