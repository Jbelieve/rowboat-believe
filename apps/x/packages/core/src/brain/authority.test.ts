// believe: table-driven tests for the authority resolver (BELIEVE-FORK.md
// module 4): central always wins on conflict.
import { describe, expect, it } from 'vitest';
import { resolve } from './authority.js';
import type { AuthorityDecision, CentralEpisodeRef, LocalArtifactRef } from './authority.js';

const local: LocalArtifactRef = {
    externalId: 'desktop:notes/idea.md',
    contentHash: 'abc123',
    mtime: '2026-07-01T10:00:00.000Z',
};
const central: CentralEpisodeRef = {
    externalId: 'desktop:notes/idea.md',
    version: '2026-07-02T09:00:00.000Z',
};

describe('AuthorityResolver.resolve', () => {
    const cases: [string, LocalArtifactRef | null, CentralEpisodeRef | null, AuthorityDecision][] = [
        ['local new, no central row → local wins (push up)', local, null, 'local'],
        ['central new, no local artifact → central wins (pull down)', null, central, 'central'],
        ['both exist (conflict) → central always wins', local, central, 'central'],
        ['neither exists → noop', null, null, 'noop'],
    ];

    it.each(cases)('%s', (_name, l, c, expected) => {
        expect(resolve(l, c)).toBe(expected);
    });

    it('central wins even when the local artifact is newer', () => {
        const newerLocal: LocalArtifactRef = { ...local, mtime: '2026-07-05T23:59:59.000Z' };
        expect(resolve(newerLocal, central)).toBe('central');
    });
});
