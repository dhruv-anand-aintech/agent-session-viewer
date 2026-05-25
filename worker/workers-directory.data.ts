export type DirectoryWorker = {
  name: string
  title: string
  url: string
  description: string
  source: "cloudflare" | "local" | "manual"
  enabled: boolean
  tags: string[]
}

export type DirectoryConfig = {
  generatedAt: string
  publicUrl: string
  workers: DirectoryWorker[]
}

export const directoryConfig: DirectoryConfig = {
  "generatedAt": "2026-05-15T03:19:58.795Z",
  "publicUrl": "https://dhruv-anand.workers.dev",
  "workers": [
    {
      "name": "agent-session-viewer",
      "title": "Agent Session Viewer",
      "url": "https://agent-session-viewer.dhruv-anand.workers.dev",
      "description": "Discovered from wrangler.toml",
      "source": "local",
      "enabled": false,
      "tags": [
        "local-config"
      ]
    },
    {
      "name": "agent-session-viewer-studies",
      "title": "Agent Session Viewer Studies",
      "url": "https://agent-session-viewer-studies.dhruv-anand.workers.dev",
      "description": "Discovered from wrangler.studies.toml",
      "source": "local",
      "enabled": true,
      "tags": [
        "local-config"
      ]
    },
    {
      "name": "agent-usage-limits",
      "title": "Agent Usage Limits",
      "url": "https://agent-usage-limits.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-15T03:16:26.837318Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "aintech-website",
      "title": "Aintech Website",
      "url": "https://ainorthstartech.com",
      "description": "Modified 2026-01-07T10:48:18.005765Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "alumni-founders",
      "title": "Alumni Founders",
      "url": "https://alumni-founders.dhruv-anand.workers.dev",
      "description": "Modified 2026-02-16T20:34:35.454036Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "claude-session-viewer",
      "title": "Claude Session Viewer",
      "url": "https://claude-session-viewer.dhruv-anand.workers.dev",
      "description": "Modified 2026-03-31T11:36:06.919434Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "cloudsweeper-www",
      "title": "Cloudsweeper Www",
      "url": "https://cloudsweeper.ainorthstar.tech",
      "description": "Modified 2026-04-14T13:09:37.867253Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "dawn-hat-778f",
      "title": "Dawn Hat 778f",
      "url": "https://dawn-hat-778f.dhruv-anand.workers.dev",
      "description": "Modified 2024-09-27T11:13:22.172668Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "delicate-base-eb39",
      "title": "Delicate Base Eb39",
      "url": "https://delicate-base-eb39.dhruv-anand.workers.dev",
      "description": "Modified 2024-10-18T23:16:32.664213Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "dhruv-anand",
      "title": "Dhruv Anand",
      "url": "https://dhruv-anand.dhruv-anand.workers.dev",
      "description": "Discovered from wrangler.directory.toml",
      "source": "local",
      "enabled": true,
      "tags": [
        "local-config"
      ]
    },
    {
      "name": "embed",
      "title": "Embed",
      "url": "https://embed.dhruv-anand.workers.dev",
      "description": "Modified 2024-10-18T23:18:12.590966Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "etymology-search",
      "title": "Etymology Search",
      "url": "https://wordsearch.ainorthstar.tech",
      "description": "Modified 2026-02-11T07:28:38.346766Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "etymology-viz",
      "title": "Etymology Viz",
      "url": "https://words.ainorthstar.tech",
      "description": "Modified 2026-02-02T06:56:10.928245Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "etymology-viz-production",
      "title": "Etymology Viz Production",
      "url": "https://etymology-viz-production.dhruv-anand.workers.dev",
      "description": "Modified 2026-01-30T06:48:17.019349Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "geoviz",
      "title": "Geoviz",
      "url": "https://geoviz.dhruv-anand.workers.dev",
      "description": "Modified 2026-01-08T11:25:11.068541Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "groww-frontend",
      "title": "Groww Frontend",
      "url": "https://groww.ainorthstar.tech",
      "description": "Modified 2026-03-27T16:48:10.182618Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "groww-rate-limiter",
      "title": "Groww Rate Limiter",
      "url": "https://groww-rate-limiter.dhruv-anand.workers.dev",
      "description": "Modified 2026-03-11T12:02:02.14527Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "groww-test",
      "title": "Groww Test",
      "url": "https://groww-test.dhruv-anand.workers.dev",
      "description": "Modified 2026-01-05T11:34:02.610495Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "home-debug",
      "title": "Home Debug",
      "url": "https://home-debug.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-07T09:41:54.913749Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "llm-ac",
      "title": "Llm Ac",
      "url": "https://llm-ac.dhruv-anand.workers.dev",
      "description": "Modified 2026-03-12T22:41:17.802911Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "network-traffic-monitor",
      "title": "Network Traffic Monitor",
      "url": "https://ugp.ainorthstar.tech",
      "description": "Modified 2026-03-03T18:11:55.557738Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "northstar-search",
      "title": "Northstar Search",
      "url": "https://northstar-search.dhruv-anand.workers.dev",
      "description": "Modified 2026-02-17T08:02:21.654469Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "otp-monitor-gmail-worker-production",
      "title": "Otp Monitor Gmail Worker Production",
      "url": "https://otp-monitor-gmail-worker-production.dhruv-anand.workers.dev",
      "description": "Modified 2026-02-09T11:13:56.725021Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "otp-monitor-worker-prod",
      "title": "Otp Monitor Worker Prod",
      "url": "https://otp-monitor-worker-prod.dhruv-anand.workers.dev",
      "description": "Modified 2026-02-09T10:34:27.806466Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "partner-preference-matcher",
      "title": "Partner Preference Matcher",
      "url": "https://partner-preference-matcher.dhruv-anand.workers.dev",
      "description": "Modified 2026-03-22T00:14:50.85818Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "places-insights",
      "title": "Places Insights",
      "url": "https://places-insights.ainorthstar.tech",
      "description": "Modified 2026-05-13T06:32:41.225771Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "pred-mark-proxy",
      "title": "Pred Mark Proxy",
      "url": "https://pred-mark-proxy.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-07T11:13:23.689947Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "rags-fyi",
      "title": "Rags Fyi",
      "url": "https://rags.fyi",
      "description": "Modified 2024-12-06T07:26:51.613819Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "reversity",
      "title": "Reversity",
      "url": "https://reversity.dhruv-anand.workers.dev",
      "description": "Modified 2024-10-19T00:13:19.828066Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "robots-experiment",
      "title": "Robots Experiment",
      "url": "https://robots-experiment.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-15T02:24:20.923659Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "search-app",
      "title": "Search App",
      "url": "https://search.ainorthstar.tech",
      "description": "Modified 2026-01-09T19:19:30.765915Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "vector-io",
      "title": "Vector Io",
      "url": "https://vector-io.com",
      "description": "Modified 2024-11-29T12:30:52.96441Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "walkaround",
      "title": "Walkaround",
      "url": "https://walkaround.ainorthstar.tech",
      "description": "Modified 2026-05-14T10:48:12.260522Z",
      "source": "cloudflare",
      "enabled": true,
      "tags": [
        "cloudflare",
        "custom-domain"
      ]
    },
    {
      "name": "walkaround-preview",
      "title": "Walkaround Preview",
      "url": "https://walkaround-preview.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-14T10:48:00.06962Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-0195e16-2877c0",
      "title": "Walkaround Preview 0195e16 2877c0",
      "url": "https://walkaround-preview-0195e16-2877c0.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-07T10:20:55.235306Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-0195e16-c010ee",
      "title": "Walkaround Preview 0195e16 C010ee",
      "url": "https://walkaround-preview-0195e16-c010ee.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-07T10:22:27.559502Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-01a4841-c6658e",
      "title": "Walkaround Preview 01a4841 C6658e",
      "url": "https://walkaround-preview-01a4841-c6658e.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-07T09:56:40.81768Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-09ec625-ca26fc",
      "title": "Walkaround Preview 09ec625 Ca26fc",
      "url": "https://walkaround-preview-09ec625-ca26fc.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-07T10:14:29.768939Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-2fce723-24bc02",
      "title": "Walkaround Preview 2fce723 24bc02",
      "url": "https://walkaround-preview-2fce723-24bc02.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-07T10:39:16.50347Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-2fce723-2e846a",
      "title": "Walkaround Preview 2fce723 2e846a",
      "url": "https://walkaround-preview-2fce723-2e846a.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-08T09:51:50.368733Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-2fce723-376a2d",
      "title": "Walkaround Preview 2fce723 376a2d",
      "url": "https://walkaround-preview-2fce723-376a2d.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-08T09:48:35.243917Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-2fce723-90f1e7",
      "title": "Walkaround Preview 2fce723 90f1e7",
      "url": "https://walkaround-preview-2fce723-90f1e7.dhruv-anand.workers.dev",
      "description": "Modified 2026-05-08T09:52:48.2316Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-7f725ba-413a1d",
      "title": "Walkaround Preview 7f725ba 413a1d",
      "url": "https://walkaround-preview-7f725ba-413a1d.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T18:51:45.9955Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-040ffa",
      "title": "Walkaround Preview 9e9412f 040ffa",
      "url": "https://walkaround-preview-9e9412f-040ffa.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:12:46.769787Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-08bec5",
      "title": "Walkaround Preview 9e9412f 08bec5",
      "url": "https://walkaround-preview-9e9412f-08bec5.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:27:06.880261Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-0f0ab6",
      "title": "Walkaround Preview 9e9412f 0f0ab6",
      "url": "https://walkaround-preview-9e9412f-0f0ab6.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:04:43.980833Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-0fb4e7",
      "title": "Walkaround Preview 9e9412f 0fb4e7",
      "url": "https://walkaround-preview-9e9412f-0fb4e7.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:11:13.739428Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-2739da",
      "title": "Walkaround Preview 9e9412f 2739da",
      "url": "https://walkaround-preview-9e9412f-2739da.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:39:33.438888Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-4473a2",
      "title": "Walkaround Preview 9e9412f 4473a2",
      "url": "https://walkaround-preview-9e9412f-4473a2.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:21:05.433681Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-902f57",
      "title": "Walkaround Preview 9e9412f 902f57",
      "url": "https://walkaround-preview-9e9412f-902f57.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:16:49.198798Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-adad16",
      "title": "Walkaround Preview 9e9412f Adad16",
      "url": "https://walkaround-preview-9e9412f-adad16.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:41:26.078734Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-b00c3b",
      "title": "Walkaround Preview 9e9412f B00c3b",
      "url": "https://walkaround-preview-9e9412f-b00c3b.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:19:14.735239Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-cf68a6",
      "title": "Walkaround Preview 9e9412f Cf68a6",
      "url": "https://walkaround-preview-9e9412f-cf68a6.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:34:11.786102Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-da2fcf",
      "title": "Walkaround Preview 9e9412f Da2fcf",
      "url": "https://walkaround-preview-9e9412f-da2fcf.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:14:45.742043Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-e269f2",
      "title": "Walkaround Preview 9e9412f E269f2",
      "url": "https://walkaround-preview-9e9412f-e269f2.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T20:11:32.180862Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-ee524c",
      "title": "Walkaround Preview 9e9412f Ee524c",
      "url": "https://walkaround-preview-9e9412f-ee524c.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T19:56:38.576432Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-9e9412f-f2b67b",
      "title": "Walkaround Preview 9e9412f F2b67b",
      "url": "https://walkaround-preview-9e9412f-f2b67b.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T18:58:20.88325Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-c1310c0-90894b",
      "title": "Walkaround Preview C1310c0 90894b",
      "url": "https://walkaround-preview-c1310c0-90894b.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T20:19:54.302736Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "walkaround-preview-c4ac7f3-b7a4c2",
      "title": "Walkaround Preview C4ac7f3 B7a4c2",
      "url": "https://walkaround-preview-c4ac7f3-b7a4c2.dhruv-anand.workers.dev",
      "description": "Modified 2026-04-11T20:16:28.775393Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "wifi-failover",
      "title": "Wifi Failover",
      "url": "https://wifi-failover.dhruv-anand.workers.dev",
      "description": "Modified 2026-02-11T12:43:45.594522Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    },
    {
      "name": "wifi-failover-production",
      "title": "Wifi Failover Production",
      "url": "https://wifi-failover-production.dhruv-anand.workers.dev",
      "description": "Modified 2026-02-11T12:33:49.657485Z",
      "source": "cloudflare",
      "enabled": false,
      "tags": [
        "cloudflare",
        "workers.dev"
      ]
    }
  ]
}
