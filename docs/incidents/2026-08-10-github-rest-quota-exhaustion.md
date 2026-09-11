# GitHub REST quota exhaustion — 2026-08-10

This is a historical incident record. It describes the deleted lane-inference
dashboard. Its `/api/dashboard` surface and the `GITHUB_REFRESH_MS` and
`DASHBOARD_REFRESH_MS` settings were removed in PR #135.

## Summary

The former dashboard performed frequent GitHub enrichment and exhausted a
shared REST quota. The incident had no customer-data impact, but it blocked
other authenticated workflows that needed GitHub evidence.

## Historical Resolution

The retired dashboard added caching and request-budget safeguards. Those
controls belonged to the removed surface and are not part of the current Human
Attention reader, which reads coordination attention records without GitHub
enrichment.
