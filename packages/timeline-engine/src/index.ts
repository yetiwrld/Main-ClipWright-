// @clipwright/timeline-engine — pure timeline model, commands and queries.
// No React, no DOM, no Electron (SPEC 09 §2).

export const TIMELINE_ENGINE_VERSION = '1.0.0';

export {
  US_PER_SECOND,
  frameToUs,
  usToFrame,
  frameDurationUs,
  quantizeUs,
  quantizeDurationUs,
  clampUs,
  formatTimecode,
  parseTimecode,
  type Fps,
} from './time';

export {
  sortedItemsOfTrack,
  itemEndUs,
  projectDurationUs,
  contentDurationUs,
  mainTrack,
  tracksInDrawOrder,
  itemsAt,
  editPointsUs,
  snapPoints,
  snapUs,
  visibleFrameRange,
  minItemDurationUs,
  type TimelineState,
  type SnapResult,
} from './selectors';

export {
  addItem,
  moveItems,
  trimItem,
  trimItems,
  moveItemsToTrack,
  splitItems,
  deleteItems,
  duplicateItems,
  pasteItems,
  groupItems,
  ungroupItems,
  addMarker,
  setTrackMuted,
  setTrackMagnetic,
  rollAt,
  detachAudio,
  unlink,
  toggleItemDisabled,
  addTrack,
  toggleTrackLock,
  toggleTrackHidden,
  deleteTrack,
  addTransition,
  updateTransition,
  removeTransition,
  setWorkArea,
  clearWorkArea,
  type CommandOk,
  type CommandError,
  type CommandResult,
  type EditMode,
  type MoveTarget,
  type TrimParams,
} from './commands';

export { TimelineHistory, type HistoryStep, type UndoResult } from './history';
export { checkInvariants } from './invariants';
export { createDefaultTimeline, createMediaItem } from './factory';
