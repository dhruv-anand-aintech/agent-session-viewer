/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.js", "./src/**/*.{js,jsx,ts,tsx}"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        canvas: "#1f201d",
        surface: "#2c2d29",
        "surface-muted": "#262723",
        ink: "#f4f0e8",
        muted: "#a7a39b",
        accent: "#cd6841",
        deep: "#0b0c0a",
        composer: "#30312d",
        danger: "#e07b66"
      },
      fontFamily: {
        serif: ["Georgia", "serif"],
        mono: ["Menlo", "monospace"]
      }
    }
  },
  plugins: []
};
