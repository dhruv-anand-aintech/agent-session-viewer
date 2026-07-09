import "../global.css";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";
import { Check, ChevronDown, ExternalLink, ListTree, LogOut, MessageSquare, Play, RefreshCw, Send, Smartphone, TerminalSquare } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import {
  MOBILE_AGENT_HOME,
  MOBILE_AGENT_PREFIX,
  MOBILE_AGENTS,
  getMobileAgent
} from "./agentCatalog";
import {
  ASV_BASE_URL,
  asvFetch,
  canUseEmbeddedAuth,
  type AgentProvider,
  type AsvBridgeRequest,
  type ChatResponse,
  type ModelOption,
  type ProjectSummary,
  type ProvidersResponse,
  type SessionMeta,
  type TranscriptMessage
} from "./asvApi";
import {
  AgentCatalog,
  ChoiceButton,
  DropdownControl,
  DropdownRow,
  Section,
  SelectRow,
  SessionsPanel,
  TabButton,
  ViewerPanel
} from "./components";
import { classes, colors } from "./theme";

type TabId = "chat" | "sessions" | "viewer" | "agents";

type BridgeResult = {
  requestId: string;
  ok: boolean;
  status?: number;
  text?: string;
  error?: string;
};

type PendingBridgeRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
};

type SelectOption = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

const STORAGE_KEY = "asv.mobile.state.v1";
const THINKING_LEVELS = ["auto", "low", "medium", "high"];
const CLOUD_AGENT_CWD = "/opt/asv-agent/work";
const NativeWebView = WebView as React.ComponentType<any>;

function escapeScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

function textFromContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: string; thinking?: string; name?: string };
      if (typed.type === "text") return typed.text ?? "";
      if (typed.type === "thinking") return typed.thinking ?? "";
      if (typed.type === "tool_use") return `[tool_use ${typed.name ?? ""}]`;
      if (typed.type === "tool_result") return "[tool_result]";
      return typed.type ? `[${typed.type}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function messageText(message: TranscriptMessage): string {
  return textFromContent(message.message?.content).trim();
}

function messageRole(message: TranscriptMessage): string {
  return message.message?.role || message.type || "message";
}

function sessionTitle(session: SessionMeta): string {
  return session.customName || session.firstName || session.id.slice(0, 8);
}

function projectLabel(path: string): string {
  const clean = path.replace(/^[a-z-]+:/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

function agentLabel(id: string): string {
  return MOBILE_AGENTS.find((agent) => agent.id === id)?.label ?? id;
}

function sessionCanResumeWithClaude(session?: SessionMeta | null): boolean {
  return String(session?.source ?? "").toLowerCase() === "claude";
}

function executionCwdForProvider(provider?: AgentProvider | null): string | undefined {
  if (!provider) return undefined;
  if (provider.id === "gcp-claude" || provider.kind === "cloud-http") return CLOUD_AGENT_CWD;
  return undefined;
}

function mobileAuthTokenFromUrl(url: string): string {
  const [withoutFragment, fragment = ""] = url.split("#");
  const query = withoutFragment.split("?")[1] ?? "";
  const fragmentParams = new URLSearchParams(fragment);
  return fragmentParams.get("token") ?? new URLSearchParams(query).get("token") ?? "";
}

function AppContent() {
  const webViewRef = useRef<any>(null);
  const pendingRequests = useRef(new Map<string, PendingBridgeRequest>());
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [providerId, setProviderId] = useState("local");
  const [agentId, setAgentId] = useState("codex");
  const [model, setModel] = useState("");
  const [thinkingLevel, setThinkingLevel] = useState("auto");
  const [authToken, setAuthToken] = useState("");
  const [bridgeReady, setBridgeReady] = useState(!canUseEmbeddedAuth());
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [modelOptionsByAgent, setModelOptionsByAgent] = useState<Record<string, ModelOption[]>>({});
  const [reply, setReply] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectPath, setSelectedProjectPath] = useState("");
  const [selectedSession, setSelectedSession] = useState<SessionMeta | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [sessionPrompt, setSessionPrompt] = useState("");
  const [sessionReply, setSessionReply] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionsLoadedOnce, setSessionsLoadedOnce] = useState(false);
  const [updateStatus, setUpdateStatus] = useState("");
  const [openSelect, setOpenSelect] = useState<"provider" | "agent" | "model" | null>(null);

  const selectedAgent = useMemo(() => MOBILE_AGENTS.find((agent) => agent.id === agentId) ?? getMobileAgent(agentId), [agentId]);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providerId, providers]
  );
  const agentOptions = useMemo(() => {
    const ids = selectedProvider?.agents?.length ? selectedProvider.agents : MOBILE_AGENTS.map((agent) => agent.id);
    return Array.from(new Set(ids));
  }, [selectedProvider]);
  const modelOptions = useMemo(() => {
    const fromApi = modelOptionsByAgent[agentId] ?? [];
    const defaults: ModelOption[] = !fromApi.length && selectedAgent.defaultModel
      ? [{ value: selectedAgent.defaultModel, label: selectedAgent.defaultModel, model: selectedAgent.defaultModel }]
      : [];
    const seen = new Set<string>();
    return [...fromApi, ...defaults].filter((option) => {
      if (!option?.value || seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
  }, [agentId, modelOptionsByAgent, selectedAgent.defaultModel]);
  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? modelOptions[0] ?? null,
    [model, modelOptions]
  );
  const selectedProject = useMemo(
    () => projects.find((project) => project.path === selectedProjectPath) ?? projects[0] ?? null,
    [projects, selectedProjectPath]
  );
  const projectSessions = selectedProject?.sessions ?? [];
  const providerOptions = useMemo<SelectOption[]>(
    () => providers.map((provider) => ({
      value: provider.id,
      label: provider.label || provider.id,
      detail: provider.status === "missing" ? "Missing" : provider.detail,
      disabled: provider.status === "missing"
    })),
    [providers]
  );
  const agentSelectOptions = useMemo<SelectOption[]>(
    () => agentOptions.map((agent) => ({ value: agent, label: agentLabel(agent) })),
    [agentOptions]
  );
  const modelSelectOptions = useMemo<SelectOption[]>(
    () => modelOptions.map((option) => ({ value: option.value, label: option.label || option.value })),
    [modelOptions]
  );

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw) as Partial<{
          providerId: string;
          agentId: string;
          model: string;
          thinkingLevel: string;
          authToken: string;
          sessionId: string;
        }>;
        if (saved.providerId) setProviderId(saved.providerId);
        if (saved.agentId) setAgentId(saved.agentId);
        if (saved.model) setModel(saved.model);
        if (saved.thinkingLevel) setThinkingLevel(saved.thinkingLevel);
        if (saved.authToken) setAuthToken(saved.authToken);
        if (saved.sessionId) setSessionId(saved.sessionId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ providerId, agentId, model, thinkingLevel, authToken, sessionId })
    ).catch(() => {});
  }, [agentId, authToken, model, providerId, sessionId, thinkingLevel]);

  useEffect(() => {
    setSessionsLoadedOnce(false);
  }, [authToken]);

  const handleAuthUrl = useCallback((url: string) => {
    const token = mobileAuthTokenFromUrl(url);
    if (!token) return;
    setAuthToken(token);
    setStatus("Signed in to ASV");
    setActiveTab("sessions");
  }, []);

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) handleAuthUrl(url);
    }).catch(() => {});
    const subscription = Linking.addEventListener("url", ({ url }) => handleAuthUrl(url));
    return () => subscription.remove();
  }, [handleAuthUrl]);

  useEffect(() => {
    if (!modelOptions.length) return;
    if (!modelOptions.some((option) => option.value === model)) setModel(modelOptions[0].value);
  }, [model, modelOptions]);

  useEffect(() => {
    if (!agentOptions.includes(agentId)) setAgentId(agentOptions[0] ?? "codex");
  }, [agentId, agentOptions]);

  const bridgeFetch = useCallback(
    async <T,>(request: AsvBridgeRequest): Promise<T> => {
      const requestAuthToken = request.authToken ?? authToken;
      if (requestAuthToken) {
        return asvFetch<T>({ ...request, authToken: requestAuthToken });
      }
      if (!canUseEmbeddedAuth()) {
        return asvFetch<T>(request);
      }
      if (!bridgeReady || !webViewRef.current) {
        throw new Error("Browser bridge is starting");
      }
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const promise = new Promise<T>((resolve, reject) => {
        pendingRequests.current.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      });
      const script = `
        (async function() {
          try {
            var response = await fetch(${escapeScriptValue(`${ASV_BASE_URL}${request.path}`)}, {
              method: ${escapeScriptValue(request.method ?? (request.body ? "POST" : "GET"))},
              credentials: "include",
              headers: ${escapeScriptValue({
                "content-type": "application/json",
                ...(requestAuthToken ? { Authorization: `Bearer ${requestAuthToken}` } : {})
              })},
              body: ${request.body ? escapeScriptValue(JSON.stringify(request.body)) : "undefined"}
            });
            var text = await response.text();
            window.ReactNativeWebView.postMessage(JSON.stringify({
              kind: "asv-fetch-result",
              requestId: ${escapeScriptValue(requestId)},
              ok: response.ok,
              status: response.status,
              text: text
            }));
          } catch (error) {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              kind: "asv-fetch-result",
              requestId: ${escapeScriptValue(requestId)},
              ok: false,
              error: String(error && error.message ? error.message : error)
            }));
          }
        })();
        true;
      `;
      webViewRef.current.injectJavaScript(script);
      return promise;
    },
    [authToken, bridgeReady]
  );

  const startMobileSignIn = useCallback(() => {
    const params = new URLSearchParams({ mobile: "1", return: "asv://auth" });
    Linking.openURL(`${ASV_BASE_URL}/api/auth/google/start?${params}`).catch(() => {
      setStatus("Could not open browser sign-in");
    });
  }, []);

  const signOut = useCallback(() => {
    setAuthToken("");
    setProjects([]);
    setSelectedProjectPath("");
    setSelectedSession(null);
    setTranscript([]);
    setSessionReply("");
    setSessionsLoadedOnce(false);
    setStatus("Signed out");
  }, []);

  const loadProviders = useCallback(async () => {
    if (canUseEmbeddedAuth() && !bridgeReady) {
      setStatus("Preparing browser bridge");
      return;
    }
    setStatus("Loading providers");
    try {
      const data = await bridgeFetch<ProvidersResponse>({ path: "/api/agent/providers" });
      setProviders(data.providers ?? []);
      setModelOptionsByAgent(data.modelOptionsByAgent ?? {});
      const current = data.providers?.find((provider) => provider.id === providerId);
      const cloudClaude = data.providers?.find((provider) => provider.id === "gcp-claude");
      if (!current && cloudClaude) setProviderId(cloudClaude.id);
      if (!current && !cloudClaude && data.providers?.[0]) setProviderId(data.providers[0].id);
      setStatus("Providers loaded");
    } catch (error) {
      setStatus(Platform.OS === "web" ? "ASV web auth not connected" : error instanceof Error ? error.message : "Provider load failed");
    }
  }, [bridgeFetch, bridgeReady, providerId]);

  const checkForUpdates = useCallback(async () => {
    if (!Updates.isEnabled) {
      setUpdateStatus("Updates active in release builds");
      return;
    }
    setUpdateStatus("Checking for update");
    try {
      const check = await Updates.checkForUpdateAsync();
      if (!check.isAvailable) {
        setUpdateStatus("App is current");
        return;
      }
      await Updates.fetchUpdateAsync();
      setUpdateStatus("Update downloaded; restarting");
      await Updates.reloadAsync();
    } catch (error) {
      setUpdateStatus(error instanceof Error ? error.message : "Update check failed");
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const onBridgeMessage = useCallback((event: { nativeEvent: { data: string } }) => {
    let parsed: (BridgeResult & { kind?: string }) | null = null;
    try {
      parsed = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (parsed?.kind !== "asv-fetch-result") return;
    const pending = pendingRequests.current.get(parsed.requestId);
    if (!pending) return;
    pendingRequests.current.delete(parsed.requestId);
    if (!parsed.ok) {
      pending.reject(new Error(parsed.error || `ASV request failed: ${parsed.status}`));
      return;
    }
    const json = parsed.text ? JSON.parse(parsed.text) : {};
    pending.resolve(json);
  }, []);

  const loadSessions = useCallback(async () => {
    setLoadingSessions(true);
    setStatus("Loading cloud sessions");
    try {
      if (!authToken && Platform.OS !== "web") {
        setProjects([]);
        setSelectedProjectPath("");
        setSelectedSession(null);
        setTranscript([]);
        setStatus("Sign in to sync sessions");
        return;
      }
      const data = await bridgeFetch<ProjectSummary[]>({ path: "/api/projects?maxSessions=40", timeoutMs: 15000 });
      setProjects(data);
      const nextProject = data.find((project) => project.path === selectedProjectPath) ?? data[0] ?? null;
      setSelectedProjectPath(nextProject?.path ?? "");
      const nextSession = nextProject?.sessions?.find((session) => session.id === selectedSession?.id) ?? nextProject?.sessions?.[0] ?? null;
      setSelectedSession(nextSession);
      setStatus(nextSession ? "Cloud sessions loaded" : "No synced sessions");
      if (nextSession) {
        const projectPath = nextSession.projectPath || nextProject?.path || "";
        const messages = await bridgeFetch<TranscriptMessage[]>({
          path: `/api/session/${encodeURIComponent(projectPath)}/${encodeURIComponent(nextSession.id)}?tail=120`,
          timeoutMs: 15000
        });
        setTranscript(messages);
      } else {
        setTranscript([]);
      }
    } catch (error) {
      setStatus(Platform.OS === "web" ? "Open ASV to authenticate" : error instanceof Error ? error.message : "Session load failed");
    } finally {
      setSessionsLoadedOnce(true);
      setLoadingSessions(false);
    }
  }, [authToken, bridgeFetch, selectedProjectPath, selectedSession?.id]);

  const openSession = useCallback(async (project: ProjectSummary, session: SessionMeta) => {
    setSelectedProjectPath(project.path);
    setSelectedSession(session);
    setTranscript([]);
    setSessionReply("");
    setStatus("Loading transcript");
    try {
      const projectPath = session.projectPath || project.path;
      const messages = await bridgeFetch<TranscriptMessage[]>({
        path: `/api/session/${encodeURIComponent(projectPath)}/${encodeURIComponent(session.id)}?tail=160`
      });
      setTranscript(messages);
      setStatus("Transcript loaded");
      setActiveTab("sessions");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Transcript load failed");
    }
  }, [bridgeFetch]);

  useEffect(() => {
    if (activeTab === "sessions" && (!!authToken || Platform.OS === "web") && projects.length === 0 && !loadingSessions && !sessionsLoadedOnce) {
      void loadSessions();
    }
  }, [activeTab, authToken, loadSessions, loadingSessions, projects.length, sessionsLoadedOnce]);

  const sendPrompt = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus("Running agent");
    setReply("");
    try {
      const executionCwd = executionCwdForProvider(selectedProvider);
      const body = {
        provider: providerId,
        agent: agentId,
        mode: "ask",
        modelClass: selectedModelOption?.modelClass,
        model: selectedModelOption?.model ?? (model || undefined),
        thinkingLevel,
        noModel: selectedModelOption?.noModel,
        useExtraModelArg: selectedModelOption?.useExtraModelArg,
        cwd: executionCwd,
        sessionId: sessionId || undefined,
        prompt: trimmed,
        conversation: [{ role: "user", content: trimmed }],
        context: {
          source: "asv-mobile",
          mobileRuntime: selectedAgent.runtime,
          installCommand: selectedAgent.installCommand,
          loginCommand: selectedAgent.loginCommand,
          executionCwd,
          mobileHome: MOBILE_AGENT_HOME,
          prefix: MOBILE_AGENT_PREFIX
        }
      };
      const data = await bridgeFetch<ChatResponse>({
        path: "/api/agent/chat",
        method: "POST",
        body
      });
      setReply(data.text || data.error || "");
      if (data.sessionId) setSessionId(data.sessionId);
      setPrompt("");
      setStatus(data.error ? "Agent returned an error" : "Agent replied");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Agent request failed");
    } finally {
      setBusy(false);
    }
  }, [agentId, bridgeFetch, busy, model, prompt, providerId, selectedAgent, selectedModelOption, selectedProvider, sessionId, thinkingLevel]);

  const sendSessionPrompt = useCallback(async () => {
    const trimmed = sessionPrompt.trim();
    if (!trimmed || busy || !selectedSession) return;
    const projectPath = selectedSession.projectPath || selectedProject?.path || selectedProjectPath;
    setBusy(true);
    setSessionReply("");
    setStatus("Sending to cloud Claude");
    try {
      const data = await bridgeFetch<ChatResponse>({
        path: "/api/agent/chat",
        method: "POST",
        body: {
          provider: "gcp-claude",
          agent: "claude",
          mode: "ask",
          model: "sonnet",
          thinkingLevel,
          cwd: "/opt/asv-agent/work",
          prompt: trimmed,
          conversation: [{ role: "user", content: trimmed }],
          resumeCurrentSession: sessionCanResumeWithClaude(selectedSession),
          sessionContext: {
            projectPath,
            sessionId: selectedSession.id,
            source: selectedSession.source || "claude",
            cwd: "/opt/asv-agent/work",
            messages: transcript
          }
        }
      });
      if (data.ok === false) throw new Error(data.error || "Cloud Claude request failed");
      setSessionReply(data.text || "");
      setSessionPrompt("");
      setStatus(data.resumedSession ? "Cloud Claude resumed session" : "Cloud Claude replied");
      if (data.resumedSession) {
        await openSession({ path: projectPath, sessions: [selectedSession] }, selectedSession);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Cloud Claude request failed");
      setSessionReply("");
    } finally {
      setBusy(false);
    }
  }, [bridgeFetch, busy, openSession, selectedProject?.path, selectedProjectPath, selectedSession, sessionPrompt, thinkingLevel, transcript]);

  return (
    <SafeAreaView className={classes.screen}>
      <View className={classes.screen}>
        <View className="flex-row items-start justify-between px-6 pb-3 pt-6">
          <View className="min-w-0 flex-1 pr-3">
            <Text className="font-serif text-[34px] leading-[42px] text-ink">Code</Text>
            <Text className="mt-1 text-[13px] leading-[18px] text-muted">{status}</Text>
          </View>
          <View className="flex-row items-center gap-2 pt-0.5">
            {!authToken ? (
              <Pressable className={classes.secondaryButton} onPress={startMobileSignIn}>
                <ExternalLink size={18} color={colors.text} />
                <Text className="text-sm font-bold text-ink">Sign in</Text>
              </Pressable>
            ) : (
              <Pressable className={classes.secondaryButton} onPress={signOut}>
                <LogOut size={18} color={colors.text} />
                <Text className="text-sm font-bold text-ink">Sign out</Text>
              </Pressable>
            )}
            <Pressable className="h-[42px] w-[42px] items-center justify-center rounded-full border border-white/10 bg-surface-muted" onPress={loadProviders} accessibilityLabel="Refresh providers">
              <RefreshCw size={18} color={colors.text} />
            </Pressable>
          </View>
        </View>

        <View className="flex-row gap-2 px-6 pb-2.5 pt-1">
          <TabButton id="chat" activeTab={activeTab} setActiveTab={setActiveTab} label="Chat" />
          <TabButton id="sessions" activeTab={activeTab} setActiveTab={setActiveTab} label="Sessions" />
          <TabButton id="viewer" activeTab={activeTab} setActiveTab={setActiveTab} label="Viewer" />
          <TabButton id="agents" activeTab={activeTab} setActiveTab={setActiveTab} label="Agents" />
        </View>

        <View className="flex-1">
          {activeTab === "chat" ? (
            <ScrollView contentContainerClassName={classes.scroll}>
              <Section title="Session">
                <DropdownRow
                  label="Provider"
                  value={providerId}
                  options={providerOptions}
                  emptyText="Sign in with Google, then refresh."
                  open={openSelect === "provider"}
                  onToggle={() => setOpenSelect(openSelect === "provider" ? null : "provider")}
                  onChange={(value) => {
                    setProviderId(value);
                    setModel("");
                    setOpenSelect(null);
                  }}
                />
                <DropdownRow
                  label="Agent"
                  value={agentId}
                  options={agentSelectOptions}
                  open={openSelect === "agent"}
                  onToggle={() => setOpenSelect(openSelect === "agent" ? null : "agent")}
                  onChange={(value) => {
                    setAgentId(value);
                    setModel("");
                    setOpenSelect(null);
                  }}
                />
                <View className="gap-2">
                  <Text className="text-xs font-bold uppercase text-muted">Model</Text>
                  {modelOptions.length ? (
                    <DropdownControl
                      value={model}
                      options={modelSelectOptions}
                      open={openSelect === "model"}
                      onToggle={() => setOpenSelect(openSelect === "model" ? null : "model")}
                      onChange={(value) => {
                        setModel(value);
                        setOpenSelect(null);
                      }}
                    />
                  ) : (
                    <TextInput
                      className={classes.field}
                      value={model}
                      onChangeText={setModel}
                      placeholder="Model"
                      placeholderTextColor={colors.muted}
                    />
                  )}
                </View>
                <SelectRow label="Thinking">
                  {THINKING_LEVELS.map((level) => (
                    <ChoiceButton
                      key={level}
                      label={level}
                      active={level === thinkingLevel}
                      onPress={() => setThinkingLevel(level)}
                    />
                  ))}
                </SelectRow>
              </Section>

              <Section title="Prompt">
                <TextInput
                  className="min-h-[152px] rounded-[28px] border border-white/15 bg-composer p-5 font-serif text-[19px] leading-[27px] text-ink"
                  multiline
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Ask the selected agent"
                  placeholderTextColor={colors.muted}
                />
                <Pressable className={`${classes.primaryButton} ${busy ? "opacity-60" : ""}`} onPress={sendPrompt} disabled={busy}>
                  {busy ? <ActivityIndicator color={colors.accentText} /> : <Send size={18} color={colors.accentText} />}
                  <Text className="text-base font-bold text-white">Send</Text>
                </Pressable>
              </Section>

              {reply ? (
                <Section title="Reply">
                  <Text className="font-serif text-lg leading-[27px] text-ink">{reply}</Text>
                </Section>
              ) : null}
            </ScrollView>
          ) : null}

          {activeTab === "sessions" ? (
            <SessionsPanel
              projects={projects}
              selectedSession={selectedSession}
              transcript={transcript}
              prompt={sessionPrompt}
              reply={sessionReply}
              busy={busy || loadingSessions}
              signedIn={!!authToken}
              updateStatus={updateStatus}
              onRefresh={loadSessions}
              onOpenSession={openSession}
              onPromptChange={setSessionPrompt}
              onSendPrompt={sendSessionPrompt}
              onCheckUpdates={checkForUpdates}
            />
          ) : null}

          {activeTab === "viewer" ? (
            <ViewerPanel webViewRef={webViewRef} onBridgeMessage={onBridgeMessage} authToken={authToken} onSignIn={startMobileSignIn} />
          ) : null}

          {activeTab === "agents" ? <AgentCatalog /> : null}
        </View>
      </View>
      {canUseEmbeddedAuth() ? (
        <View pointerEvents="none" className="absolute -left-[10000px] -top-[10000px] h-px w-px opacity-0">
          <NativeWebView
            ref={webViewRef}
            source={{ uri: authToken ? `${ASV_BASE_URL}/api/auth/mobile/finish?token=${encodeURIComponent(authToken)}` : ASV_BASE_URL }}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            onLoadStart={() => setBridgeReady(false)}
            onLoadEnd={() => setBridgeReady(true)}
            onMessage={onBridgeMessage}
          />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}
