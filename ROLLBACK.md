# Rollback target

Recorded 2026-10-19, before promoting the batch-1 audit build (commit a722df1: audit batch 1 — C1, H2 hardening, H3, H4, H5, M2, M10, M11; the hourly switch, place-zone cards, mouse scrolling, the event-based pop-up checks and the exit fix; the desktop layers button) to production.

| | Deployment |
|---|---|
| Rollback target (current production) | `dpl_8EHnQnEkpLossbE6Dg6qgJQiTz5e` |
| URL | https://stormscope-g80xgd0ca-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-g3zzlN7J.js` (commit 2775d83, promoted 2026-10-18 19:58 UTC) |
| Being promoted over it | the preview of commit a722df1 (bundle `index-NJvvQhms.js`), after its mocked dry run; the user's check of the batch-1 preview passed |

One-line rollback (points the production alias stormscope-two.vercel.app back at g3zzlN7J):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_8EHnQnEkpLossbE6Dg6qgJQiTz5e --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-g3zzlN7J.js`.

Older targets: `dpl_2Xz3uB1tyqsTNcGC1XYTvrGyTA2Q` (stormscope-or160hty9, bundle 5t87xqC4, 2026-10-18 06:38 UTC); `dpl_EMspJRJQUDRgcttK5pVbb5QwxxdD` (stormscope-ctx32h446, bundle Lx2BNpwE, the Oct 17 dashboard redeploy); `dpl_G572sG4NTXhyRwGev96gr5aWwxmr` (stormscope-79kjt7706, bundle Lx2BNpwE, promoted 2026-10-17 19:21 UTC); `dpl_3q7czgd88z2Be7g77mDWJj36u5dg` (stormscope-24k84utfa, bundle CVzWpx2B, 2026-10-10); `dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB` (stormscope-ab2udsek5, bundle DyDvRSBo, 2026-10-09); `dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4` (stormscope-3o42yesqx, bundle DT2bjBmp, 2026-10-05); `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` (stormscope-j4cfe6ksb, bundle CZGMyuEV, 2026-10-01).
