/** Builds the privileged media:// URL the main process will serve from inside the workspace root. */
export const mediaUrl = (absolutePath: string): string =>
  `clipwright-media://media?p=${encodeURIComponent(absolutePath)}`;
