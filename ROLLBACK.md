# Rollback target

Recorded 2026-10-10 after promoting preview iryrkwl8l (bundle CVzWpx2B, commit e822f57) to production.

| | Deployment |
|---|---|
| Rollback target (previous production) | `dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB` |
| URL | https://stormscope-ab2udsek5-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-DyDvRSBo.js` (commit 7e0c842) |
| Created | 2026-10-09 02:47 UTC |
| Now in production | `dpl_3q7czgd88z2Be7g77mDWJj36u5dg` (https://stormscope-24k84utfa-sabihusman-4178s-projects.vercel.app, promoted from preview iryrkwl8l, bundle CVzWpx2B, commit e822f57, 2026-10-10 07:20 UTC) |

One-line rollback (points the production alias stormscope-two.vercel.app back at DyDvRSBo):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-DyDvRSBo.js`.

Older targets: `dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4` (stormscope-3o42yesqx, bundle DT2bjBmp, 2026-10-05); `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` (stormscope-j4cfe6ksb, bundle CZGMyuEV, 2026-10-01).

Repository backup: `~/stormscope-backup-2026-10-10.bundle` (all branches; `git clone <bundle>` restores it).
