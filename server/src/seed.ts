import type { Core } from './core/core.js';
import type { Project } from './core/types.js';
import { ROLE_PRESETS } from './services/agents.js';

/** A demo project wired to mock accounts, so the full workflow can be explored without spending usage. */
export function seedDemo(core: Core): Project {
  const runnerId = core.runners.defaultRunnerId();
  const accA = core.accounts.create({ name: 'Demo account A (mock)', provider: 'mock', runner_id: runnerId, max_concurrent_runs: 2 });
  const accB = core.accounts.create({ name: 'Demo account B (mock)', provider: 'mock', runner_id: runnerId, max_concurrent_runs: 2 });
  const project = core.projects.create({
    name: 'Demo Shop',
    key: 'SHOP',
    description: 'A sandbox project driven by mock agents. Talk to the PM to see planning, delegation, implementation, review and merge end-to-end.',
    runner_id: runnerId,
  });
  core.agents.create(project.id, { name: 'Ada', slug: 'ada', is_pm: true, account_id: accA.id, ...ROLE_PRESETS.pm });
  core.agents.create(project.id, { name: 'Linus', slug: 'linus', account_id: accA.id, ...ROLE_PRESETS.backend });
  core.agents.create(project.id, { name: 'Grace', slug: 'grace', account_id: accB.id, ...ROLE_PRESETS.frontend });
  core.agents.create(project.id, { name: 'Rex', slug: 'rex', account_id: accB.id, ...ROLE_PRESETS.reviewer });
  return core.projects.get(project.id);
}
