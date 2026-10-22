# Licensing and upstream attribution

Inboxfm Connect is an independent fork of [Activepieces](https://github.com/activepieces/activepieces). Renaming the application does not change the licenses attached to inherited code.

## Applicable notices

| Material | Applicable notice |
| --- | --- |
| Most source outside the restricted directories | [Root LICENSE](LICENSE): MIT Expat, with the stated exclusions and third-party terms |
| `packages/ee/` and `packages/server/api/src/app/ee/` | [Activepieces Enterprise license](packages/ee/LICENSE) |
| SDK | [packages/connect-sdk/LICENSE](packages/connect-sdk/LICENSE) |
| Documentation with its own notice | [docs/LICENSE](docs/LICENSE) |
| Adapted Code of Conduct | Creative Commons Attribution-ShareAlike 3.0 and source attribution in [.github/CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) |
| Other third-party components | Their original owners' applicable licenses; the root notice explicitly preserves these |

The original Activepieces copyright, MIT permission notice, and Enterprise license text are retained. The root and Enterprise notices were compared with the [upstream root license](https://github.com/activepieces/activepieces/blob/main/LICENSE) and [upstream Enterprise license](https://github.com/activepieces/activepieces/blob/main/packages/ee/LICENSE) during the September 2026 repository-readiness review and matched after line-ending normalization.

## Enterprise restrictions

The Enterprise license allows copying and modifying Enterprise material for development and testing without a subscription. Production use requires a valid Activepieces Enterprise license and compliance with Activepieces' applicable terms or another agreement with Activepieces. It also restricts rights in modifications and distribution; the permissions are not equivalent to MIT.

Do not treat `AP_EDITION=ce`, a feature flag, a passing test, or a new file location as permission to use restricted code. Do not copy an Enterprise implementation into an MIT directory and call it original. Existing code relocation or replacement requires provenance review.

For hackathon contributions, work outside the Enterprise directories and use local development/test environments with data and accounts you control. A production launch or redistribution containing Enterprise material requires reviewing the actual license and applicable agreement with Activepieces.

## Current repository limitations

The Enterprise directories remain present. There are existing imports into them from outside those directories, including application registration and database paths, and inherited Enterprise files have been modified on this fork. Previous statements that Enterprise code was pristine or entirely absent from the dependency graph were inaccurate.

The Connect API-key, OAuth configuration, session, and SDK modules have their own locations outside Enterprise directories. Their location alone does not establish an independent provenance review for every implementation. The planned removal and replacement of remaining Enterprise dependencies is tracked in [#25](https://github.com/Mihir-Rabari/inboxfm-connect/issues/25).

This documentation records source and notice checks. It is not a legal clearance, an Activepieces license, or a statement that a particular deployment satisfies a separate agreement.

## Contributor responsibilities

- Retain upstream and third-party copyright notices and license texts.
- Keep acknowledgements in [UPSTREAM_CREDITS.md](UPSTREAM_CREDITS.md); credits supplement the required license notices.
- Do not introduce new Enterprise imports from application or integration code.
- Do not strip, relabel, or relocate restricted code to change its apparent license.
- Supply only work you have the rights to contribute, under the applicable license for its location. Ask maintainers to review provenance before bringing in substantial external code.
- Do not imply Activepieces sponsors, supports, or endorses this independent fork.

## Automated checks

`npm run check-licenses` validates the recorded license notice hashes and checks static imports, re-exports, literal `require()`/`import()` calls, and TypeScript import types for new references into Enterprise directories or workspace packages.

[tools/ci/license-policy.json](tools/ci/license-policy.json) records existing production-source imports as debt, rather than silently declaring them safe. Test fixtures are excluded because Enterprise development/testing has separate permission. Removing a recorded dependency is allowed; expanding or changing the policy requires explicit licensing review.

This guard cannot establish the provenance of copied code, inspect arbitrary dynamic paths, or grant rights under a contract. Its purpose is to catch accidental expansion and notice loss while the remaining cleanup is tracked.
