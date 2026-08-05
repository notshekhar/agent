# Third-party notice

`apps/web` is a fork of the web UI from **T3 Code**
(<https://github.com/t3-tools/t3code>), taken at upstream commit `94331c58e`
and used under the MIT License. The upstream license text is kept verbatim in
`LICENSE-t3code`.

Three upstream workspace packages are vendored into this app rather than
depended on, so the app builds with no upstream workspace present:

| upstream package         | vendored at            |
| ------------------------ | ---------------------- |
| `@t3tools/contracts`     | `src/loop/contracts/`  |
| `@t3tools/shared`        | `src/loop/shared/`      |
| `@t3tools/client-runtime`| `src/loop/runtime/`     |

They are reachable as `@loop/contracts`, `@loop/shared` and `@loop/runtime`
via tsconfig path aliases generated from the upstream `exports` maps.

The fork is loop-branded throughout and is driven by loop's own agent runtime,
so it no longer diffs cleanly against upstream. Upstream's own name is retained
only in this file and in `LICENSE-t3code`, as the MIT License requires.

`THIRD_PARTY_NOTICES.md` carries upstream's own notices for the dependencies it
bundles, and applies here unchanged.
