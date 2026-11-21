export const MIN_COMMENT_LENGTH = 1;
export const MAX_COMMENT_LENGTH = 5000;

/** The element id of a comment in the lesson thread, e.g. `comment-42`. */
export function commentAnchor(commentId: number): string {
  return `comment-${commentId}`;
}

/** The comment id a URL hash (e.g. `#comment-42`) points at, or null. */
export function commentIdFromHash(hash: string): number | null {
  const match = /^#comment-(\d+)$/.exec(hash);
  return match ? Number(match[1]) : null;
}
