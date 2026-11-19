// Manual demo (not a test): AgentOS + simulated Claude Code on the web + simulated GitHub.
//   npx tsx test/demo-cloud.ts   → prints the dashboard URL (password: demo-password-123)
import { startServer } from '../src/server.js';
import { FakeGitHub } from './fakes/fake-github.js';
import { FakeClaudeCloud, teamBehaviour } from './fakes/fake-cloud.js';
import { tmpDir } from './helpers.js';

const gh = new FakeGitHub('ghp_demo');
await gh.start();
let url = '';
const cloud = new FakeClaudeCloud(() => url, gh.bare, async (s) => {
  await new Promise((r) => setTimeout(r, 1500)); // make sessions visible as "working" for a moment
  await teamBehaviour(s);
});
await cloud.start();
process.env.AGENTOS_OWNER_PASSWORD = 'demo-password-123';
const srv = await startServer({ dataDir: tmpDir('agentos-cloud-demo-'), port: Number(process.env.PORT ?? 4700), publicUrl: 'https://agentos.example.com', githubApiUrl: gh.url, embeddedRunner: false });
url = srv.url;
const core = srv.core;
const a = core.accounts.create({ name: 'Max account A', provider: 'claude-cloud', fire_url: `${cloud.url}/v1/claude_code/routines/trig_01DEMOA/fire`, fire_token: 'sk-ant-oat01-demoA' });
const b = core.accounts.create({ name: 'Max account B', provider: 'claude-cloud', fire_url: `${cloud.url}/v1/claude_code/routines/trig_01DEMOB/fire`, fire_token: 'sk-ant-oat01-demoB' });
cloud.routines.set('trig_01DEMOA', { token: 'sk-ant-oat01-demoA', networkSecret: a.cloud_token! });
cloud.routines.set('trig_01DEMOB', { token: 'sk-ant-oat01-demoB', networkSecret: b.cloud_token! });
// The dashboard's MCP URL would be the public URL; the simulated sessions talk to the local server.
const p = core.projects.create({ name: 'Cloud Shop', key: 'CLD', description: 'Agents work as Claude Code on the web sessions on github.com/acme/shop.', workspace_mode: 'github', repo_url: 'https://github.com/acme/shop', github_token: 'ghp_demo', autonomy: 'autonomous' });
core.agents.create(p.id, { name: 'Ada', role: 'Project Manager', is_pm: true, account_id: a.id });
core.agents.create(p.id, { name: 'Linus', role: 'Backend Developer', account_id: a.id });
core.agents.create(p.id, { name: 'Grace', role: 'Frontend Developer', account_id: b.id });
core.agents.create(p.id, { name: 'Rex', role: 'Code Reviewer', account_id: b.id, tool_profile: 'readonly' });
await core.github.ensureFiles(core.projects.get(p.id), (await import('../src/orchestrator/cloud.js')).cloudRepoFiles('https://agentos.example.com'), 'Connect cloud agents to AgentOS');
console.log(`READY ${srv.url}`);
