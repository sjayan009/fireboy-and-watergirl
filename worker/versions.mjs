import { ENGINE_VERSION } from "../engine/dist/version.js";
// Add archived engine modules here BEFORE retiring a worker image. Never remap an ID.
export const versions = new Map([[ENGINE_VERSION, new URL("../engine/dist/verified.js", import.meta.url).href]]);
