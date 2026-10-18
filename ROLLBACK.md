# Rollback target

Recorded 2026-10-18, before promoting preview 791mhjxf4 (bundle 5t87xqC4, commit 06d592c) to production. Current production is the dashboard redeploy of Lx2BNpwE made 2026-10-17 20:21 UTC.

| | Deployment |
|---|---|
| Rollback target (current production) | `dpl_EMspJRJQUDRgcttK5pVbb5QwxxdD` |
| URL | https://stormscope-ctx32h446-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-Lx2BNpwE.js` (commit 07c8a33; redeployed 2026-10-17 20:21 UTC from the dashboard) |
| Being promoted over it | preview https://stormscope-791mhjxf4-sabihusman-4178s-projects.vercel.app, bundle `index-5t87xqC4.js`, commit 06d592c (dry run green 2026-10-18, phone check passed) |

One-line rollback (points the production alias stormscope-two.vercel.app back at this Lx2BNpwE deployment):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_EMspJRJQUDRgcttK5pVbb5QwxxdD --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-Lx2BNpwE.js`.

Older targets: `dpl_G572sG4NTXhyRwGev96gr5aWwxmr` (stormscope-79kjt7706, bundle Lx2BNpwE, promoted 2026-10-17 19:21 UTC); `dpl_3q7czgd88z2Be7g77mDWJj36u5dg` (stormscope-24k84utfa, bundle CVzWpx2B, 2026-10-10); `dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB` (stormscope-ab2udsek5, bundle DyDvRSBo, 2026-10-09); `dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4` (stormscope-3o42yesqx, bundle DT2bjBmp, 2026-10-05); `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` (stormscope-j4cfe6ksb, bundle CZGMyuEV, 2026-10-01).
