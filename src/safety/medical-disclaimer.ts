// src/safety/medical-disclaimer.ts
//
// Medical-safety rule: the health-companion disclaimer is a single constant in
// code. It is appended to every health-facing response by both the medical
// tools (medgemma_query / medgemma_analyze_report) and the agent loop, so a
// wording change happens in exactly one place. The sentinel is a stable
// substring of the disclaimer used to detect an already-appended disclaimer
// (and near-matches the LLM may emit) without re-appending.

export const MEDICAL_DISCLAIMER =
  '\n\n---\n*I am an AI health companion, not a doctor. Always consult a healthcare professional for medical advice.*';

export const MEDICAL_DISCLAIMER_SENTINEL = 'I am an AI health companion, not a doctor';