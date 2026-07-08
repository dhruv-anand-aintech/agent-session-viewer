# Agent Session Viewer Mobile

Expo React Native shell for ASV on iOS, Android, and web.

It folds in the reusable Mobile Agents 2 primitives from `mobile-agents2-termux`:

- agent catalog: Codex, Claude Code, OpenCode, Cursor Agent
- Termux install commands: `mobile-agent-install <agent>`
- login commands for each agent
- app-private Android runtime paths
- ASV-backed chat/session sync through `/api/agent/*`

Run:

```sh
npm install
npm run web
npm run android
npm run ios
```

Use `EXPO_PUBLIC_ASV_BASE_URL` to point the app at another ASV deployment.
