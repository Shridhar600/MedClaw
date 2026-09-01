import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LedgerStore,
  SafetyView,
  TokenRejectedError,
  TYPE_TO_FILE,
  renderLedgerFile,
  type LedgerFact,
  type Provenance,
} from '../../src/memcore';
import { fact } from '../helpers/memcore-fixtures';

const doctor: Provenance = {
  source: 'doctor', confidence: 0.95, anchor: 'memory/visit.md#L1', capturedAt: '2026-08-31T00:00:00.000Z',
};
const user: Provenance = {
  source: 'user', confidence: 0.9, anchor: 'memory/chat.md#L1', capturedAt: '2026-08-31T00:00:00.000Z',
};

describe('RR-1 ledger confirmation and safety integrity', () => {
  let root: string;
  let store: LedgerStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'redacted-rr1-ledger-'));
    store = new LedgerStore(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps safety metadata and doctor provenance on a lower-authority metadata-only merge', async () => {
    await store.recordFact({
      entity: 'long-qt', type: 'condition', fields: { diagnosis: 'confirmed' }, provenance: doctor,
      safetyRelevant: true, episodeId: 'cardiac-1', language: 'hi', verbatim: 'doctor quote', visibility: 'shareable-summary',
    });

    const result = await store.recordFact({
      entity: 'long-qt', type: 'condition', fields: { note: 'reviewed today' }, provenance: user,
    });

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') return;
    expect(result.fact.provenance.source).toBe('doctor');
    expect(result.fact.safetyRelevant).toBe(true);
    expect(result.fact).toEqual(expect.objectContaining({
      episodeId: 'cardiac-1', language: 'hi', verbatim: 'doctor quote', visibility: 'shareable-summary',
    }));
    expect((await store.listSafetyRelevant()).map((f) => f.id)).toContain(result.fact.id);
  });

  it('rejects confirmation in the same bound turn with the typed PHI-safe reason', async () => {
    await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '5mg' }, provenance: user });
    const pending = await store.recordFact({ entity: 'warfarin', type: 'medication', fields: { dose: '10mg' }, provenance: user });
    expect(pending.kind).toBe('needs-confirmation');
    const tokenId = (pending as { token: { uuid: string } }).token.uuid;
    store.bindTokenContext(tokenId, { chatId: 'chat-1', turnId: 'turn-1' });

    await expect(store.confirm(tokenId, undefined, { chatId: 'chat-1', turnId: 'turn-1' }))
      .rejects.toMatchObject({ reason: 'same-turn-confirm' });
  });

  it('rejects a discontinue token after the active target moves', async () => {
    await store.recordFact({ entity: 'lisinopril', type: 'medication', fields: { dose: '10mg' }, provenance: user });
    const pending = await store.discontinue('lisinopril', 'medication', user);
    expect(pending.kind).toBe('needs-confirmation');
    await store.recordFact({ entity: 'lisinopril', type: 'medication', fields: { frequency: 'daily' }, provenance: user });

    await expect(store.confirm((pending as { token: { uuid: string } }).token.uuid))
      .rejects.toEqual(new TokenRejectedError('state-moved-since-proposal'));
    expect((await store.getActive('lisinopril', 'medication'))!.fields.frequency).toBe('daily');
  });

  it('rejects a retract token after the active target moves', async () => {
    await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: { reaction: 'rash' }, provenance: user });
    const pending = await store.retract({ entity: 'penicillin', type: 'allergy', provenance: user });
    expect(pending.kind).toBe('needs-confirmation');
    await store.recordFact({ entity: 'penicillin', type: 'allergy', fields: { notedBy: 'clinic' }, provenance: user });

    await expect(store.confirm((pending as { token: { uuid: string } }).token.uuid))
      .rejects.toEqual(new TokenRejectedError('state-moved-since-proposal'));
  });

  it('rejects a restart token after a newer restart and discontinue cycle changes the target', async () => {
    await store.recordFact({ entity: 'metformin', type: 'medication', fields: { dose: '500mg' }, provenance: user });
    const stop1 = await store.discontinue('metformin', 'medication', user);
    await store.confirm((stop1 as { token: { uuid: string } }).token.uuid);
    const staleRestart = await store.restart('metformin', 'medication', user, { dose: '500mg' });
    const freshRestart = await store.restart('metformin', 'medication', user, { dose: '850mg' });
    await store.confirm((freshRestart as { token: { uuid: string } }).token.uuid);
    const stop2 = await store.discontinue('metformin', 'medication', user);
    await store.confirm((stop2 as { token: { uuid: string } }).token.uuid);

    await expect(store.confirm((staleRestart as { token: { uuid: string } }).token.uuid))
      .rejects.toEqual(new TokenRejectedError('state-moved-since-proposal'));
  });

  it('rejects a dispute winner that was not one of the offered versions', async () => {
    await store.recordFact({ entity: 'migraine', type: 'condition', fields: { severity: 'mild' }, provenance: user });
    const disputed = await store.recordFact({ entity: 'migraine', type: 'condition', fields: { severity: 'severe' }, provenance: user });
    expect(disputed.kind).toBe('disputed');

    await expect(store.confirm((disputed as { disputeToken: { uuid: string } }).disputeToken.uuid, { winningVersion: 1 }))
      .rejects.toBeInstanceOf(TokenRejectedError);
    const chain = await store.getChain('migraine', 'condition');
    expect(chain.filter((f) => f.status === 'active')).toHaveLength(0);
    expect(chain.filter((f) => f.status === 'disputed')).toHaveLength(3);
  });

  it('renders both dual-active values as a conflict and makes getActive fail closed', async () => {
    const competing: LedgerFact[] = [
      fact('metformin', 'medication', { version: 1, fields: { dose: '500mg' }, safetyRelevant: true }),
      fact('metformin', 'medication', { version: 2, fields: { dose: '850mg' }, safetyRelevant: true }),
    ];
    const view = new SafetyView(root);
    const rendered = await view.render(competing);
    expect(rendered).toContain('CONFLICT');
    expect(rendered).toContain('500mg');
    expect(rendered).toContain('850mg');

    fs.mkdirSync(path.join(root, 'ledger'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ledger', TYPE_TO_FILE.medication), renderLedgerFile(competing));
    await expect(store.getActive('metformin', 'medication')).rejects.toThrow('multiple-active-versions');
  });
});
