# Rollback target

Recorded 2026-10-05 21:52 UTC, before promoting preview DT2bjBmp to production.

| | Deployment |
|---|---|
| Rollback target (last known-good production) | `dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa` |
| URL | https://stormscope-j4cfe6ksb-sabihusman-4178s-projects.vercel.app |
| Bundle | `index-CZGMyuEV.js` |
| Created | 2026-10-01 07:13 UTC |
| Promoted over it | `dpl_4LpgrygbRLMmypaCBjZ7dQci2v6s` (stormscope-iwcl312np, bundle DT2bjBmp) |

One-line rollback (points the production alias stormscope-two.vercel.app back at CZGMyuEV):

```bash
MSYS_NO_PATHCONV=1 NODE_OPTIONS=--use-system-ca vercel rollback dpl_BD1Wwak4xAv22cVSBHDUUtziVVHa --yes
```

Verify after rolling back:

```bash
curl -s https://stormscope-two.vercel.app/ | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
```

Expected output: `assets/index-CZGMyuEV.js`.
