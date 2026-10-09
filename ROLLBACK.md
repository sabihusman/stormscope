# Rollback target

Recorded 2026-10-09 02:48 UTC, after promoting preview 9hfo22lyg (bundle DyDvRSBo) to production.

| | Deployment |
|---|---|
| Rollback target (previous production) | `dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4` |
| URL | https://stormscope-3o42yesqx-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-DT2bjBmp.js` |
| Created | 2026-10-05 21:51 UTC |
| Now in production | `dpl_46XGr4Tbtzpzou6MDJZ1XatVySqB` (stormscope-ab2udsek5, promoted from preview 9hfo22lyg, bundle DyDvRSBo, commit 7e0c842) |

One-line rollback (points the production alias stormscope-two.vercel.app back at DT2bjBmp):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_8idjCSZ89DbsaF8RUnq8UbQDaYX4 --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-DT2bjBmp.js`.

Older target, if DT2bjBmp itself has to go: `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` (stormscope-j4cfe6ksb, bundle CZGMyuEV, 2026-10-01).
