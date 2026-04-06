#!/usr/bin/env node

/**
 * unicli — The universal interface between AI agents and the world's software.
 */

import { createCli } from "./cli.js";

const program = await createCli();
program.parse(process.argv);
