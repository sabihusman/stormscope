# Rollback target

Recorded 2026-10-17, before promoting preview hi2r7hf6g (bundle Lx2BNpwE, commit 07c8a33) to production.

| | Deployment |
|---|---|
| Rollback target (current production) | `dpl_3q7czgd88z2Be7g77mDWJj36u5dg` |
| URL | https://stormscope-24k84utfa-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-CVzWpx2B.js` (commit e822f57, promoted 2026-10-10) |
| Being promoted over it | preview https://stormscope-hi2r7hf6g-sabihusman-4178s-projects.vercel.app, bundle `index-Lx2BNpwE.js`, commit 07c8a33 (dry run green 2026-10-12) |

One-line rollback (points the production alias stormscope-two.vercel.app back at CVzWpx2B):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_3q7czgd88z2Be7g77mDWJj36u5dg --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-CVzWpx2B.js`.

Older targets: `dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB` (stormscope-ab2udsek5, bundle DyDvRSBo, 2026-10-09); `dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4` (stormscope-3o42yesqx, bundle DT2bjBmp, 2026-10-05); `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` (stormscope-j4cfe6ksb, bundle CZGMyuEV, 2026-10-01).
