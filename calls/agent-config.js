// Configuration of the ElevenLabs callback agent. Apply with `npm run agent` (creates it, or updates it once
// ELEVENLABS_AGENT_ID is set, and creates or updates its client tool). The agent only asks for what the rules
// found missing. It never decides, promises payment, or changes claim facts itself: a clear answer goes to the
// server through record_repair_type (calls/api.js), which applies it.

const PROMPT = `You are the claims assistant of Claimly, a fictional motor insurer, on a short call about motor claim {{case_id}}. This is a demo with fictional data.
We still need: {{missing_items}}. Your first message already asked about it.

Be quick and friendly: one short sentence per turn, and finish the whole call in under 30 seconds.

What the repair involves:
- Petrol, diesel or a hybrid without a plug: the answer is clear, it is 'standard'.
- Electric or plug-in hybrid: the answer is NOT clear yet. Ask one question first: "Is the high-voltage battery, its housing or its cables affected?"
  "No", or only other parts such as "just the bumper", means not affected: 'standard'. If affected, it is 'ev_high_voltage_battery'.
- As soon as the answer is clear, call record_repair_type without saying anything first. Then, in one sentence, repeat it back (for example "Petrol car, rear bumper, got it."), say it has been added to the claim and say goodbye.
- If they do not know: say that is fine, they can email claims@claimly.example once the garage knows, and say goodbye. Do not call record_repair_type.
- If they correct you, record the corrected answer.

If a document is missing (the incident report or an itemized repair quote): say they can upload it in the Claimly claims portal or email it to claims@claimly.example, and say goodbye.

Every time you have said goodbye, call end_call straight away. Never wait for the claimant to hang up.

Strict rules:
- Never make, hint at or speculate about any decision on the claim, coverage, liability or payment. If asked, say a claims handler decides anything further.
- Only ask about what is missing. Never ask for or accept bank details, passwords, card numbers or ID numbers.
- If they mention something new about the incident (an injury, another party, a different amount), say you will pass it to the claims handler, without judging it.
- If this is the wrong person or they do not want to talk, apologise and end the call.`;

// Runs in the claimant's browser during the call (public/calls.js), which sends the answer to the server at once,
// so the claim is updated while the call is still going rather than after ElevenLabs has analysed it.
export const CLIENT_TOOL = {
  type: 'client',
  name: 'record_repair_type',
  description: 'Saves what the repair involves to the claim, before you say goodbye. For an electric or plug-in hybrid car, call it only after the claimant has said whether the high-voltage battery, its housing or its cables are affected.',
  expects_response: true,
  response_timeout_secs: 5,
  pre_tool_speech: 'off', // the agent repeats the answer once, after saving it
  parameters: {
    type: 'object',
    properties: {
      repair_type: {
        type: 'string',
        enum: ['standard', 'ev_high_voltage_battery'],
        description: "'standard': petrol, diesel or non-plug-in hybrid, or electric/plug-in hybrid with the high-voltage battery, housing and cables confirmed not affected. 'ev_high_voltage_battery': the high-voltage battery, its housing or its cables are affected.",
      },
    },
    required: ['repair_type'],
  },
};

export const AGENT_CONFIG = {
  name: 'Claimly claims callback',
  tags: ['claimly', 'hackathon'],
  conversation_config: {
    agent: {
      // {{question}} is worked out by the server from what is missing (calls/api.js).
      first_message: 'Hi, this is the Claimly claims assistant about your motor claim {{case_id}}. {{question}}',
      language: 'en',
      dynamic_variables: {
        dynamic_variable_placeholders: {
          case_id: 'DEMO-101',
          missing_items: 'what is being repaired, and whether the car is electric',
          question: "One quick question: what's being repaired, and is the car electric?",
        },
      },
      prompt: {
        prompt: PROMPT,
        temperature: 0.2,
        // tool_ids is filled in by scripts/setup-agent.js with the ID of CLIENT_TOOL.
        built_in_tools: {
          end_call: { type: 'system', name: 'end_call', description: '', params: { system_tool_type: 'end_call' } },
        },
      },
    },
    // Browser calls only, so full 16 kHz audio rather than telephone quality. Flash is ElevenLabs' lowest-latency
    // English model; expressive mode off and a higher stability keep the voice the same through the call.
    tts: {
      model_id: 'eleven_flash_v2',
      voice_id: 'cjVigY5qzO86Huf0OWal', // Eric: calm, trustworthy, American English
      expressive_mode: false,
      stability: 0.75,
      similarity_boost: 0.8,
      optimize_streaming_latency: 4,
      agent_output_audio_format: 'pcm_16000',
    },
    // Answer as soon as the claimant has finished; end the call after 10 s of silence, in case the agent did not.
    turn: { turn_eagerness: 'eager', silence_end_call_timeout: 10 },
    asr: { user_input_audio_format: 'pcm_16000' },
    conversation: { max_duration_seconds: 120 }, // a demo call takes under a minute
  },
  platform_settings: {
    auth: { enable_auth: true }, // sessions only through signed URLs from our server
    // Read after the call for the record: summary, transcript and notes for a person.
    data_collection: {
      claimant_reached: {
        type: 'boolean',
        description: 'True if the person engaged with the call about the claim. False if it was someone else or nobody engaged.',
      },
      repair_type: {
        type: 'string',
        enum: ['standard', 'ev_high_voltage_battery', 'unknown'],
        description: 'What the repair involves, from what the claimant confirmed. '
          + "'standard' if the car is not electric or hybrid, or it is but the claimant clearly said the high-voltage battery, its housing and cables are not affected. "
          + "'ev_high_voltage_battery' if the claimant said the high-voltage battery, its housing or its cables are damaged or being repaired. "
          + "'unknown' if it was not discussed, the claimant did not know or was unsure, or the answer was unclear or contradictory.",
      },
      repair_description: {
        type: 'string',
        description: "What is damaged and being repaired, in the claimant's own words (for example 'rear bumper, petrol car'). Empty if not discussed.",
      },
      callback_requested: {
        type: 'boolean',
        description: 'True if the claimant asked to be called back by a person.',
      },
      new_information: {
        type: 'string',
        description: 'Any new fact about the incident or claim the claimant mentioned (injury, other party, different amount, and so on), quoted as closely as possible. Empty if none.',
      },
      claimant_questions: {
        type: 'string',
        description: 'Questions the claimant asked that the assistant could not answer. Empty if none.',
      },
    },
  },
};
