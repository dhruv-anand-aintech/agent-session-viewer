import AsyncStorage from "@react-native-async-storage/async-storage";
import { ExternalLink, Play, RefreshCw, Send, Smartphone, TerminalSquare } from "lucide-react-native";
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
  getMobileAgent,
  type MobileAgentId
} from "./agentCatalog";
import {
  ASV_BASE_URL,
  asvFetch,
  canUseEmbeddedAuth,
  type AgentProvider,
  type AsvBridgeRequest,
  type ChatResponse,
  type ProvidersResponse
} from "./asvApi";
import { colors, spacing } from "./theme";

type TabId = "chat" | "viewer" | "agents";

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
const NativeWebView = WebView as React.ComponentType<any>;

function escapeScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/<\/script/gi, "<\\/script");
}

function AppContent() {
  const webViewRef = useRef<any>(null);
  const pendingRequests = useRef(new Map<string, PendingBridgeRequest>());
  const [activeTab, setActiveTab] = useState<TabId>("chat");
  const [providerId, setProviderId] = useState("local");
  const [agentId, setAgentId] = useState<MobileAgentId>("codex");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [reply, setReply] = useState("");
  const [sessionId, setSessionId] = useState("");

  const selectedAgent = useMemo(() => getMobileAgent(agentId), [agentId]);
  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === providerId),
    [providerId, providers]
  );
  const modelOptions = useMemo(() => {
    const fromProvider = selectedProvider?.modelOptionsByAgent?.[agentId] ?? [];
    const defaults = selectedAgent.defaultModel ? [selectedAgent.defaultModel] : [];
    return Array.from(new Set([...fromProvider, ...defaults])).filter(Boolean);
  }, [agentId, selectedAgent.defaultModel, selectedProvider]);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const saved = JSON.parse(raw) as Partial<{
          providerId: string;
          agentId: MobileAgentId;
          model: string;
          sessionId: string;
        }>;
        if (saved.providerId) setProviderId(saved.providerId);
        if (saved.agentId) setAgentId(saved.agentId);
        if (saved.model) setModel(saved.model);
        if (saved.sessionId) setSessionId(saved.sessionId);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ providerId, agentId, model, sessionId })
    ).catch(() => {});
  }, [agentId, model, providerId, sessionId]);

  useEffect(() => {
    if (!model && modelOptions[0]) setModel(modelOptions[0]);
  }, [model, modelOptions]);

  const bridgeFetch = useCallback(
    async <T,>(request: AsvBridgeRequest): Promise<T> => {
      if (!canUseEmbeddedAuth() || !webViewRef.current) {
        return asvFetch<T>(request);
      }
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const promise = new Promise<T>((resolve, reject) => {
        pendingRequests.current.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      });
      const script = `
        (async function() {
          try {
            var response = await fetch(${escapeScriptValue(request.path)}, {
              method: ${escapeScriptValue(request.method ?? (request.body ? "POST" : "GET"))},
              credentials: "include",
              headers: { "content-type": "application/json" },
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
    []
  );

  const loadProviders = useCallback(async () => {
    setStatus("Loading providers");
    try {
      const data = await bridgeFetch<ProvidersResponse>({ path: "/api/agent/providers" });
      setProviders(data.providers ?? []);
      const local = data.providers?.find((provider) => provider.id === providerId);
      if (!local && data.providers?.[0]) setProviderId(data.providers[0].id);
      setStatus("Providers loaded");
    } catch (error) {
      setStatus(Platform.OS === "web" ? "ASV web auth not connected" : error instanceof Error ? error.message : "Provider load failed");
    }
  }, [bridgeFetch, providerId]);

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
        mode: "chat",
        model: model || undefined,
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
  }, [agentId, bridgeFetch, busy, model, prompt, providerId, selectedAgent, sessionId]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.root}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Agent Session Viewer</Text>
            <Text style={styles.subtitle}>{status}</Text>
          </View>
          <Pressable style={styles.iconButton} onPress={loadProviders} accessibilityLabel="Refresh providers">
            <RefreshCw size={18} color={colors.text} />
          </Pressable>
        </View>

        <View style={styles.tabs}>
          <TabButton id="chat" activeTab={activeTab} setActiveTab={setActiveTab} label="Chat" />
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
                        disabled={provider.available === false}
                        onPress={() => setProviderId(provider.id)}
                      />
                    ))
                  ) : (
                    <Text style={styles.mutedText}>Sign in on the Viewer tab, then refresh.</Text>
                  )}
                </SelectRow>
                <SelectRow label="Agent">
                  {MOBILE_AGENTS.map((agent) => (
                    <ChoiceButton
                      key={agent.id}
                      label={agent.label}
                      active={agent.id === agentId}
                      onPress={() => setAgentId(agent.id)}
                    />
                  ))}
                </SelectRow>
                <SelectRow label="Model">
                  {modelOptions.length ? (
                    modelOptions.slice(0, 12).map((option) => (
                      <ChoiceButton key={option} label={option} active={option === model} onPress={() => setModel(option)} />
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

          {activeTab === "viewer" ? (
            <ViewerPanel webViewRef={webViewRef} onBridgeMessage={onBridgeMessage} />
          ) : null}

          {activeTab === "agents" ? <AgentCatalog /> : null}
        </View>
      </View>
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
  onBridgeMessage
}: {
  webViewRef: React.RefObject<any>;
  onBridgeMessage: (event: { nativeEvent: { data: string } }) => void;
}) {
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
  return (
    <NativeWebView
      ref={webViewRef}
      source={{ uri: ASV_BASE_URL }}
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      onMessage={onBridgeMessage}
      style={styles.webView}
    />
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
