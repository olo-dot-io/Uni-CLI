---
title: Operation catalog
description: Browse the current generated catalog by interface, site, command, and authentication mode.
---

# Operation Catalog

Uni-CLI publishes the same generated operation manifest to the docs site and
the command-line discovery tools. Search by site or command, filter by
interface, personal content, or authentication, then expand a site to inspect
every registered operation. Each row includes a matching `unicli describe`
command.

The command-line equivalent supports the same common paths.

```bash
unicli list --site <site>
unicli list --personalized
unicli search "<intent>" --personalized
```

<SiteCatalog />
