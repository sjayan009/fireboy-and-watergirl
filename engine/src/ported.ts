/**
 * The ported game's objects, by name.
 *
 * `game/game.ts`, `flash/` and `box2d/` are a machine translation of decompiled
 * ActionScript: the display list, the levels, Box2D worlds and bodies, the save
 * bag. None of it has types and none is coming -- typing it would mean writing
 * declarations by hand for code nobody wrote by hand.
 *
 * Handwritten code reaches into the port through this one alias, so that
 * `no-explicit-any` keeps meaning something everywhere else: a bare `any`
 * outside this file is a new hole, not the port.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the one place the untyped port is named
export type Ported = any;
