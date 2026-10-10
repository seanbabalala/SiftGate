# Rancher Desktop deployment considerations

Rancher Desktop with the Moby engine is one supported local Docker environment.
This guide is generic; it does not describe a maintainer's running installation,
record a private engine endpoint or approve a migration.

- Choose the intended Docker socket per command; do not change a shared global
  context or restart the desktop engine as a side effect of development.
- Preserve the installation's existing caller URL, port and host-interface policy.
  A wildcard port mapping can widen network exposure compared with loopback.
- Container loopback is not host loopback. Review local dependency connectivity
  separately from provider credentials and public caller addresses.
- Keep persistent data outside image layers; rehearse ownership/file sharing and
  maintain a verified backup outside the VM.
- Use one supervisor and one SQLite writer. Container restart policies do not by
  themselves replace readiness monitoring, backup checks or a maintenance plan.
- Test native modules on each supported architecture rather than copying dependencies
  from macOS into Linux. A local ARM64 test does not prove AMD64 compatibility.

Use the [customer installer](customer-install.md) and the
[deployment/recovery checklist](pricing-deployment-handoff.md). Only explicitly
approved maintenance may change a serving installation.
