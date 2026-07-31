/**
 * @owner       src::adapters::linux-do::site
 * @does        Declares Linux.do site-level browser and credential metadata before command registration.
 * @needs       Core adapter registry.
 * @feeds       Auth setup/check, command discovery, and every Linux.do command module.
 * @breaks      Missing metadata would advertise an authenticated browser-only site as a public web API.
 * @invariants  The Discourse `_t` session cookie is the account-authentication marker.
 * @side-effects Registers one empty site manifest; command modules merge their commands into it.
 * @perf        One O(1) registry mutation at module initialization.
 * @concurrency Module initialization is serialized by the ESM loader.
 * @test        src/adapters/linux-do/browser-json.test.ts
 * @stability   experimental
 * @since       2026-07-31
 */

import { registerAdapter, Strategy } from "../../registry.js";
import { AdapterType } from "../../types.js";

registerAdapter({
  name: "linux-do",
  type: AdapterType.BROWSER,
  domain: "linux.do",
  strategy: Strategy.COOKIE,
  browser: true,
  authCookies: ["_t"],
  commands: {},
});
