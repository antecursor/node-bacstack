# Security policy

## Project status and supported versions

This fork is pre-release and is not represented as production-ready or
independently security-audited. Security reports are accepted for the current
fork development branch and, once fork-owned releases exist, the latest
fork-owned release line. Historical upstream releases and the package installed
by a bare `npm install bacstack` are not maintained through this fork's reporting
process.

| Version | Security reports accepted here |
| --- | :---: |
| Current `antecursor/node-bacstack` development branch | Yes |
| Latest fork-owned release, when one is published | Yes |
| Older fork prereleases | Case by case |
| Releases maintained only by the original project | No |

Acceptance of a report means it will be triaged; it is not a claim that the
affected code is ready for production use.

## Report a vulnerability privately

Do not put vulnerability details in a public issue. When this repository shows
GitHub's **Report a vulnerability** button, use its private advisory form:

**[Privately report a security vulnerability](https://github.com/antecursor/node-bacstack/security/advisories/new)**

The form is available from **Security → Advisories → Report a vulnerability**
while signed in to GitHub, when the repository setting is enabled. This project
does not publish a security-reporting email address; do not send reports to
contacts associated with the original upstream repository.

If GitHub does not offer the private form, [open a minimal public
issue](https://github.com/antecursor/node-bacstack/issues/new) asking the
maintainer to enable or provide a private security contact channel. Include no
vulnerability, impact, reproduction, device, network, or site details in that
issue. Enabling GitHub private vulnerability reporting is a required gate before
this fork is publicly announced as a release candidate.

Include, when available:

- affected fork commit/tag and Node.js version;
- transport (`BACnet/IP` or `BACnet/SC`) and relevant non-secret options;
- impact, prerequisites, and whether untrusted network input can trigger it;
- a minimal reproducer, malformed packet bytes, or sanitized capture;
- observed versus expected behavior;
- suggested mitigation or patch, if known.

Remove credentials, private keys, passphrases, operational certificates,
customer names, public IPs, internal topology, device names, and other site data.
If a reproducer needs sensitive material, describe that fact in the initial
private report and coordinate a safer transfer method before sending it.

## What to expect

Reports are handled on a best-effort basis while the fork is pre-release. The
maintainer will use the private advisory to acknowledge and triage the report,
ask for missing details, coordinate a fix and regression coverage, and discuss
disclosure timing. Please allow a reasonable opportunity to investigate before
publishing details.

No fixed response or remediation SLA is promised at this stage. If the report
affects the original project or another dependency, the reporter and maintainer
should agree privately on the appropriate upstream/vendor coordination rather
than copying sensitive details into a public tracker.

## High-interest security areas

Reports are especially useful for:

- crashes, hangs, out-of-bounds parsing, or excessive allocation from malformed
  BVLC, NPDU, APDU, ASN.1, BACnet service, WebSocket, or BACnet/SC input;
- TLS verification, hostname validation, certificate/key handling, or downgrade
  problems;
- request replay after timeout/reconnect, unsafe write behavior, invoke-ID
  confusion, response misattribution, or cross-peer segmentation state;
- unbounded queues, timers, listeners, reconnect loops, CPU use, or memory use;
- routing/address confusion that sends a request to or accepts a response from
  the wrong peer;
- package contents, dependency integrity, CI credentials, or release provenance.

## Safe deployment guidance

Until production gates are complete, use the fork only on controlled test
networks. Keep examples read-only, pin the dependency to a reviewed commit, use
WSS with certificate validation and unique operational credentials, apply
network allowlists, bound timeouts and queues, monitor transport diagnostics,
and avoid life-safety or other critical control paths.

Certificates and private keys under `test/fixtures/sc-certs` are public test
fixtures. They provide no secrecy or identity and must never be trusted or
installed outside disposable tests.
