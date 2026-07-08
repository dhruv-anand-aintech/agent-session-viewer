import Constants from "expo-constants";
import { Platform } from "react-native";

declare const process:
  | {
      env?: Record<string, string | undefined>;
    }
  | undefined;

export type AgentProvider = {
  id: string;
  label: string;
  status?: "available" | "missing" | string;
  agents?: string[];
};

export type ModelOption = {
  value: string;
  label: string;
  model?: string;
  modelClass?: "fast" | "pro";
  noModel?: boolean;
  useExtraModelArg?: boolean;
};

export type ProvidersResponse = {
  providers: AgentProvider[];
  defaults?: {
    provider?: string;
    agent?: string;
    mode?: string;
    modelClass?: string;
    model?: string;
  };
  modelOptionsByAgent?: Record<string, ModelOption[]>;
};

export type ChatResponse = {
  ok?: boolean;
  text?: string;
  error?: string;
  sessionId?: string;
  resumedSession?: boolean;
  provider?: string;
  agent?: string;
};

export type SessionMeta = {
  id: string;
  projectPath?: string;
  source?: string;
  firstName?: string | null;
  customName?: string | null;
  lastActivity?: string;
  messageCount?: number;
  userMessageCount?: number | null;
  isActive?: boolean;
};

export type ProjectSummary = {
  path: string;
  name?: string;
  sessions?: SessionMeta[];
};

export type TranscriptMessage = {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  [key: string]: unknown;
};

export type AsvBridgeRequest = {
  method?: string;
  path: string;
  body?: unknown;
  authToken?: string;
};

const configuredBase =
  (typeof process !== "undefined" ? process.env?.EXPO_PUBLIC_ASV_BASE_URL : undefined) ||
  Constants.expoConfig?.extra?.asvBaseUrl ||
  "https://agent-session-viewer.ainorthstar.tech";

export const ASV_BASE_URL = String(configuredBase).replace(/\/$/, "");

export async function asvFetch<T>(request: AsvBridgeRequest): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (request.authToken) headers.Authorization = `Bearer ${request.authToken}`;
  const response = await fetch(`${ASV_BASE_URL}${request.path}`, {
    method: request.method ?? (request.body ? "POST" : "GET"),
    credentials: "include",
    headers,
    body: request.body ? JSON.stringify(request.body) : undefined
  });
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(json.error || `ASV request failed: ${response.status}`);
  }
  return json as T;
}

export function canUseEmbeddedAuth(): boolean {
  return Platform.OS !== "web";
}
