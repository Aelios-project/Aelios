// Self-contained Three.js memory star map page served at /admin/starmap.
// Kept out of src/api/admin/ui.ts so the main admin bundle stays untouched when starmap is not opened.
import { STARMAP_INTERACTION_SCRIPT } from "./starmap/interaction";
import { STARMAP_BODY, STARMAP_HEAD, STARMAP_TAIL } from "./starmap/markup";
import { STARMAP_PARTICLES_SCRIPT } from "./starmap/particles";
import { STARMAP_RIVERS_SCRIPT } from "./starmap/rivers";
import { STARMAP_STARS_SCRIPT } from "./starmap/stars";
import { STARMAP_STYLES } from "./starmap/styles";

export const STARMAP_HTML = [
  STARMAP_HEAD,
  STARMAP_STYLES,
  STARMAP_BODY,
  STARMAP_RIVERS_SCRIPT,
  STARMAP_PARTICLES_SCRIPT,
  STARMAP_STARS_SCRIPT,
  STARMAP_INTERACTION_SCRIPT,
  STARMAP_TAIL
].join("\n");
