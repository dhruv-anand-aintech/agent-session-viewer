# UI efficiency benchmark

Measured on 2026-07-10 on the same Mac, before and after the NativeWind migration. Lower is better unless noted.

| Metric | Before | After | Change |
|---|---:|---:|---:|
| `src/App.tsx` LOC | 1,540 | 729 | -52.7% |
| Total mobile `src` TS/TSX LOC | 1,761 | 1,344 | -23.7% |
| `StyleSheet.create` entries | ~76 / 465-line tail | 0 | eliminated |
| Web JS bundle | 2,508,376 B | 2,521,833 B | +0.5% |
| Total web export | 2,509,612 B | 2,533,972 B | +1.0% |
| After JS gzip | not captured | 377,267 B | — |
| Warm export wall time | 4.02 s | 5.69 s | +41.5% |
| Local median TTFB | 0.954 ms | 0.827 ms | -13.3% |
| Local p95 TTFB | 1.706 ms | 1.277 ms | -25.1% |

The state, auth, bridge, and API orchestration remain in `App.tsx`; reusable controls and the viewer/session/agent presentation moved to `components.tsx`. Static UI now uses semantic NativeWind tokens and copy-owned section, field, choice, dropdown, button, and async/empty-state patterns. No navigation, auth, API contract, storage key, or update behavior changed.

## Verification and method

- Type safety: `npm run typecheck`
- Production export: `npm run web:export`
- Bundle: emitted `_expo/static/js/web/*.js`; gzip from `gzip -c`
- Export time: `/usr/bin/time -p npm run web:export` after one priming export
- TTFB: 40 sequential local `curl` requests to the exported `index.html`; median sample 20, p95 sample 38
- UI: exported app served locally and inspected through the running Edge CDP endpoint at 390×844 and 1280×900
- API isolation: all `/api/*` traffic was blocked/mocked during browser verification; no real API calls were made
- Screenshots: `/tmp/ui-after/asv-mobile-mobile.png` and `/tmp/ui-after/asv-mobile-desktop.png`

The TTFB samples are sub-millisecond local static-server measurements and are sensitive to scheduler noise. The migration targets authoring efficiency: it removes the monolithic StyleSheet and gives future screens one token and component vocabulary. The small web bundle/export-time increase is the explicit tradeoff for that shared native styling layer.
