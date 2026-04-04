#!/usr/bin/env node

/**
 * unicli — CLI IS ALL YOU NEED
 *
 * Turn any website, desktop app, cloud service, or system tool
 * into a CLI command. 20-line YAML adapters. Zero LLM cost. Agent-native.
 */

import { createCli } from './cli.js';

const program = createCli();
program.parse(process.argv);
