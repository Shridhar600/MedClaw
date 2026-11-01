// The disclaimer is a single constant so a wording change happens in one place. The sentinel is a
// stable substring used to detect an already-appended disclaimer, including near-matches the LLM may emit.

export const MEDICAL_DISCLAIMER =
  '\n\n---\n*I am an AI health companion, not a doctor. Always consult a healthcare professional for medical advice.*';

export const MEDICAL_DISCLAIMER_SENTINEL = 'I am an AI health companion, not a doctor';