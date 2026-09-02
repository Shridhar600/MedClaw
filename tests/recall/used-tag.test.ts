import { parseUsedTag } from '../../src/recall';

// P2 Wave B / Task B3.1 — the B7 usage-feedback tag (specs/13 B7, v2-H-3).
// A single trailing line `<used>id1,id2</used>` is parsed and stripped BEFORE the response is
// disclaimer-appended / persisted / sent. Missing or garbled ⇒ no signal, never an error.

describe('parseUsedTag', () => {
  it('parses a trailing <used> line and strips it from the delivered text', () => {
    const { ids, stripped } = parseUsedTag('Here is my answer about your knee.\n<used>c1,c2</used>');
    expect(ids).toEqual(['c1', 'c2']);
    expect(stripped).toBe('Here is my answer about your knee.');
  });

  it('returns no ids and leaves text unchanged when there is no tag', () => {
    const { ids, stripped } = parseUsedTag('Just a normal reply.');
    expect(ids).toEqual([]);
    expect(stripped).toBe('Just a normal reply.');
  });

  it('treats a garbled/unclosed tag as no signal (never throws)', () => {
    const { ids, stripped } = parseUsedTag('Reply text.\n<used>broken');
    expect(ids).toEqual([]);
    expect(stripped).toBe('Reply text.\n<used>broken');
  });

  it('handles an empty tag as no ids but still strips it', () => {
    const { ids, stripped } = parseUsedTag('Reply.\n<used></used>');
    expect(ids).toEqual([]);
    expect(stripped).toBe('Reply.');
  });

  it('never leaks the tag into the stripped (deliverable) text', () => {
    const { stripped } = parseUsedTag('Answer.\n<used>a,b,c</used>');
    expect(stripped).not.toContain('<used>');
    expect(stripped).not.toContain('</used>');
  });

  it('trims whitespace and drops empty ids', () => {
    const { ids } = parseUsedTag('x\n<used> a , , b </used>');
    expect(ids).toEqual(['a', 'b']);
  });

  it('strips an inline (non-trailing) tag so it never leaks to the user (F14)', () => {
    const { ids, stripped } = parseUsedTag('I used <used>c1</used> that note, here is more.');
    expect(ids).toEqual(['c1']);
    expect(stripped).not.toContain('<used>');
    expect(stripped).toContain('here is more');
  });

  it('collects ids from multiple tags and strips them all (F14)', () => {
    const { ids, stripped } = parseUsedTag('answer <used>a</used> body <used>b,c</used>');
    expect(ids).toEqual(['a', 'b', 'c']);
    expect(stripped).not.toContain('<used>');
    expect(stripped).not.toContain('</used>');
  });

  it('deduplicates ids before usage accounting', () => {
    const { ids } = parseUsedTag('Answer.\n<used>c1,c1,c2,c1</used>');
    expect(ids).toEqual(['c1', 'c2']);
  });
});
