/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    /* 1. No circular dependencies (specs/16 §1)
     *
     * Legacy modules (agent, channels, cli, config, gateway, media, memory,
     * onboarding, providers, runtime, scheduler, tools, workspace) are
     * grandfathered and excluded from this check. The v1 codebase has a
     * pre-existing cycle (cli/service-onboarding ↔ cli/setup-wizard) which
     * will be resolved at the v2 cutover.
     */
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular dependencies are forbidden by module law §1. ' +
        'Refactor to remove the cycle.',
      from: {
        pathNot: [
          '^src/agent/',
          '^src/channels/',
          '^src/cli/',
          '^src/config/',
          '^src/gateway/',
          '^src/media/',
          '^src/memory/',
          '^src/onboarding/',
          '^src/providers/',
          '^src/runtime/',
          '^src/scheduler/',
          '^src/tools/',
          '^src/workspace/',
        ],
      },
      to: { circular: true },
    },

    /* 2. Ports are the foundation layer — must not import src/ modules */
    {
      name: 'ports-bottom-layer',
      severity: 'error',
      comment:
        'Ports (src/ports/) are the dependency target — they import ONLY ' +
        'from themselves and external packages. Importing a core/legacy ' +
        'module from a port file violates the hexagonal architecture.',
      from: { path: '^src/ports/' },
      to: {
        path: '^src/',
        pathNot: '^src/ports/',
      },
    },

    /*
     * 3. V2 core module boundary (specs/16 §1)
     *
     * V2 core modules (memcore, profiles, recall, context2, capture,
     * subagents, indexstore, security) may import ONLY from:
     *   - src/ports/          (interfaces)
     *   - src/shared/         (error types, utilities)
     *   - their own directory (sub-modules)
     *   - external packages   (node_modules)
     *
     * They MUST NOT import from legacy v1 modules (agent, channels, cli,
     * config, gateway, media, memory, onboarding, providers, runtime,
     * scheduler, tools, workspace) or from each other's internals.
     *
     * Note: this only restricts what security itself may import. Legacy
     * modules importing FROM security (e.g. src/tools/memory-tools.ts
     * importing src/security/credential-rejection) are unaffected — that
     * direction is covered by the legacy module exemption below.
     */
    {
      name: 'v2-core-boundary',
      severity: 'error',
      comment:
        'V2 core modules may only import from src/ports/, src/shared/, ' +
        'their own directory, and external packages. This rule blocks ' +
        'imports from legacy (v1) modules.',
      from: {
        path: '^src/(memcore|profiles|recall|context2|capture|subagents|indexstore|security)/',
      },
      to: {
        path: '^src/(agent|channels|cli|config|gateway|media|memory|onboarding|providers|runtime|scheduler|tools|workspace)/',
      },
    },

    /*
     * 4. Legacy module exemption
     *
     * Legacy v1 modules are grandfathered in. They may import from any
     * src/ module. This group exists to make the exemption explicit and
     * will be removed when the v1→v2 cutover is complete.
     *
     * Modules in this group: agent, channels, cli, config, gateway,
     * media, memory, onboarding, providers, runtime, scheduler, tools,
     * workspace.
     */
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsConfig: {
      fileName: 'tsconfig.json',
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'default'],
    },
  },
};
