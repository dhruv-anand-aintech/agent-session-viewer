import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Updates from "expo-updates";
import { ExternalLink, ListTree, MessageSquare, Play, RefreshCw, Send, Smartphone, TerminalSquare } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
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
import { colors, spacing } from "./theme";

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

const STORAGE_KEY = "asv.mobile.state.v1";
const THINKING_LEVELS = ["auto", "low", "medium", "high"];
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
  const [updateStatus, setUpdateStatus] = useState("");

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
    const defaults: ModelOption[] = selectedAgent.defaultModel
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
      const requestAuthToken = request.authToken ?? authToken;
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
      const data = await bridgeFetch<ProjectSummary[]>({ path: "/api/projects?maxSessions=40" });
      setProjects(data);
      const nextProject = data.find((project) => project.path === selectedProjectPath) ?? data[0] ?? null;
      setSelectedProjectPath(nextProject?.path ?? "");
      const nextSession = nextProject?.sessions?.find((session) => session.id === selectedSession?.id) ?? nextProject?.sessions?.[0] ?? null;
      setSelectedSession(nextSession);
      setStatus(nextSession ? "Cloud sessions loaded" : "No synced sessions");
      if (nextSession) {
        const projectPath = nextSession.projectPath || nextProject?.path || "";
        const messages = await bridgeFetch<TranscriptMessage[]>({
          path: `/api/session/${encodeURIComponent(projectPath)}/${encodeURIComponent(nextSession.id)}?tail=120`
        });
        setTranscript(messages);
      } else {
        setTranscript([]);
      }
    } catch (error) {
      setStatus(Platform.OS === "web" ? "Open ASV to authenticate" : error instanceof Error ? error.message : "Session load failed");
    } finally {
      setLoadingSessions(false);
    }
  }, [bridgeFetch, selectedProjectPath, selectedSession?.id]);

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
    if (activeTab === "sessions" && projects.length === 0 && !loadingSessions) {
      void loadSessions();
    }
  }, [activeTab, loadSessions, loadingSessions, projects.length]);

  const sendPrompt = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setStatus("Running agent");
    setReply("");
    try {
      const body = {
        provider: providerId,
        agent: agentId,
        mode: "ask",
        modelClass: selectedModelOption?.modelClass,
        model: selectedModelOption?.model ?? (model || undefined),
        thinkingLevel,
        noModel: selectedModelOption?.noModel,
        useExtraModelArg: selectedModelOption?.useExtraModelArg,
        cwd: MOBILE_AGENT_HOME,
        sessionId: sessionId || undefined,
        prompt: trimmed,
        conversation: [{ role: "user", content: trimmed }],
        context: {
          source: "asv-mobile",
          mobileRuntime: selectedAgent.runtime,
          installCommand: selectedAgent.installCommand,
          loginCommand: selectedAgent.loginCommand,
          home: MOBILE_AGENT_HOME,
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
  }, [agentId, bridgeFetch, busy, model, prompt, providerId, selectedAgent, selectedModelOption, sessionId, thinkingLevel]);

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
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Agent Session Viewer</Text>
            <Text style={styles.subtitle}>{status}</Text>
          </View>
          <View style={styles.headerActions}>
            {!authToken ? (
              <Pressable style={styles.secondaryButton} onPress={startMobileSignIn}>
                <ExternalLink size={18} color={colors.text} />
                <Text style={styles.secondaryButtonText}>Sign in</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.iconButton} onPress={loadProviders} accessibilityLabel="Refresh providers">
              <RefreshCw size={18} color={colors.text} />
            </Pressable>
          </View>
        </View>

        <View style={styles.tabs}>
          <TabButton id="chat" activeTab={activeTab} setActiveTab={setActiveTab} label="Chat" />
          <TabButton id="sessions" activeTab={activeTab} setActiveTab={setActiveTab} label="Sessions" />
          <TabButton id="viewer" activeTab={activeTab} setActiveTab={setActiveTab} label="Viewer" />
          <TabButton id="agents" activeTab={activeTab} setActiveTab={setActiveTab} label="Agents" />
        </View>

        <View style={styles.content}>
          {activeTab === "chat" ? (
            <ScrollView contentContainerStyle={styles.scrollContent}>
              <Section title="Session">
                <SelectRow label="Provider">
                  {providers.length ? (
                    providers.map((provider) => (
                      <ChoiceButton
                        key={provider.id}
                        label={provider.label || provider.id}
                        active={provider.id === providerId}
                        disabled={provider.status === "missing"}
                        onPress={() => setProviderId(provider.id)}
                      />
                    ))
                  ) : (
                    <Text style={styles.mutedText}>Sign in with Google, then refresh.</Text>
                  )}
                </SelectRow>
                <SelectRow label="Agent">
                  {agentOptions.map((agent) => (
                    <ChoiceButton
                      key={agent}
                      label={agentLabel(agent)}
                      active={agent === agentId}
                      onPress={() => setAgentId(agent)}
                    />
                  ))}
                </SelectRow>
                <SelectRow label="Model">
                  {modelOptions.length ? (
                    modelOptions.map((option) => (
                      <ChoiceButton key={option.value} label={option.label || option.value} active={option.value === model} onPress={() => setModel(option.value)} />
                    ))
                  ) : (
                    <TextInput
                      style={styles.input}
                      value={model}
                      onChangeText={setModel}
                      placeholder="Model"
                      placeholderTextColor={colors.muted}
                    />
                  )}
                </SelectRow>
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
                  style={styles.prompt}
                  multiline
                  value={prompt}
                  onChangeText={setPrompt}
                  placeholder="Ask the selected agent"
                  placeholderTextColor={colors.muted}
                />
                <Pressable style={[styles.primaryButton, busy && styles.disabled]} onPress={sendPrompt} disabled={busy}>
                  {busy ? <ActivityIndicator color={colors.accentText} /> : <Send size={18} color={colors.accentText} />}
                  <Text style={styles.primaryButtonText}>Send</Text>
                </Pressable>
              </Section>

              {reply ? (
                <Section title="Reply">
                  <Text style={styles.reply}>{reply}</Text>
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
        <View pointerEvents="none" style={styles.hiddenBridge}>
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

function TabButton({
  id,
  activeTab,
  setActiveTab,
  label
}: {
  id: TabId;
  activeTab: TabId;
  setActiveTab: (id: TabId) => void;
  label: string;
}) {
  return (
    <Pressable
      style={[styles.tabButton, activeTab === id && styles.tabButtonActive]}
      onPress={() => setActiveTab(id)}
    >
      <Text style={[styles.tabText, activeTab === id && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

function ChoiceButton({
  label,
  active,
  disabled,
  onPress
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={[styles.choice, active && styles.choiceActive, disabled && styles.disabledChoice]}
      disabled={disabled}
      onPress={onPress}
    >
      <Text style={[styles.choiceText, active && styles.choiceTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function SelectRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.selectRow}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.choiceWrap}>{children}</View>
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function ViewerPanel({
  webViewRef,
  onBridgeMessage,
  authToken,
  onSignIn
}: {
  webViewRef: React.RefObject<any>;
  onBridgeMessage: (event: { nativeEvent: { data: string } }) => void;
  authToken: string;
  onSignIn: () => void;
}) {
  void webViewRef;
  void onBridgeMessage;
  if (Platform.OS === "web") {
    return (
      <View style={styles.viewerFallback}>
        <TerminalSquare size={28} color={colors.text} />
        <Text style={styles.viewerTitle}>ASV Web</Text>
        <Pressable style={styles.secondaryButton} onPress={() => Linking.openURL(ASV_BASE_URL)}>
          <ExternalLink size={18} color={colors.text} />
          <Text style={styles.secondaryButtonText}>Open Viewer</Text>
        </Pressable>
      </View>
    );
  }
  if (!authToken) {
    return (
      <View style={styles.viewerFallback}>
        <TerminalSquare size={28} color={colors.text} />
        <Text style={styles.viewerTitle}>Sign in to ASV</Text>
        <Pressable style={styles.secondaryButton} onPress={onSignIn}>
          <ExternalLink size={18} color={colors.text} />
          <Text style={styles.secondaryButtonText}>Sign in with Google</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <NativeWebView
      source={{ uri: `${ASV_BASE_URL}/api/auth/mobile/finish?token=${encodeURIComponent(authToken)}` }}
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      style={styles.webView}
    />
  );
}

function SessionsPanel({
  projects,
  selectedSession,
  transcript,
  prompt,
  reply,
  busy,
  updateStatus,
  onRefresh,
  onOpenSession,
  onPromptChange,
  onSendPrompt,
  onCheckUpdates
}: {
  projects: ProjectSummary[];
  selectedSession: SessionMeta | null;
  transcript: TranscriptMessage[];
  prompt: string;
  reply: string;
  busy: boolean;
  updateStatus: string;
  onRefresh: () => void;
  onOpenSession: (project: ProjectSummary, session: SessionMeta) => void;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onCheckUpdates: () => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.actionRow}>
        <Pressable style={styles.secondaryButton} onPress={onRefresh} disabled={busy}>
          <RefreshCw size={18} color={colors.text} />
          <Text style={styles.secondaryButtonText}>{busy ? "Loading" : "Refresh"}</Text>
        </Pressable>
        <Pressable style={styles.secondaryButton} onPress={onCheckUpdates}>
          <ExternalLink size={18} color={colors.text} />
          <Text style={styles.secondaryButtonText}>Update</Text>
        </Pressable>
      </View>
      {updateStatus ? <Text style={styles.statusText}>{updateStatus}</Text> : null}

      <Section title="Cloud Sessions">
        {projects.length === 0 ? (
          <Text style={styles.mutedText}>Sign in with Google, then refresh synced sessions.</Text>
        ) : (
          projects.slice(0, 12).map((project) => (
            <View key={project.path} style={styles.projectGroup}>
              <View style={styles.projectTitleRow}>
                <ListTree size={16} color={colors.muted} />
                <Text style={styles.projectTitle} numberOfLines={1}>{projectLabel(project.path)}</Text>
              </View>
              {(project.sessions ?? []).slice(0, 8).map((session) => (
                <Pressable
                  key={`${project.path}:${session.id}`}
                  style={[styles.sessionRow, selectedSession?.id === session.id && styles.sessionRowActive]}
                  onPress={() => onOpenSession(project, session)}
                >
                  <MessageSquare size={16} color={selectedSession?.id === session.id ? colors.accentText : colors.muted} />
                  <View style={styles.sessionTextWrap}>
                    <Text style={[styles.sessionTitle, selectedSession?.id === session.id && styles.sessionTitleActive]} numberOfLines={1}>
                      {sessionTitle(session)}
                    </Text>
                    <Text style={[styles.sessionMeta, selectedSession?.id === session.id && styles.sessionMetaActive]} numberOfLines={1}>
                      {(session.source || "session")} · {session.messageCount ?? 0} messages
                    </Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ))
        )}
      </Section>

      {selectedSession ? (
        <Section title={`Transcript: ${sessionTitle(selectedSession)}`}>
          {transcript.length === 0 ? (
            <Text style={styles.mutedText}>No messages loaded.</Text>
          ) : (
            transcript.slice(-24).map((message, index) => (
              <View key={`${message.timestamp ?? index}-${index}`} style={styles.messageRow}>
                <Text style={styles.messageRole}>{messageRole(message)}</Text>
                <Text style={styles.messageText}>{messageText(message) || "[empty]"}</Text>
              </View>
            ))
          )}
          <TextInput
            style={styles.prompt}
            multiline
            value={prompt}
            onChangeText={onPromptChange}
            placeholder="Send a follow-up using cloud Claude Code"
            placeholderTextColor={colors.muted}
          />
          <Pressable style={[styles.primaryButton, busy && styles.disabled]} onPress={onSendPrompt} disabled={busy || !prompt.trim()}>
            {busy ? <ActivityIndicator color={colors.accentText} /> : <Send size={18} color={colors.accentText} />}
            <Text style={styles.primaryButtonText}>
              {sessionCanResumeWithClaude(selectedSession) ? "Resume Claude" : "Ask Cloud Claude"}
            </Text>
          </Pressable>
        </Section>
      ) : null}

      {reply ? (
        <Section title="Cloud Claude Reply">
          <Text style={styles.reply}>{reply}</Text>
        </Section>
      ) : null}
    </ScrollView>
  );
}

function AgentCatalog() {
  return (
    <ScrollView contentContainerStyle={styles.scrollContent}>
      <Section title="Mobile Runtime">
        <View style={styles.pathRow}>
          <Smartphone size={18} color={colors.muted} />
          <Text style={styles.pathText}>{MOBILE_AGENT_HOME}</Text>
        </View>
        <View style={styles.pathRow}>
          <TerminalSquare size={18} color={colors.muted} />
          <Text style={styles.pathText}>{MOBILE_AGENT_PREFIX}</Text>
        </View>
      </Section>
      {MOBILE_AGENTS.map((agent) => {
        const Icon = agent.icon;
        return (
          <View key={agent.id} style={styles.agentCard}>
            <View style={styles.agentHeader}>
              <Icon size={20} color={colors.text} />
              <Text style={styles.agentTitle}>{agent.label}</Text>
            </View>
            <CommandLine label="Install" value={agent.installCommand} />
            <CommandLine label="Login" value={agent.loginCommand} />
          </View>
        );
      })}
    </ScrollView>
  );
}

function CommandLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.commandLine}>
      <Text style={styles.commandLabel}>{label}</Text>
      <Text style={styles.commandText}>{value}</Text>
      <Play size={15} color={colors.muted} />
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppContent />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background
  },
  root: {
    flex: 1,
    backgroundColor: colors.background
  },
  header: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  headerActions: {
    alignItems: "center",
    flexDirection: "row",
    flexShrink: 0,
    gap: spacing.sm
  },
  title: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700"
  },
  subtitle: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 2
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38
  },
  tabs: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md
  },
  tabButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    paddingVertical: spacing.sm
  },
  tabButtonActive: {
    backgroundColor: colors.text,
    borderColor: colors.text
  },
  tabText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600"
  },
  tabTextActive: {
    color: "#ffffff"
  },
  content: {
    flex: 1
  },
  hiddenBridge: {
    height: 1,
    left: -10000,
    opacity: 0,
    position: "absolute",
    top: -10000,
    width: 1
  },
  scrollContent: {
    gap: spacing.md,
    padding: spacing.md,
    paddingBottom: spacing.xl
  },
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700"
  },
  selectRow: {
    gap: spacing.sm
  },
  fieldLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  choiceWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm
  },
  choice: {
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: "100%",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  choiceActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent
  },
  disabledChoice: {
    opacity: 0.5
  },
  choiceText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "600",
    maxWidth: 260
  },
  choiceTextActive: {
    color: colors.accentText
  },
  input: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    flex: 1,
    minHeight: 42,
    minWidth: 180,
    paddingHorizontal: spacing.md
  },
  prompt: {
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    color: colors.text,
    minHeight: 140,
    padding: spacing.md,
    textAlignVertical: "top"
  },
  primaryButton: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.accent,
    borderRadius: 8,
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 42,
    paddingHorizontal: spacing.lg
  },
  primaryButtonText: {
    color: colors.accentText,
    fontSize: 14,
    fontWeight: "700"
  },
  secondaryButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    minHeight: 42,
    paddingHorizontal: spacing.lg
  },
  secondaryButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700"
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm
  },
  statusText: {
    color: colors.muted,
    fontSize: 12
  },
  disabled: {
    opacity: 0.65
  },
  mutedText: {
    color: colors.muted,
    fontSize: 13
  },
  reply: {
    color: colors.text,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 13,
    lineHeight: 20
  },
  projectGroup: {
    gap: spacing.sm
  },
  projectTitleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm
  },
  projectTitle: {
    color: colors.muted,
    flex: 1,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  sessionRow: {
    alignItems: "center",
    backgroundColor: colors.surfaceMuted,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.md
  },
  sessionRowActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent
  },
  sessionTextWrap: {
    flex: 1,
    gap: 2
  },
  sessionTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700"
  },
  sessionTitleActive: {
    color: colors.accentText
  },
  sessionMeta: {
    color: colors.muted,
    fontSize: 12
  },
  sessionMetaActive: {
    color: colors.accentText
  },
  messageRow: {
    borderLeftColor: colors.border,
    borderLeftWidth: 2,
    gap: spacing.xs,
    paddingLeft: spacing.md
  },
  messageRole: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase"
  },
  messageText: {
    color: colors.text,
    fontSize: 13,
    lineHeight: 19
  },
  webView: {
    flex: 1
  },
  viewerFallback: {
    alignItems: "center",
    flex: 1,
    gap: spacing.md,
    justifyContent: "center",
    padding: spacing.lg
  },
  viewerTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "700"
  },
  pathRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm
  },
  pathText: {
    color: colors.text,
    flex: 1,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12
  },
  agentCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    gap: spacing.md,
    padding: spacing.md
  },
  agentHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: spacing.sm
  },
  agentTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "700"
  },
  commandLine: {
    alignItems: "center",
    backgroundColor: colors.surfaceMuted,
    borderRadius: 8,
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  commandLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    width: 48
  },
  commandText: {
    color: colors.code,
    flex: 1,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 12
  }
});
