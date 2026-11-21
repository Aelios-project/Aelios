// Admin UI assembled from modular template and script slices under ./ui/.
import { ADMIN_SCRIPT_DREAM } from "./ui/scripts/dream";
import { ADMIN_SCRIPT_MEMORIES } from "./ui/scripts/memories";
import { ADMIN_SCRIPT_SETTINGS } from "./ui/scripts/settings";
import { ADMIN_SCRIPT_STATE } from "./ui/scripts/state";
import { ADMIN_SCRIPT_TRANSFER } from "./ui/scripts/transfer";
import { ADMIN_BODY_START, ADMIN_HEAD, ADMIN_OVERLAYS } from "./ui/shell";
import { ADMIN_STYLES } from "./ui/styles";
import { ADMIN_TAB_DIARY } from "./ui/tabs/diary";
import { ADMIN_TAB_DREAM } from "./ui/tabs/dream";
import { ADMIN_TAB_HOME } from "./ui/tabs/home";
import { ADMIN_TAB_MEMORIES } from "./ui/tabs/memories";
import { ADMIN_TAB_REVIEW } from "./ui/tabs/review";
import { ADMIN_TAB_SETTINGS } from "./ui/tabs/settings";
import { ADMIN_TAB_TRANSFER } from "./ui/tabs/transfer";

export const ADMIN_HTML = [
  ADMIN_HEAD,
  ADMIN_STYLES,
  ADMIN_BODY_START,
  ADMIN_TAB_HOME,
  ADMIN_TAB_REVIEW,
  ADMIN_TAB_DIARY,
  ADMIN_TAB_MEMORIES,
  ADMIN_TAB_DREAM,
  ADMIN_TAB_TRANSFER,
  ADMIN_TAB_SETTINGS,
  ADMIN_OVERLAYS,
  ADMIN_SCRIPT_STATE,
  ADMIN_SCRIPT_SETTINGS,
  ADMIN_SCRIPT_MEMORIES,
  ADMIN_SCRIPT_DREAM,
  ADMIN_SCRIPT_TRANSFER
].join("\n");
