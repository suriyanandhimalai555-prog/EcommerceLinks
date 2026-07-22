/**
 * Max levels below the root the binary tree renders in one view (root = level 0).
 * Must stay in sync with the backend cap (`CFG.MAX_TREE_DEPTH` in config.ts):
 * the drill-down request setter and the zoom-out auto-loader both clamp to this.
 * Going deeper than this in one view is done via click-to-drill (re-root a node).
 */
export const MAX_TREE_DEPTH = 12
