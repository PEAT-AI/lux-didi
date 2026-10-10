# Self-contained service tarball

The service has two direct runtime dependencies: the pinned official MCP client
and `ws`. It is not zero-dependency. `server/package.json` lists both existing
packages in `bundleDependencies`; `server/package-lock.json` identifies their
exact bundled production closure. This inventory introduces no new dependency.

| Direct runtime package | Pin | Upstream licence | Runtime use |
| --- | --- | --- | --- |
| `@modelcontextprotocol/client` | `2.3.1` | Apache-2.0 | MCP client adapter |
| `ws` | `8.22.0` | MIT | Live WebSocket transport and HTTP upgrade |

Pins and licence identifiers come from the committed manifest/lock. The Didi-owned
MCP SDK notice at `server/adapters/mcp/SDK-LICENSE.txt` and bundled upstream
licence/notice files must be retained; the release verifier checks their bytes.
The locked MCP server SDK is a development/test dependency, not a third direct
production dependency. Node itself, the OS and deployment configuration are not
bundled in this service tarball; native asset bundling is a separate artifact.

## Release proof

From a clean, committed checkout, run the focused producer:

```sh
bash scripts/check-package.sh
```

Managed workers run this argv through their registered foreground `check-run`,
not directly. A failed producer is a failed gate, including builder setup,
compilation, missing selected tests, archive verification or offline installation.
The script requires Node compatible with the service's `engines` and npm 11.
It obtains locked build dependencies from the registry in a new disposable
builder cache. This ordinary setup needs network access; target installs do not.
It does not use developer `node_modules`, a global dependency cache, or change
npm configuration files.

The producer exports **committed** server source, runs a clean `npm ci`,
typechecks and compiles the exact service tsconfig, then extends the enumerated
test list only inside the disposable builder. A second clean `npm ci --omit=dev`
uses the explicit builder cache offline to prepare the production tree. Only
that locked production tree and the compiled files feed `npm pack`. Temporary
builders, caches, installed targets and control tarballs are removed on exit.

The focused tests verify:

- Runtime dependency traversal from the committed lock, including required peer
  edges; agreement with production flags and the actual installed package graph.
  Counts are derived, never copied from npm's installation summary.
- Exact archive file inventory and sizes, compressed size and unpacked byte sum;
  packed service/compiled builder bytes and every included runtime file match
  the clean production install. No development or extraneous package, hidden
  dotenv/private path, unexpected service file or native binary is accepted.
  Bundled upstream `.npmignore` files are public packaging metadata, not secrets;
  they are the sole allowed vendor dotfile and are also byte-verified.
- Included upstream license/notice files match each clean runtime package, and
  the Didi-owned MCP SDK notice is included. This proves file inclusion, not a
  legal determination about redistribution.
- The existing HTTP packaging test, unchanged: a real tarball installs offline
  in a brand-new empty target cache and the actual installed production CLI
  serves authenticated, honest runtime-only status.
- A separate empty-cache install loads the **installed** MCP adapter, registry
  and result-store modules. Discovery without a configured endpoint is honestly
  unavailable; a closed adapter stays unavailable. This exercises SDK module
  resolution, not a live remote MCP server or credential-bearing integration.
- Disposable negative artifacts: absent bundles must fail empty-cache offline
  installation; a missing required runtime package must fail either installation
  or installed adapter loading. Wrong versions, missing/tampered runtime files
  and synthetic `.env` contents fail inventory/byte verification. Polluted input
  package graphs are rejected before packing and cannot become trusted artifacts.

The TAP output includes `PACKAGE_SOURCE` and an `ARTIFACT` summary with measured
sizes, inventory digest, lock-derived package versions and licenses. Archive
inventory is compared to npm's pack report and the extracted real tarball;
no cache warming or network fallback is allowed in any target installation.

## Boundaries

The committed `ws` 8.22.0 lock entry declares `bufferutil` and `utf-8-validate`
as optional peers. Neither has an installed package entry in the committed lock,
so neither peer is part of the realized locked/install closure, which has no
bundled native addon. npm 11's installed `npm-packlist` implementation traverses
bundled production/optional dependencies but explicitly excludes peer/dev edges;
bundling must not be assumed to cover declared or future peers. A future dependency graph change
must pass the same artifact and empty-cache gate or receive a separate packaging
decision. Platform-conditional optional packages and additional platforms are
not certified by a run on one host.

A green run establishes a self-contained tarball only on the Node version and
platform printed in that run. It does not certify bundled Node, every OS,
end-to-end MCP network execution, native/UI packaging, or deployment. If the
normal compiler ever omits adapter dist, the installed-adapter test fails at
that owning build gap rather than claiming success.
