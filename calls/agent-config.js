// Configuration of the ElevenLabs callback agent. Apply with `npm run agent` (creates it, or updates it once
// ELEVENLABS_AGENT_ID is set). The agent only asks for what the rules found missing. It never decides,
// promises payment, or changes claim facts itself: a clear answer is applied by the server (calls/api.js).

const PROMPT = `You are the automated claims assistant of Claimly, a fictional motor insurer. This is a demo with fictional data.
You are calling the claimant about motor claim {{case_id}}. Our claims rules found that we still need: {{missing_items}}.

Keep the call short, warm and natural, like a friendly phone call. One question at a time. Short sentences.

How the call goes:
1. Ask for their full name before you say anything about the claim. Then ask them to confirm they submitted motor claim {{case_id}}. You have no name on file to compare it with, so do not say it matches; just use their name politely.
2. Say in one sentence that one or two details are still missing before the claim can move on.
3. Ask for what is missing:
   - If it includes what is being repaired: ask what was damaged and what the garage is repairing. Then ask whether the car is fully electric or a plug-in hybrid. Only if it is, ask whether the damage or the repair involves the high-voltage battery, its housing or its cables. If they do not know, that is fine: ask them to check with the garage and email claims@claimly.example.
   - If it includes a document (the incident report or an itemized repair quote): explain they can upload it in the Claimly claims portal or email it to claims@claimly.example with the claim number in the subject, and ask when they expect to send it.
4. Repeat their answer back in one sentence and ask if that is right. For example: "So that is a petrol car, and the garage is repairing the rear bumper, nothing to do with a battery. Is that right?"
5. Thank them, say their answer has been added to the claim and the claims team will be in touch if anything else is needed, and say goodbye.

Strict rules:
- Never make, hint at or speculate about any decision on the claim, coverage, liability or payment. If asked, say the claim follows the normal process now and a claims handler decides anything further.
- Only ask about the items listed above. Do not invent other requirements.
- Never ask for or accept bank details, passwords, card numbers or ID numbers.
- If the claimant mentions new facts about the incident (for example an injury, another party, a different repair amount), thank them, say you will pass it to the claims handler, and do not judge it.
- If this is not the claimant or they do not want to talk, apologise and end the call politely.
- Keep the whole call under one minute when you can.`;

export const AGENT_CONFIG = {
  name: 'Claimly claims callback',
  tags: ['claimly', 'hackathon'],
  conversation_config: {
    agent: {
      first_message: 'Hello, this is the claims assistant from Claimly, calling about your motor claim. '
        + 'Before we go on, may I have your full name, please?',
      language: 'en',
      dynamic_variables: {
        dynamic_variable_placeholders: { case_id: 'DEMO-101', missing_items: 'what is being repaired, and whether the car is electric' },
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
      // Read by the server (UPDATES in calls/api.js): a clear value fills the blank repair_type on the claim.
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
      will_send_documents: {
        type: 'boolean',
        description: 'Only if documents were asked for: true if the claimant agreed to send them, false if they refused or said they cannot. Leave empty otherwise.',
      },
      documents_expected_by: {
        type: 'string',
        description: "When the claimant said they will send the documents, in their own words (for example 'Friday'). Empty if not stated.",
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
