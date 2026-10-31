# Rollback target

Recorded 2026-10-31, before promoting preview d383nfb6j (bundle `index-DjJbrY6r.js`, commit 3d2c056: audit round 2, the re-audit fixes, redesign prompts 1–12, the mockup polish A and desktop layout B, the playback horizon fix and the rain summary fix) to production, on the user's explicit word.

| | Deployment |
|---|---|
| Rollback target (current production) | `dpl_6sQJK4VFb1uHpYgSXzGtKd85ML6H` |
| URL | https://stormscope-qdnv9ijn6-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-BdpcQM6R.js` (commit baa17b5, promoted 2026-10-19 06:09 UTC) |
| Promoted over it | `dpl_5TDdcrbkgibYk9huacqVn9fSi46j` (stormscope-d383nfb6j), bundle `index-DjJbrY6r.js` — its last mocked dry run was red on timing checks only (42/43 suites; the Now-map redraw check and a throttled walkthrough), stated to the user before the go-ahead |

One-line rollback (points the production alias stormscope-two.vercel.app back at BdpcQM6R):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_6sQJK4VFb1uHpYgSXzGtKd85ML6H --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-BdpcQM6R.js`.

Older targets: `dpl_8EHnQnEkpLossbE6Dg6qgJQiTz5e` (stormscope-g80xgd0ca, bundle g3zzlN7J, 2026-10-18 19:58 UTC); `dpl_2Xz3uB1tyqsTNcGC1XYTvrGyTA2Q` (stormscope-or160hty9, bundle 5t87xqC4, 2026-10-18 06:38 UTC); `dpl_EMspJRJQUDRgcttK5pVbb5QwxxdD` (stormscope-ctx32h446, bundle Lx2BNpwE, the Oct 17 dashboard redeploy); `dpl_G572sG4NTXhyRwGev96gr5aWwxmr` (stormscope-79kjt7706, bundle Lx2BNpwE, promoted 2026-10-17 19:21 UTC); `dpl_3q7czgd88z2Be7g77mDWJj36u5dg` (stormscope-24k84utfa, bundle CVzWpx2B, 2026-10-10); `dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB` (stormscope-ab2udsek5, bundle DyDvRSBo, 2026-10-09); `dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4` (stormscope-3o42yesqx, bundle DT2bjBmp, 2026-10-05); `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` (stormscope-j4cfe6ksb, bundle CZGMyuEV, 2026-10-01).
