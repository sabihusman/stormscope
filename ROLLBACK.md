# Rollback target

Recorded 2026-10-17 20:35 UTC. Production was redeployed from the Vercel dashboard at 20:21 UTC (a redeploy of `dpl_G572sG4NTXhyRwGev96gr5aWwxmr`, same bundle, so that it picks up `AIRNOW_API_KEY`); the candidate preview eauvinv8w (bundle DoCD-UPF, commit 228169f) is not promoted.

| | Deployment |
|---|---|
| Rollback target (current production) | `dpl_EMspJRJQUDRgcttK5pVbb5QwxxdD` |
| URL | https://stormscope-ctx32h446-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-Lx2BNpwE.js` (commit 07c8a33; redeployed 2026-10-17 20:21 UTC from the dashboard) |
| Candidate (not promoted) | preview https://stormscope-eauvinv8w-sabihusman-4178s-projects.vercel.app, bundle `index-DoCD-UPF.js`, commit 228169f (redeploy of ee33pog3d with the key; dry run of that bundle green 2026-10-17) |

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
