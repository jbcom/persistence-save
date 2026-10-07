#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTH_ENV_PATTERN = /auth|password|token|secret|credential|cookie|gitea/i;
const AUTH_CONFIG_PATTERN = /(?:auth|password|token|secret|credential|cookie)[^=\r\n]*=/i;
const SAFE_RUNTIME_AUTH_ENVIRONMENT = new Set(['XAUTHORITY']);
const CI_INTERNAL_ENV_PATTERN = /^(?:ACTIONS_|RUNNER_)/i;

export function assertAnonymousNpmConfig(userConfig) {
  const contents = readFileSync(userConfig, 'utf8');
  if (AUTH_CONFIG_PATTERN.test(contents)) {
    throw new Error(`anonymous npm config contains authentication material: ${userConfig}`);
  }
}

export function createAnonymousEnvironment({ home, userConfig, baseEnv = process.env }) {
  assertAnonymousNpmConfig(userConfig);
  mkdirSync(home, { recursive: true });
  const globalConfig = path.join(home, 'empty-global.npmrc');
  writeFileSync(globalConfig, '# deliberately empty anonymous global config\n', { mode: 0o600 });

  const environment = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      value === undefined ||
      (AUTH_ENV_PATTERN.test(key) && !SAFE_RUNTIME_AUTH_ENVIRONMENT.has(key)) ||
      CI_INTERNAL_ENV_PATTERN.test(key) ||
      key === 'NODE_PATH'
    ) {
      continue;
    }
    if (/^npm_config_/i.test(key)) continue;
    environment[key] = value;
  }

  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_globalconfig: globalConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
  });
  return environment;
}

function runCli() {
  const separator = process.argv.indexOf('--');
  if (separator < 4 || separator === process.argv.length - 1) {
    throw new Error(
      'usage: anonymous-environment.mjs <home> <user-config> -- <command> [arguments...]',
    );
  }
  const [, , home, userConfig] = process.argv;
  const [command, ...args] = process.argv.slice(separator + 1);
  const output = execFileSync(command, args, {
    cwd: home,
    env: createAnonymousEnvironment({ home, userConfig }),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  process.stdout.write(output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCli();
}
