## Summary

What changes, and why?

## Risk and compatibility

- Affected layers/services:
- User-visible behavior:
- Breaking change or migration:
- Network, parser, concurrency, security, or mutation risk:

## Evidence

List every command actually run and its result. Identify the peer for integration
results: mocked transport, project-owned BACnet/SC hub, Java reference fixture,
emulator, or vendor product.

```text
npm run ...
```

## Checklist

- [ ] I read and followed `CONTRIBUTING.md` and `SECURITY.md`.
- [ ] I added a regression test that fails for the original reason, where applicable.
- [ ] Parser/network changes include malformed, truncated, boundary, and resource-limit cases as applicable.
- [ ] I did not describe same-project encode/decode or mock results as independent interoperability evidence.
- [ ] Mutating tests use authorized disposable fixtures, and examples remain read-only by default.
- [ ] I updated JSDoc and public documentation for changed APIs, options, events, errors, or limitations.
- [ ] `npm run verify` passes, or I documented the exact blocker above.
- [ ] `npm run package:check` contains no secrets, test keys, generated artifacts, or unintended files.
- [ ] Commit messages use the repository's Conventional Commit format.

## Follow-up work

What remains intentionally out of scope?
