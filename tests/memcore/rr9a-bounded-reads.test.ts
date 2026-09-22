import { sweep } from '../../src/memcore/transcript-sweep';

function userLine(content: string): string {
  return JSON.stringify({
    timestamp: '2026-08-29T10:00:00.000Z',
    role: 'user',
    content,
    chatId: 'chat-1',
  });
}

describe('RR-9a LOW boundary clamps', () => {
  it('never returns more than the five-item nightly sweep limit', () => {
    const symptoms = ['headache', 'nausea', 'dizziness', 'fatigue', 'cough', 'fever', 'rash'];
    const lines = symptoms.map(userLine);

    const result = sweep({
      dayFileLines: lines,
      ledgerEntitiesForDay: new Set(),
      existingCuriosity: [],
      lexicon: { med: [], symptom: symptoms, appointment: [] },
      maxItems: 999,
    });

    expect(result.items).toHaveLength(5);
  });
});
