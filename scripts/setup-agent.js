// Usage: npm run agent
// Creates the ElevenLabs callback agent and saves its ID to .env.local, or updates it if ELEVENLABS_AGENT_ID is set.
import { appendFileSync } from 'node:fs';
import { AGENT_CONFIG } from '../calls/agent-config.js';
import { readEnv } from '../env.js';

const ENV_FILE = '.env.local';
const env = readEnv(ENV_FILE);

if (!env.ELEVENLABS_API_KEY) {
  console.error(`Set ELEVENLABS_API_KEY in ${ENV_FILE} first.`);
  process.exit(1);
}

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
  console.log(`Updated agent ${existing}.`);
} else {
  const { agent_id: agentId } = await response.json();
  appendFileSync(ENV_FILE, `\nELEVENLABS_AGENT_ID=${agentId}\n`);
  console.log(`Created agent ${agentId} and saved it to ${ENV_FILE}. Restart npm start.`);
}
