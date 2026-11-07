// Configuration of the ElevenLabs callback agent. Apply with `npm run agent` (creates it, or updates it once
// ELEVENLABS_AGENT_ID is set). The agent only asks for what the rules found missing. It never decides,
// promises payment, or changes claim facts.

const PROMPT = `You are the automated claims assistant of Claimly, a fictional motor insurer. This is a demo with fictional data.
You are calling the claimant about motor claim {{case_id}}. Our claims rules found that we still need: {{missing_items}}.

Your job:
1. Ask for their full name before you say anything about the claim. Then ask them to confirm they submitted motor claim {{case_id}}. You have no name on file to compare it with, so do not say it matches; just use it politely for the rest of the call.
2. Explain which documents or details are still needed: {{missing_items}}. Say why in one sentence: the claim cannot move forward without them.
3. Explain how to send them: upload them in the Claimly claims portal, or email them to claims@claimly.example with the claim number in the subject.
4. Ask when they expect to send them, and whether anything prevents them.
5. Thank them and end the call.

Strict rules:
- Never make, hint at or speculate about any decision on the claim, coverage, liability or payment. If asked, say a claims handler decides once the documents are in.
- Only ask for the items listed above. Do not invent other requirements.
- Never ask for or accept bank details, passwords, card numbers or ID numbers.
- If the claimant mentions new facts about the incident (for example an injury, another party, a different repair amount), thank them, say you will pass it to the claims handler, and do not judge it.
- If this is not the claimant or they do not want to talk, apologise and end the call politely.
- Be warm, brief and clear. Use plain language. Keep the call under two minutes.`;

export const AGENT_CONFIG = {
  name: 'Claimly claims callback',
  tags: ['claimly', 'hackathon'],
  conversation_config: {
    agent: {
      first_message: 'Hello, this is the automated claims assistant from Claimly, calling about a motor claim. '
        + 'Before we go on, may I have your full name, please?',
      language: 'en',
      dynamic_variables: {
        dynamic_variable_placeholders: { case_id: 'DEV-002', missing_items: 'the incident report' },
      },
      prompt: { prompt: PROMPT, temperature: 0.2 },
    },
    // Browser calls only, so full 16 kHz audio rather than telephone quality.
    tts: { agent_output_audio_format: 'pcm_16000' },
    asr: { user_input_audio_format: 'pcm_16000' },
  },
  platform_settings: {
    auth: { enable_auth: true }, // sessions only through signed URLs from our server
    data_collection: {
      claimant_name: {
        type: 'string',
        description: 'The full name the person gave, exactly as they said it. Empty if they did not give one.',
      },
      claimant_reached: {
        type: 'boolean',
        description: 'True if the person confirmed they submitted the claim and discussed it. False if it was someone else or nobody engaged.',
      },
      will_send_documents: {
        type: 'boolean',
        description: 'True if the claimant agreed to send everything that is missing. False if they refused or said they cannot. Leave empty if not discussed.',
      },
      documents_expected_by: {
        type: 'string',
        description: "When the claimant said they will send it, in their own words (for example 'Friday' or 'by 12 November'). Empty if not stated.",
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
