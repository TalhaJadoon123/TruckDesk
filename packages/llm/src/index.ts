/**
 * @truckdesk/llm - Groq-backed broker email parsing.
 *
 * The whole package works with no API key: the client returns an offline canned
 * response and the parser falls back to deterministic extraction, so `npm run
 * dev` and CI behave identically whether or not `GROQ_API_KEY` is set.
 */

export * from './groq.js';
export * from './prompts.js';
export * from './broker-email.js';

export const LLM_VERSION = '1.0.0';