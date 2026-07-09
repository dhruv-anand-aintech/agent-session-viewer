import { Check, ChevronDown, ExternalLink, ListTree, MessageSquare, Play, RefreshCw, Send, Smartphone, TerminalSquare } from "lucide-react-native";
import React from "react";
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";

import { MOBILE_AGENT_HOME, MOBILE_AGENT_PREFIX, MOBILE_AGENTS } from "./agentCatalog";
import { ASV_BASE_URL, type ProjectSummary, type SessionMeta, type TranscriptMessage } from "./asvApi";
import { classes, colors } from "./theme";

export type TabId = "chat" | "sessions" | "viewer" | "agents";
export type SelectOption = { value: string; label: string; detail?: string; disabled?: boolean };
const NativeWebView = WebView as React.ComponentType<any>;

function textFromContent(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const typed = block as { type?: string; text?: string; thinking?: string; name?: string };
    if (typed.type === "text") return typed.text ?? "";
    if (typed.type === "thinking") return typed.thinking ?? "";
    if (typed.type === "tool_use") return `[tool_use ${typed.name ?? ""}]`;
    if (typed.type === "tool_result") return "[tool_result]";
    return typed.type ? `[${typed.type}]` : "";
  }).filter(Boolean).join("\n");
}
function messageText(message: TranscriptMessage) { return textFromContent(message.message?.content).trim(); }
function messageRole(message: TranscriptMessage) { return message.message?.role || message.type || "message"; }
function sessionTitle(session: SessionMeta) { return session.customName || session.firstName || session.id.slice(0, 8); }
function projectLabel(path: string) { const clean = path.replace(/^[a-z-]+:/, ""); const parts = clean.split("/").filter(Boolean); return parts.slice(-2).join("/") || path; }
function sessionCanResumeWithClaude(session?: SessionMeta | null) { return String(session?.source ?? "").toLowerCase() === "claude"; }

export function TabButton({
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
      className={`min-h-[42px] flex-1 items-center justify-center rounded-full border px-2.5 ${activeTab === id ? "border-deep bg-deep" : "border-transparent bg-surface-muted"}`}
      onPress={() => setActiveTab(id)}
    >
      <Text
        className="text-center text-xs font-bold leading-4 text-ink"
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.78}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function ChoiceButton({
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
      className={`min-h-10 max-w-full justify-center rounded-full border px-4 ${active ? "border-deep bg-deep" : "border-white/10 bg-surface-muted"} ${disabled ? "opacity-50" : ""}`}
      disabled={disabled}
      onPress={onPress}
    >
      <Text className="max-w-[260px] text-sm font-semibold text-ink" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SelectRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-xs font-bold uppercase text-muted">{label}</Text>
      <View className="flex-row flex-wrap gap-2">{children}</View>
    </View>
  );
}

export function DropdownRow({
  label,
  value,
  options,
  emptyText,
  open,
  onToggle,
  onChange
}: {
  label: string;
  value: string;
  options: SelectOption[];
  emptyText?: string;
  open: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  return (
    <View className="gap-2">
      <Text className="text-xs font-bold uppercase text-muted">{label}</Text>
      {options.length ? (
        <DropdownControl value={value} options={options} open={open} onToggle={onToggle} onChange={onChange} />
      ) : (
        <Text className="text-[15px] leading-[22px] text-muted">{emptyText ?? "No options available"}</Text>
      )}
    </View>
  );
}

export function DropdownControl({
  value,
  options,
  open,
  onToggle,
  onChange
}: {
  value: string;
  options: SelectOption[];
  open: boolean;
  onToggle: () => void;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value) ?? options[0];
  return (
    <View className="w-full gap-2">
      <Pressable className={`min-h-[58px] flex-row items-center gap-2.5 rounded-[22px] border bg-surface-muted px-[18px] py-2.5 ${open ? "border-accent" : "border-white/10"}`} onPress={onToggle}>
        <View className="min-w-0 flex-1">
          <Text className="text-base font-bold text-ink" numberOfLines={1}>{selected?.label ?? "Select"}</Text>
          {selected?.detail ? <Text className="mt-0.5 text-[13px] text-muted" numberOfLines={1}>{selected.detail}</Text> : null}
        </View>
        <ChevronDown size={18} color={colors.muted} />
      </Pressable>
      {open ? (
        <ScrollView className="max-h-[260px] overflow-hidden rounded-[22px] border border-white/10 bg-surface" nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {options.map((option) => {
            const active = option.value === value;
            return (
              <Pressable
                key={option.value}
                className={`min-h-12 flex-row items-center gap-2.5 border-b border-white/10 px-4 py-2.5 ${active ? "bg-deep" : ""} ${option.disabled ? "opacity-50" : ""}`}
                disabled={option.disabled}
                onPress={() => onChange(option.value)}
              >
                <View className="min-w-0 flex-1">
                  <Text className={`text-sm font-semibold ${active ? "text-accent" : "text-ink"}`} numberOfLines={1}>
                    {option.label}
                  </Text>
                  {option.detail ? <Text className="mt-0.5 text-xs text-muted" numberOfLines={1}>{option.detail}</Text> : null}
                </View>
                {active ? <Check size={17} color={colors.accent} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className={classes.card}>
      <Text className="font-serif text-[22px] leading-7 text-ink">{title}</Text>
      {children}
    </View>
  );
}

export function ViewerPanel({
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
      <View className="flex-1 items-center justify-center gap-4 p-6">
        <TerminalSquare size={28} color={colors.text} />
        <Text className="font-serif text-[26px] text-ink">ASV Web</Text>
        <Pressable className={classes.secondaryButton} onPress={() => Linking.openURL(ASV_BASE_URL)}>
          <ExternalLink size={18} color={colors.text} />
          <Text className="text-sm font-bold text-ink">Open Viewer</Text>
        </Pressable>
      </View>
    );
  }
  if (!authToken) {
    return (
      <View className="flex-1 items-center justify-center gap-4 p-6">
        <TerminalSquare size={28} color={colors.text} />
        <Text className="font-serif text-[26px] text-ink">Sign in to ASV</Text>
        <Pressable className={classes.secondaryButton} onPress={onSignIn}>
          <ExternalLink size={18} color={colors.text} />
          <Text className="text-sm font-bold text-ink">Sign in with Google</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <NativeWebView
      source={{ uri: `${ASV_BASE_URL}/api/auth/mobile/finish?token=${encodeURIComponent(authToken)}` }}
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      className="flex-1"
    />
  );
}

export function SessionsPanel({
  projects,
  selectedSession,
  transcript,
  prompt,
  reply,
  busy,
  signedIn,
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
  signedIn: boolean;
  updateStatus: string;
  onRefresh: () => void;
  onOpenSession: (project: ProjectSummary, session: SessionMeta) => void;
  onPromptChange: (value: string) => void;
  onSendPrompt: () => void;
  onCheckUpdates: () => void;
}) {
  return (
    <ScrollView contentContainerClassName={classes.scroll}>
      <View className="flex-row flex-wrap gap-2.5">
        <Pressable className={classes.secondaryButton} onPress={onRefresh} disabled={busy}>
          <RefreshCw size={18} color={colors.text} />
          <Text className="text-sm font-bold text-ink">{busy ? "Loading" : "Refresh"}</Text>
        </Pressable>
        <Pressable className={classes.secondaryButton} onPress={onCheckUpdates}>
          <ExternalLink size={18} color={colors.text} />
          <Text className="text-sm font-bold text-ink">Update</Text>
        </Pressable>
      </View>
      {updateStatus ? <Text className="text-[13px] leading-[18px] text-muted">{updateStatus}</Text> : null}

      <Section title="Cloud Sessions">
        {projects.length === 0 ? (
          <Text className="text-[15px] leading-[22px] text-muted">{signedIn ? "No synced sessions found for this account." : "Sign in with Google, then refresh synced sessions."}</Text>
        ) : (
          projects.slice(0, 12).map((project) => (
            <View key={project.path} className="gap-3">
              <View className="mt-1 flex-row items-center gap-2">
                <ListTree size={16} color={colors.muted} />
                <Text className="flex-1 text-[13px] font-bold uppercase text-muted" numberOfLines={1}>{projectLabel(project.path)}</Text>
              </View>
              {(project.sessions ?? []).slice(0, 8).map((session) => (
                <Pressable
                  key={`${project.path}:${session.id}`}
                  className={`min-h-[84px] flex-row items-center gap-3.5 rounded-[28px] border px-3.5 py-3 ${selectedSession?.id === session.id ? "border-accent bg-surface" : "border-white/10 bg-surface-muted"}`}
                  onPress={() => onOpenSession(project, session)}
                >
                  <View className="relative h-[50px] w-[50px] items-center justify-center rounded-xl bg-deep">
                    <MessageSquare size={17} color={colors.muted} />
                    {selectedSession?.id === session.id ? <View className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full bg-[#5aa8ff]" /> : null}
                  </View>
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="text-base font-bold text-ink" numberOfLines={1}>
                      {sessionTitle(session)}
                    </Text>
                    <Text className="text-[13px] text-muted" numberOfLines={1}>
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
            <Text className="text-[15px] leading-[22px] text-muted">No messages loaded.</Text>
          ) : (
            transcript.slice(-24).map((message, index) => (
              <View key={`${message.timestamp ?? index}-${index}`} className="gap-2 rounded-[20px] border border-white/10 bg-deep/20 p-4">
                <Text className="text-xs font-bold uppercase text-muted">{messageRole(message)}</Text>
                <Text className="font-serif text-[17px] leading-[25px] text-ink">{messageText(message) || "[empty]"}</Text>
              </View>
            ))
          )}
          <TextInput
            className="min-h-[152px] rounded-[28px] border border-white/15 bg-composer p-5 font-serif text-[19px] leading-[27px] text-ink"
            multiline
            value={prompt}
            onChangeText={onPromptChange}
            placeholder="Send a follow-up using cloud Claude Code"
            placeholderTextColor={colors.muted}
          />
          <Pressable className={`${classes.primaryButton} ${busy ? "opacity-60" : ""}`} onPress={onSendPrompt} disabled={busy || !prompt.trim()}>
            {busy ? <ActivityIndicator color={colors.accentText} /> : <Send size={18} color={colors.accentText} />}
            <Text className="text-base font-bold text-white">
              {sessionCanResumeWithClaude(selectedSession) ? "Resume Claude" : "Ask Cloud Claude"}
            </Text>
          </Pressable>
        </Section>
      ) : null}

      {reply ? (
        <Section title="Cloud Claude Reply">
          <Text className="font-serif text-lg leading-[27px] text-ink">{reply}</Text>
        </Section>
      ) : null}
    </ScrollView>
  );
}

export function AgentCatalog() {
  return (
    <ScrollView contentContainerClassName={classes.scroll}>
      <Section title="Mobile Runtime">
        <View className="flex-row items-center gap-2.5">
          <Smartphone size={18} color={colors.muted} />
          <Text className="flex-1 font-mono text-xs text-ink">{MOBILE_AGENT_HOME}</Text>
        </View>
        <View className="flex-row items-center gap-2.5">
          <TerminalSquare size={18} color={colors.muted} />
          <Text className="flex-1 font-mono text-xs text-ink">{MOBILE_AGENT_PREFIX}</Text>
        </View>
      </Section>
      {MOBILE_AGENTS.map((agent) => {
        const Icon = agent.icon;
        return (
          <View key={agent.id} className={classes.card}>
            <View className="flex-row items-center gap-2.5">
              <Icon size={20} color={colors.text} />
              <Text className="text-lg font-bold text-ink">{agent.label}</Text>
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
    <View className="flex-row items-center gap-2.5 rounded-[18px] bg-surface-muted px-3.5 py-3">
      <Text className="w-12 text-xs font-bold text-muted">{label}</Text>
      <Text className="flex-1 font-mono text-xs text-ink">{value}</Text>
      <Play size={15} color={colors.muted} />
    </View>
  );
}
