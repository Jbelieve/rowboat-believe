// believe: authority resolver for Company Brain conflicts (module 4 of
// BELIEVE-FORK.md). Pure function — the central brain ALWAYS wins when both
// sides have the same external_id; local only wins when the central has no
// row for that external_id.

export type LocalArtifactRef = {
    externalId: string;
    contentHash: string;
    /** ISO mtime of the local artifact. */
    mtime: string;
};

export type CentralEpisodeRef = {
    externalId: string;
    /** Server-side version marker (created_at or explicit version). */
    version: string;
};

export type AuthorityDecision = 'central' | 'local' | 'noop';

/**
 * Decide which side owns an external_id:
 * - only local exists  → 'local'  (push it up)
 * - only central exists → 'central' (pull it down)
 * - both exist          → 'central' (central always wins on conflict)
 * - neither exists      → 'noop'
 */
export function resolve(
    local: LocalArtifactRef | null,
    central: CentralEpisodeRef | null,
): AuthorityDecision {
    if (central) return 'central';
    if (local) return 'local';
    return 'noop';
}
