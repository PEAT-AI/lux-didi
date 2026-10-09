# Cloud deployment path

Status: designed path, not a deployment. Nothing here has been provisioned, purchased or run, and
no cloud account exists for this project. The decision that makes this path reachable is recorded
in [decisions.md](decisions.md) and implemented by the portable service seam (A19); the operational
runbook it describes is planned work (E11), not a finished artifact.

## What the path is, and what it is not

The assistant is one TypeScript and Node service with a SQLite store. That same process is what the
Mac companion talks to over the loopback interface today, and it is what a Linux virtual machine
would run later. Portability is therefore a property of the existing service rather than a second
product, and the contract does not change between the two placements.

The path is explicitly separated from two things it is often confused with:

- **Hosting this assistant** is what this document covers. It is a deployment of one process with
  one store and one authority epoch.
- **Migrating another repository or service** is not covered and is not implied. Other Lux packages
  and sibling repositories keep their own installation and their own data ownership. Nothing here
  authorizes a change to them, and this assistant shares no runtime directory or database with
  them.

There is also no authorization to deploy. The work below is a design and rehearsal obligation; a
later, explicit decision is required before any host is created.

## Placement and the single authority

One assistant has exactly one active authority epoch (C21). The epoch names the holder, and every
write path must present the epoch token. A laptop and a virtual machine must never both hold the
epoch: there is no cloud and local multi-writer synchronization, no last-writer-wins merge, and no
automatic transfer. Moving the assistant from the laptop to the virtual machine is an explicit
transfer with prepare, quiesce, revoke, activate and verify steps, and the old holder's writes are
refused afterwards rather than reconciled.

The initial shape is one database per assistant. Running more than one assistant, or isolating one
assistant's store per tenant, is a later question and not a first requirement.

A transfer never promotes a new holder merely because the old holder is unreachable. Unavailability
is not a reason for automatic promotion, because a partitioned host can return with its own restored
store. Promotion requires a demonstrated fence: the new holder shows that the old holder cannot
write, and the runbook records how that was shown. When the old host does return, it holds a stale
epoch token, it cannot take the store writer lock, and its writes and queued intents are refused
rather than merged. The runbook names the read-only recovery mode an operator uses on a returning
holder while a transfer is incomplete, and the rehearsal runs a partition and resume cycle against a
separate restored store, not only two processes sharing one store.

A device reaches the service through the same contract whether it runs on the laptop or on a virtual
machine, but only over an explicitly bound local network path with pairing. The loopback interface
serves the laptop alone.

## Deployment artifacts

- A container image built from the same entry point the laptop runs, with a pinned runtime version
  and a non-root user.
- A systemd unit carrying restart policy, memory and file-descriptor bounds, and log routing.
- A provider-neutral runbook covering host preparation, first start, upgrade, rollback and
  teardown, with interchangeable notes for two major providers rather than a provider-specific
  automation stack.
- A readiness endpoint so the runbook can prove health instead of assuming it.

Public references for the artifacts: <https://systemd.io/> and
<https://docs.docker.com/engine/reference/builder/>.

## Secret references

The image and the repository hold names, never values. A secret reference names a provider, an
account and a purpose; a resolver turns the reference into a value at call time, from the host's
protected store or the provider's secret service, and caches only in memory. References may appear
in configuration, logs and error text; values may not. Rotation replaces a value without a restart,
and the egress route table decides whether a call that needs a credential is permitted at all.

Public references: <https://cloud.google.com/secret-manager/docs> and
<https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html>.

## Backup, restore and rehearsal

A backup is a consistent snapshot of the store, written as an encrypted artifact with a retention
rule. A restore verifies integrity before the service starts; a truncated artifact is rejected,
and a restore onto a newer schema stops rather than half-loading.

A migration rehearsal is performed on synthetic data before any real deployment: generate a corpus,
load it, back it up, restore into a clean host, and compare row counts and content digests. A
rehearsal proves the procedure, not production readiness, and the report says so.

Public reference: <https://www.sqlite.org/backup.html>.

## Egress and data classes

Moving the process off the laptop changes what leaves the machine, so the route table is evaluated
at the deployed service boundary as well as in the local mode. A request whose destination and
purpose are not classified is refused by default. A payload class that the route table does not
permit to a destination is blocked, and the product degrades (a local summary, or a question)
rather than sending anyway. Credential values never leave the process in a payload.

The host boundary also states what a cloud process does **not** hold: no local operating-system
authority, no device grant, and no implicit permission derived from being the host. A cloud
coordinator that wants a device effect must still obtain a device-specific grant, and the device
still enforces its own local grants.

Public reference: <https://cloud.google.com/architecture/framework/security> for the
shared-responsibility framing.

## Suite endpoints

Sibling Lux packages and client tools address the service through one declared base URL and a
discovery document that names the contract version, the available endpoints and the required
scopes. Each package remains independently installable, and installing one package never requires
installing another.

## Risks this path carries

Unavailable-host behaviour, backup decay, credential sprawl, cost surprise and accidental
multi-writer activation are tracked in [risks.md](risks.md). The acceptance order that keeps the
laptop-first product priority while this path is designed is in [acceptance.md](acceptance.md).
