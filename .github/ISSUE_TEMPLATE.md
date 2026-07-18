<!--
SECURITY: Do not put vulnerability details, credentials, certificates, packet
captures, or private site data in a public issue. If GitHub shows "Report a
vulnerability" under this repository's Security tab, use that private form. If
it is absent, open only a minimal issue asking for a private security contact
channel. See SECURITY.md.

Before filing, search this fork's issues and read FAQ.md. Remove sections that
do not apply, but keep the environment and validation-source fields.
-->

## Request type

- [ ] Bug report
- [ ] Feature request
- [ ] Documentation
- [ ] Question

## Environment

- Fork commit or tag:
- Node.js version:
- Operating system/container:
- Transport: BACnet/IP / BACnet/SC / custom
- Peer or fixture and exact version: project mock / Java reference / emulator / vendor product
- Relevant non-secret configuration:

## Summary

Describe the problem or request and why it matters.

## Steps to reproduce

Provide the smallest safe, read-only reproducer possible. If mutation is
essential to reproduce the issue, identify the disposable test object and the
safety controls used.

1.
2.
3.

## Actual behavior

Include the operation name, sanitized error/diagnostic output, and whether the
result is repeatable.

## Expected behavior

Describe the expected callback, event, packet, or state transition. Cite a
standard clause or independent packet vector if relevant and legally shareable.

## Validation source

State whether this was observed with a mocked transport, this project's
BACnet/SC hub, the Java reference fixture, an emulator, or an operational vendor
peer. A same-project round trip is not independent interoperability evidence.

## Privacy and safety check

- [ ] I removed credentials, private keys, passphrases, operational certificates, and site/customer identifiers.
- [ ] I did not test a mutating operation against live or safety-critical equipment.
- [ ] This is not a vulnerability report containing non-public details.
