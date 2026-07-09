export const colors = {
  background: "#1f201d",
  surface: "#2c2d29",
  surfaceMuted: "#262723",
  border: "#50514c",
  text: "#f4f0e8",
  muted: "#a7a39b",
  accent: "#cd6841",
  accentText: "#ffffff",
  danger: "#e07b66",
  code: "#f4f0e8",
  composer: "#30312d",
  deep: "#0b0c0a",
  link: "#d8795d"
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24
};

export const classes = {
  screen: "flex-1 bg-canvas",
  scroll: "gap-[18px] p-6 pb-9",
  card: "gap-4 rounded-[28px] border border-white/10 bg-surface p-5",
  field: "min-h-[58px] rounded-[22px] border border-white/10 bg-surface-muted px-[18px] text-base text-ink",
  primaryButton: "min-h-[52px] flex-row items-center gap-2.5 self-start rounded-full bg-accent px-[22px]",
  secondaryButton: "min-h-[42px] flex-row items-center gap-2 rounded-full border border-white/10 bg-surface-muted px-4"
} as const;
