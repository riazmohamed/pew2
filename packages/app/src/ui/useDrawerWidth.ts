import { useWindowDimensions } from "react-native";
import { drawerWidth } from "./drawerWidth";

/**
 * The drawer's width on the screen as it is held right now.
 *
 * `useWindowDimensions` rather than `Dimensions.get`: the latter answers with
 * whatever the window was when it was called, and the app follows the device's
 * rotation — so the reading has to re-render the two places that share it (the
 * panel's own width and the distance the pane is pushed) or they disagree the
 * moment the phone is turned, and the drawer opens to a gap or over its own edge.
 */
export function useDrawerWidth(): number {
  return drawerWidth(useWindowDimensions().width);
}
