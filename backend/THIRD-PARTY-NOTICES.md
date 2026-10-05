# Third-Party Notices — Umbra OS backend

## oomol-lab/open-connector (gateway, Apache-2.0)

- Source: https://github.com/oomol-lab/open-connector
- License: Apache License, Version 2.0 — https://www.apache.org/licenses/LICENSE-2.0
- Local copy: `backend/third-party/open-connector-LICENSE.txt`
- Use in Umbra: **runtime gateway only**. Umbra calls the published Docker
  image `ghcr.io/oomol-lab/open-connector:latest` (or npm
  `@oomol-lab/open-connector` / SDK `@oomol-lab/connector`) over HTTP
  (`/v1/*`, `/mcp`). No open-connector provider source is copied into this
  repo. Under Apache-2.0 §1 this is a separable client binding by name, not
  a Derivative Work — Umbra's own MIT code stays MIT.
- If you vendor/modify open-connector source into this repo later, Apache-2.0
  §4 applies: (a) ship a copy of the License, (b) mark modified files with
  prominent change notices, (c) retain copyright/patent/trademark/attribution
  notices, (d) reproduce the NOTICE attribution below in a NOTICE file / docs
  / display. Trademark use limited to describing origin (§6). No warranty (§7).

### Upstream NOTICE (verbatim from open-connector NOTICE.md)

> OOMOL Connect is licensed under the Apache License, Version 2.0, except
> where otherwise noted.
>
> Third-party provider and app names, trademarks, logos, icons, service marks,
> trade names, APIs, documentation, and brand assets remain the property of
> their respective owners.
>
> References to third-party providers are included for identification and
> interoperability only. Such references do not imply endorsement,
> sponsorship, partnership, certification, or verification by the
> third-party owner.

That disclaimer also covers Umbra's connector catalog: `Gmail / Slack /
Notion / GitHub / …` names are shown only to identify services the user can
connect. No endorsement by those owners is implied.
