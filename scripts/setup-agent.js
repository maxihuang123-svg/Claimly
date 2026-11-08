// Usage: npm run agent
// Creates the ElevenLabs callback agent and saves its ID to .env.local, or updates it if ELEVENLABS_AGENT_ID is set.
// Its client tool (CLIENT_TOOL) is created once and updated after that, found by its name.
import { appendFileSync } from 'node:fs';
import { AGENT_CONFIG, CLIENT_TOOL } from '../calls/agent-config.js';
import { readEnv } from '../src/env.js';

const ENV_FILE = '.env.local';
const env = readEnv(ENV_FILE);

if (!env.ELEVENLABS_API_KEY) {
  console.error(`Set ELEVENLABS_API_KEY in ${ENV_FILE} first.`);
  process.exit(1);
}

async function elevenLabs(path, method = 'GET', body = undefined) {
  const reply = await fetch(`https://api.elevenlabs.io/v1/convai${path}`, {
    method,
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  if (!reply.ok) {
    console.error(`ElevenLabs ${reply.status}: ${await reply.text()}`);
    process.exit(1);
  }
  return reply.json();
}

const { tools } = await elevenLabs('/tools');
const tool = tools.find((entry) => entry.tool_config?.name === CLIENT_TOOL.name);
const toolId = tool
  ? (await elevenLabs(`/tools/${tool.id}`, 'PATCH', { tool_config: CLIENT_TOOL }), tool.id)
  : (await elevenLabs('/tools', 'POST', { tool_config: CLIENT_TOOL })).id;
console.log(`${tool ? 'Updated' : 'Created'} tool ${CLIENT_TOOL.name} (${toolId}).`);
AGENT_CONFIG.conversation_config.agent.prompt.tool_ids = [toolId];

const existing = env.ELEVENLABS_AGENT_ID;
const response = await fetch(
  existing ? `https://api.elevenlabs.io/v1/convai/agents/${existing}` : 'https://api.elevenlabs.io/v1/convai/agents/create',
  {
    method: existing ? 'PATCH' : 'POST',
    headers: { 'xi-api-key': env.ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(AGENT_CONFIG),
  },
);
if (!response.ok) {
  console.error(`ElevenLabs ${response.status}: ${await response.text()}`);
  process.exit(1);
}

if (existing) {
  await response.text(); // read the reply, or the open connection keeps the script running
  console.log(`Updated agent ${existing}.`);
} else {
  const { agent_id: agentId } = await response.json();
  appendFileSync(ENV_FILE, `\nELEVENLABS_AGENT_ID=${agentId}\n`);
  console.log(`Created agent ${agentId} and saved it to ${ENV_FILE}. Restart npm start.`);
}
