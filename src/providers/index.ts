// Public surface of the provider adapter layer; everything else is private.
//
// This barrel exists for one consumer: setup needs the OpenRouter endpoint constant, because OpenRouter has no
// SDK-default endpoint and setup must write the router URL for the role it selected. Importing `openai.ts`
// directly from the CLI would pull a private adapter module, and its `openai` package import, across a public
// boundary.
//
// Deliberately minimal: no factory re-export, no adapter classes, no protocol change. A wider surface is added
// only when a real caller needs it.
export { OPENROUTER_DEFAULT_BASE_URL } from './openai';